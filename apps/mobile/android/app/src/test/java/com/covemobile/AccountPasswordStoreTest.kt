package com.covemobile

import java.io.IOException
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.*
import org.junit.Test

class AccountPasswordStoreTest {
  private class MemoryStorage : AccountPasswordStorage {
    var bytes: ByteArray? = null
    var failWrites = false
    override fun read(): ByteArray? = bytes?.clone()
    override fun write(bytes: ByteArray) {
      if (failWrites) throw IOException("Synthetic commit failure")
      this.bytes = bytes.clone()
    }
  }

  private class RecordingCrypto(private val delegate: AccountPasswordCrypto) : AccountPasswordCrypto {
    val decryptedScopes = mutableListOf<String>()
    override fun encrypt(scope: String, value: String) = delegate.encrypt(scope, value)
    override fun decrypt(scope: String, value: EncryptedAccountPassword): String {
      decryptedScopes.add(scope)
      return delegate.decrypt(scope, value)
    }
  }

  private val server = "https://memory.example.test:8443/cove"
  private val email = "alice@example.test"
  private val password = "fictional-account-password"
  private val key = SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES")
  private val storage = MemoryStorage()
  private val cipher = AccountPasswordCipher({ key })
  private val store = AccountPasswordStore(storage, cipher)

  @Test fun savedPasswordsAreIsolatedByCompleteServerUrlAndEmail() {
    store.save(server, " ALICE@EXAMPLE.TEST ", password)
    assertEquals(password, store.get(" HTTPS://MEMORY.EXAMPLE.TEST:8443/cove/ ", email))
    assertNull(store.get(server, "bob@example.test"))
    assertNull(store.get("http://memory.example.test:8443/cove", email))
    assertNull(store.get("https://memory.example.test:8444/cove", email))
    assertNull(store.get("https://memory.example.test:8443/other", email))
    store.save(server, "bob@example.test", "synthetic-bob-password")
    assertEquals("synthetic-bob-password", store.get(server, "bob@example.test"))
    assertEquals(password, store.get(server, email))
  }

  @Test fun similarLookingEncodedAndRepeatedSlashPathsDoNotSharePasswords() {
    store.save("$server/a//b", email, password)
    store.save("$server/a%2Fb", email, "synthetic-encoded-password")
    assertNull(store.get("$server/a/b", email))
    assertEquals(password, store.get("$server/a//b", email))
    assertEquals("synthetic-encoded-password", store.get("$server/a%2Fb", email))
  }

  @Test fun listReturnsOnlyNormalizedMetadataWithoutDecryptingPasswords() {
    val recording = RecordingCrypto(cipher)
    val recordedStore = AccountPasswordStore(storage, recording)
    recordedStore.save(server, email, password)
    recordedStore.save(server, " BOB@EXAMPLE.TEST ", "synthetic-bob-password")
    recording.decryptedScopes.clear()
    assertEquals(listOf(AccountPasswordIdentity(server, email), AccountPasswordIdentity(server, "bob@example.test")), recordedStore.list())
    assertEquals(2, recording.decryptedScopes.size)
    assertTrue(recording.decryptedScopes.all { it.endsWith(":metadata") })
  }

  @Test fun persistentBytesContainNeitherPasswordsNorAccountMetadata() {
    store.save(server, email, password)
    val serialized = String(storage.bytes!!, Charsets.ISO_8859_1)
    assertFalse(serialized.contains(password))
    assertFalse(serialized.contains(email))
    assertFalse(serialized.contains(server))
  }

  @Test fun failedSavePreservesPreviousCommittedPassword() {
    store.save(server, email, password)
    val original = storage.bytes!!.clone()
    storage.failWrites = true
    assertThrows(IOException::class.java) { store.save(server, email, "synthetic-replacement") }
    assertArrayEquals(original, storage.bytes)
    assertEquals(password, store.get(server, email))
  }

