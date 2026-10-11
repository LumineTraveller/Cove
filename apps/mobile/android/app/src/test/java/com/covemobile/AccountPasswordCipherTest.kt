package com.covemobile

import org.junit.Assert.*
import org.junit.Test
import javax.crypto.spec.SecretKeySpec

class AccountPasswordCipherTest {
  private val server = "https://memory.example.test"
  private val email = "alice@example.test"
  private val key = SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES")
  private val cipher = AccountPasswordCipher({ key })
  private val password = "fictional-account-password"

  @Test fun normalizedScopesPreserveSchemePortAndCompletePath() {
    val scope = accountPasswordScope(server, email)
    assertNotNull(scope)
    assertEquals(scope, accountPasswordScope(" HTTPS://MEMORY.EXAMPLE.TEST:443/ ", " ALICE@EXAMPLE.TEST "))
    for (url in listOf("http://memory.example.test", "$server:8443", "$server/path", "https://other.example.test")) {
      assertNotEquals(scope, accountPasswordScope(url, email))
    }
    assertNotEquals(scope, accountPasswordScope(server, "bob@example.test"))
    assertNotEquals(accountPasswordScope("$server/a", email), accountPasswordScope("$server/b", email))
    assertEquals(accountPasswordScope("https://[::1]:443/", email), accountPasswordScope("https://[::1]", email))
    assertEquals("https://memory.example.test:8443/a/b", accountPasswordIdentity("HTTPS://MEMORY.EXAMPLE.TEST:8443/a/b/", email)?.serverURL)
  }

  @Test fun repeatedSlashesAndEncodedPathsRemainDistinct() {
    assertEquals("$server/a//b", accountPasswordIdentity("$server/a//b/", email)?.serverURL)
    assertNotEquals(accountPasswordScope("$server/a//b", email), accountPasswordScope("$server/a/b", email))
    assertEquals("$server/a%2Fb", accountPasswordIdentity("$server/a%2Fb", email)?.serverURL)
    assertNotEquals(accountPasswordScope("$server/a%2Fb", email), accountPasswordScope("$server/a/b", email))
    assertNotEquals(accountPasswordScope("$server/a%2Fb", email), accountPasswordScope("$server/a%2fb", email))
  }

  @Test fun unsafeOrInvalidScopesAreRejected() {
    for (url in listOf("not-a-url", "ftp://memory.example.test", "$server?query=1", "$server#fragment",
      "https://user:synthetic@memory.example.test", "$server:0", "$server:65536")) {
      assertNull(accountPasswordScope(url, email))
    }
    assertNull(accountPasswordScope(server, "invalid-email"))
    assertNull(accountPasswordScope(server, "line\nbreak@example.test"))
  }

  @Test fun roundtripUsesFreshIvAndDoesNotStorePlaintext() {
    val scope = accountPasswordScope(server, email)!!
    val first = cipher.encrypt(scope, password)
    val second = cipher.encrypt(scope, password)
    assertEquals(12, first.iv.size)
    assertFalse(first.iv.contentEquals(second.iv))
    assertFalse(String(first.ciphertext, Charsets.UTF_8).contains(password))
    assertEquals(password, cipher.decrypt(scope, first))
  }

  @Test fun movingCiphertextAcrossAccountServerOrPurposeFailsAuthentication() {
    val scope = accountPasswordScope(server, email)!!
    val value = cipher.encrypt(scope, password)
    for (other in listOf(accountPasswordScope(server, "bob@example.test")!!,
      accountPasswordScope("https://other.example.test", email)!!, "$scope:metadata")) {
      assertThrows(Exception::class.java) { cipher.decrypt(other, value) }
    }
  }

  @Test fun alteredCiphertextAndInvalidIvAreRejected() {
    val scope = accountPasswordScope(server, email)!!
    val value = cipher.encrypt(scope, password)
    val changed = value.ciphertext.clone().apply { this[0] = (this[0].toInt() xor 1).toByte() }
    assertThrows(Exception::class.java) { cipher.decrypt(scope, EncryptedAccountPassword(value.iv, changed)) }
    assertThrows(Exception::class.java) { cipher.decrypt(scope, EncryptedAccountPassword(ByteArray(1), value.ciphertext)) }
  }

  @Test fun readingWithMissingKeyNeverCreatesAReplacementKey() {
    var encryptionCalls = 0
    val value = cipher.encrypt("synthetic-scope", password)
    val missing = AccountPasswordCipher({ encryptionCalls++; key }, { throw AccountPasswordKeyLostException() })
    assertThrows(AccountPasswordKeyLostException::class.java) { missing.decrypt("synthetic-scope", value) }
    assertEquals(0, encryptionCalls)
  }
}
