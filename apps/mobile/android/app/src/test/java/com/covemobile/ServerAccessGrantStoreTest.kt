package com.covemobile

import org.junit.Assert.*
import org.junit.Test
import javax.crypto.spec.SecretKeySpec

class ServerAccessGrantStoreTest {
  private class Memory : AccountPasswordStorage {
    var bytes: ByteArray? = null
    override fun read(): ByteArray? = bytes?.clone()
    override fun write(bytes: ByteArray) { this.bytes = bytes.clone() }
  }
  private val server = "https://synthetic.example.test:8443/cove"
  private val email = "alice@example.test"
  private fun store(memory: Memory): AccountPasswordStore {
    val key = SecretKeySpec(ByteArray(32) { 17 }, "AES")
    return AccountPasswordStore(memory, AccountPasswordCipher({ key }, { key }))
  }
  private fun grant() = "{\"accessToken\":\"" + "synthetic-token-".repeat(40) +
    "\",\"verifiedAt\":1800000000000,\"lastObservedAt\":1800000000000,\"expiresAt\":1801209600000}"

  @Test fun grantJsonLongerThanAccountPasswordRoundTripsWithoutPlaintextOnDisk() {
    val memory = Memory()
    val value = grant()
    assertTrue(value.length > 512)
    store(memory).save(server, email, value)
    assertEquals(value, store(memory).get(server, email))
    val raw = String(memory.bytes!!, Charsets.UTF_8)
    assertFalse(raw.contains("synthetic-token"))
    assertFalse(raw.contains("accessToken"))
    assertFalse(raw.contains(email))
    assertFalse(raw.contains(server))
  }
  @Test fun grantScopeIncludesExactServerPathPortAndAccount() {
    val memory = Memory()
    val store = store(memory)
    store.save(server, email, grant())
    assertNull(store.get(server, "bob@example.test"))
    assertNull(store.get("https://synthetic.example.test/cove", email))
    assertNull(store.get("https://synthetic.example.test:8443/other", email))
    assertEquals(grant(), store.get(server, " Alice@Example.Test "))
  }
  @Test fun grantRemovalLeavesOtherAccountAndAccountPasswordStoreUntouched() {
    val grants = store(Memory())
    val passwords = store(Memory())
    grants.save(server, email, grant())
    grants.save(server, "bob@example.test", grant())
    passwords.save(server, email, "fictional-account-password")
    grants.remove(server, email)
    assertNull(grants.get(server, email))
    assertEquals(grant(), grants.get(server, "bob@example.test"))
    assertEquals("fictional-account-password", passwords.get(server, email))
  }
}