  @Test fun failedRemoveAndClearPreserveTheCommittedSnapshot() {
    store.save(server, email, password)
    val original = storage.bytes!!.clone()
    storage.failWrites = true
    assertThrows(IOException::class.java) { store.remove(server, email) }
    assertThrows(IOException::class.java) { store.clear() }
    assertArrayEquals(original, storage.bytes)
    assertEquals(password, store.get(server, email))
  }

  @Test fun missingKeyFailsClosedAndExplicitSaveRecoversOrphanedRecords() {
    var currentKey: SecretKey? = key
    val recoveryCipher = AccountPasswordCipher(
      { currentKey ?: SecretKeySpec(ByteArray(32) { (it + 2).toByte() }, "AES").also { currentKey = it } },
      { currentKey ?: throw AccountPasswordKeyLostException() },
    )
    val recoveryStore = AccountPasswordStore(storage, recoveryCipher)
    recoveryStore.save(server, email, password)
    val original = storage.bytes!!.clone()
    currentKey = null
    assertThrows(AccountPasswordKeyLostException::class.java) { recoveryStore.get(server, email) }
    assertThrows(AccountPasswordKeyLostException::class.java) { recoveryStore.list() }
    assertNull(currentKey)
    assertArrayEquals(original, storage.bytes)
    recoveryStore.save(server, "bob@example.test", "synthetic-new-key-password")
    assertEquals(listOf(AccountPasswordIdentity(server, "bob@example.test")), recoveryStore.list())
    assertNull(recoveryStore.get(server, email))
    assertEquals("synthetic-new-key-password", recoveryStore.get(server, "bob@example.test"))
  }

  @Test fun tamperedPasswordEnvelopeIsNeverReturned() {
    store.save(server, email, password)
    storage.bytes!![storage.bytes!!.lastIndex] = (storage.bytes!!.last().toInt() xor 1).toByte()
    assertThrows(Exception::class.java) { store.get(server, email) }
    assertEquals(listOf(AccountPasswordIdentity(server, email)), store.list())
    store.save(server, email, "synthetic-recovered-password")
    assertEquals("synthetic-recovered-password", store.get(server, email))
  }

  @Test fun clearRecoversAnUnreadableStoreWithoutAKey() {
    storage.bytes = byteArrayOf(1, 2, 3)
    assertThrows(Exception::class.java) { store.get(server, email) }
    val missingKey = AccountPasswordCipher({ throw AccountPasswordKeyLostException() })
    val recoveryStore = AccountPasswordStore(storage, missingKey)
    recoveryStore.clear()
    assertTrue(recoveryStore.list().isEmpty())
    assertNull(recoveryStore.get(server, email))
  }

  @Test fun overlappingStoreInstancesDoNotLoseConcurrentSaves() {
    val second = AccountPasswordStore(storage, cipher)
    val executor = Executors.newFixedThreadPool(4)
    try {
      val futures = (0 until 16).map { index -> executor.submit(Callable {
        val target = if (index % 2 == 0) store else second
        target.save(server, "account$index@example.test", "synthetic-password-$index")
      }) }
      futures.forEach { it.get() }
      assertEquals(16, store.list().size)
      for (index in 0 until 16) {
        assertEquals("synthetic-password-$index", store.get(server, "account$index@example.test"))
      }
    } finally { executor.shutdownNow() }
  }

  @Test fun removalAndClearWorkWithoutDecryptingOrRecreatingKeys() {
    store.save(server, email, password)
    store.save(server, "bob@example.test", "synthetic-bob-password")
    val missing = AccountPasswordStore(storage, AccountPasswordCipher({ throw AccountPasswordKeyLostException() }))
    missing.remove(server, email)
    assertNull(missing.get(server, email))
    assertThrows(AccountPasswordKeyLostException::class.java) { missing.get(server, "bob@example.test") }
    missing.clear()
    assertTrue(missing.list().isEmpty())
  }
}
