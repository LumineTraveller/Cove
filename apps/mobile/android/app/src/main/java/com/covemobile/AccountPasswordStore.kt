package com.covemobile

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import javax.crypto.AEADBadTagException

internal const val MAX_ACCOUNT_PASSWORD_STORE_BYTES = 2 * 1024 * 1024

/** Replace snapshots atomically; an unconfirmed commit must throw, never report success. */
internal interface AccountPasswordStorage {
  fun read(): ByteArray?
  fun write(bytes: ByteArray)
}

internal class AccountPasswordStore(
  private val storage: AccountPasswordStorage,
  private val crypto: AccountPasswordCrypto,
) {
  private class Record(
    val metadata: EncryptedAccountPassword,
    val password: EncryptedAccountPassword,
  )

  companion object {
    private const val MAGIC = 0x43565032 // CVP2: only hashes and encrypted envelopes on disk.
    private const val MAX_ACCOUNTS = 64
    // React contexts can overlap during reload. Re-read under one shared lock so
    // an older module instance cannot overwrite another instance's committed data.
    private val lock = Any()
    private fun metadataScope(scope: String) = "$scope:metadata"
  }

  private fun identity(server: String, email: String): AccountPasswordIdentity =
    requireNotNull(accountPasswordIdentity(server, email)) { "Invalid account scope" }

  private fun read(): LinkedHashMap<String, Record> {
    val bytes = storage.read() ?: return linkedMapOf()
    require(bytes.size in 8..MAX_ACCOUNT_PASSWORD_STORE_BYTES) { "Invalid account store" }
    DataInputStream(ByteArrayInputStream(bytes)).use { input ->
      require(input.readInt() == MAGIC) { "Invalid account store format" }
      val count = input.readInt()
      require(count in 0..MAX_ACCOUNTS) { "Invalid account count" }
      val records = linkedMapOf<String, Record>()
      fun envelope(): EncryptedAccountPassword {
        val iv = ByteArray(12).also(input::readFully)
        val size = input.readInt()
        require(size in 16..20000 && size <= input.available()) { "Invalid encrypted account record" }
        return EncryptedAccountPassword(iv, ByteArray(size).also(input::readFully))
      }
      repeat(count) {
        val scope = input.readUTF()
        require(Regex("^[a-f0-9]{64}$").matches(scope) && !records.containsKey(scope)) { "Invalid account scope record" }
        records[scope] = Record(envelope(), envelope())
      }
      require(input.available() == 0) { "Unexpected account store data" }
      return records
    }
  }

  private fun write(records: Map<String, Record>) {
    val bytes = ByteArrayOutputStream()
    DataOutputStream(bytes).use { output ->
      output.writeInt(MAGIC)
      output.writeInt(records.size)
      fun envelope(value: EncryptedAccountPassword) {
        require(value.iv.size == 12 && value.ciphertext.size in 16..20000)
        output.write(value.iv)
        output.writeInt(value.ciphertext.size)
        output.write(value.ciphertext)
      }
      for ((scope, record) in records) {
        output.writeUTF(scope)
        envelope(record.metadata)
        envelope(record.password)
      }
    }
    require(bytes.size() <= MAX_ACCOUNT_PASSWORD_STORE_BYTES) { "Account store is full" }
    storage.write(bytes.toByteArray())
  }

  private fun metadata(scope: String, record: Record): AccountPasswordIdentity {
    val parts = crypto.decrypt(metadataScope(scope), record.metadata).split('\n')
    require(parts.size == 2) { "Invalid account metadata" }
    val identity = identity(parts[0], parts[1])
    require(identity.scope == scope) { "Account metadata scope mismatch" }
    return identity
  }

  fun get(server: String, email: String): String? = synchronized(lock) {
    val account = identity(server, email)
    val record = read()[account.scope] ?: return@synchronized null
    // Verify metadata too; password and metadata cannot be moved across scopes.
    metadata(account.scope, record)
    crypto.decrypt(account.scope, record.password).also { require(it.isNotEmpty() && it.length <= 4096) }
  }

  /** Listing never decrypts a password envelope or returns a password. */
  fun list(): List<AccountPasswordIdentity> = synchronized(lock) {
    read().map { (scope, record) -> metadata(scope, record) }
      .sortedWith(compareBy(AccountPasswordIdentity::serverURL, AccountPasswordIdentity::email))
  }

  fun save(server: String, email: String, password: String) = synchronized(lock) {
    val account = identity(server, email)
    require(password.isNotEmpty() && password.length <= 4096) { "Invalid account password length" }
    val records = read()
    // Missing keys and unauthenticatable metadata are unrecoverable. Only an
    // explicit save replaces those orphaned envelopes. Crypto/preparation errors
    // leave the previous file untouched; an unconfirmed storage commit is surfaced
    // as a failure, since a post-commit read error cannot prove rollback.
    val usable = linkedMapOf<String, Record>()
    for ((scope, record) in records) {
      try { metadata(scope, record); usable[scope] = record }
      catch (_: AccountPasswordKeyLostException) { }
      catch (_: AEADBadTagException) { }
      catch (_: IllegalArgumentException) { }
    }
    require(usable.containsKey(account.scope) || usable.size < MAX_ACCOUNTS) { "Account store is full" }
    val encryptedMetadata = crypto.encrypt(metadataScope(account.scope), "${account.serverURL}\n${account.email}")
    val encryptedPassword = crypto.encrypt(account.scope, password)
    usable[account.scope] = Record(encryptedMetadata, encryptedPassword)
    write(usable)
  }

  fun remove(server: String, email: String) = synchronized(lock) {
    val scope = identity(server, email).scope
    val records = read()
    if (records.remove(scope) != null) write(records)
  }

  // This also recovers an unreadable file, without requiring a working key.
  fun clear() = synchronized(lock) { write(emptyMap()) }
}
