package com.covemobile

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

internal class AndroidAccountPasswordKey(private val alias: String = "cove.account.passwords.v1") {
  companion object {
    private val lock = Any()
  }

  fun key(create: Boolean): SecretKey = synchronized(lock) {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(alias, null) as? SecretKey)?.let { return@synchronized it }
    if (!create) throw AccountPasswordKeyLostException()
    KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .build())
    }.generateKey()
  }
}

internal class AndroidAccountPasswordStorage(
  private val directory: File,
  filename: String = "cove-account-passwords-v2.bin",
) : AccountPasswordStorage {
  private val file = AtomicFile(File(directory, filename))

  override fun read(): ByteArray? = try {
    file.openRead().use { input ->
      val output = ByteArrayOutputStream()
      val buffer = ByteArray(8192)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        check(output.size() + count <= MAX_ACCOUNT_PASSWORD_STORE_BYTES) { "Account store is too large" }
        output.write(buffer, 0, count)
      }
      output.toByteArray()
    }
  } catch (_: FileNotFoundException) { null }

  override fun write(bytes: ByteArray) {
    check(directory.isDirectory || directory.mkdirs()) { "Account store directory is unavailable" }
    val output = file.startWrite()
    try {
      output.write(bytes)
      // AtomicFile.finishWrite logs some sync failures instead of throwing.
      // Sync explicitly while the old snapshot can still be restored.
      output.fd.sync()
      file.finishWrite(output)
    } catch (error: Exception) {
      file.failWrite(output)
      throw error
    }
    check(read()?.contentEquals(bytes) == true) { "Account store commit could not be verified" }
  }
}

/** Secrets live only in encrypted no-backup storage, never AsyncStorage or logs. */
class AccountPasswordsModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val key = AndroidAccountPasswordKey()
  private val store = AccountPasswordStore(
    AndroidAccountPasswordStorage(context.noBackupFilesDir),
    AccountPasswordCipher({ key.key(true) }, { key.key(false) }),
  )
  private val executor = Executors.newSingleThreadExecutor()

  override fun getName() = "CoveAccountPasswords"

  private fun result(available: Boolean, ok: Boolean, remembered: Boolean = false): WritableMap =
    Arguments.createMap().apply {
      putBoolean("available", available)
      putBoolean("ok", ok)
      putBoolean("remembered", remembered)
    }

  // The module exists even when an operation fails. JS must surface a failed
  // forget/write rather than treating it as an unsupported platform no-op.
  private fun failed(): WritableMap = result(true, false).apply {
    putNull("password")
    putArray("accounts", Arguments.createArray())
  }

  private fun run(promise: Promise, action: () -> WritableMap) {
    try {
      executor.execute {
        // Do not propagate exception details/cause: they can contain account inputs.
        promise.resolve(try { action() } catch (_: Exception) { failed() })
      }
    } catch (_: Exception) { promise.resolve(failed()) }
  }

  @ReactMethod fun status(promise: Promise) = run(promise) {
    key.key(true)
    result(true, true)
  }

  @ReactMethod fun get(serverURL: String, email: String, promise: Promise) = run(promise) {
    val password = store.get(serverURL, email)
    result(true, true, password != null).apply {
      if (password == null) putNull("password") else putString("password", password)
    }
  }

  @ReactMethod fun save(serverURL: String, email: String, password: String, promise: Promise) = run(promise) {
    store.save(serverURL, email, password)
    result(true, true, true)
  }

  @ReactMethod fun remove(serverURL: String, email: String, promise: Promise) = run(promise) {
    store.remove(serverURL, email)
    result(true, true)
  }

  @ReactMethod fun clear(promise: Promise) = run(promise) {
    store.clear()
    result(true, true)
  }

  @ReactMethod fun list(promise: Promise) = run(promise) {
    val accounts = Arguments.createArray()
    for (account in store.list()) accounts.pushMap(Arguments.createMap().apply {
      putString("serverURL", account.serverURL)
      putString("email", account.email)
    })
    result(true, true).apply { putArray("accounts", accounts) }
  }

  override fun invalidate() {
    executor.shutdown()
    super.invalidate()
  }
}
