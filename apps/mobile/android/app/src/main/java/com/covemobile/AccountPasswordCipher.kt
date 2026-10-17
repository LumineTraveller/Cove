package com.covemobile

import java.net.URI
import java.security.GeneralSecurityException
import java.security.MessageDigest
import java.util.Locale
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class AccountPasswordIdentity(val serverURL: String, val email: String) {
  val scope: String = MessageDigest.getInstance("SHA-256")
    .digest("$serverURL\n$email".toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it.toInt() and 255) }
}

/** Keep the scheme, non-default port and complete path, matching the JS URL normalizer. */
internal fun accountPasswordIdentity(server: String, email: String): AccountPasswordIdentity? = try {
  // JS resolves dot segments. Do not call URI.normalize() here: it also folds
  // repeated slashes, changing a valid server path that JS preserved.
  val url = URI(URI(server.trim()).toASCIIString())
  val scheme = url.scheme?.lowercase(Locale.ROOT)
  val host = url.host?.lowercase(Locale.ROOT)
  val account = email.trim().lowercase(Locale.ROOT)
  if (server.length > 2048 || scheme !in listOf("http", "https") || host.isNullOrEmpty() ||
    url.rawUserInfo != null || url.rawQuery != null || url.rawFragment != null ||
    url.port !in -1..65535 || url.port == 0 || account.length > 254 ||
    !Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$").matches(account)) null
  else {
    val port = if (url.port == -1 || (scheme == "https" && url.port == 443) ||
      (scheme == "http" && url.port == 80)) "" else ":${url.port}"
    val authority = if (host.contains(':') && !host.startsWith('[')) "[$host]" else host
    val endpoint = "$scheme://$authority$port${(url.rawPath ?: "").trimEnd('/')}"
    if (endpoint.length > 2048) null else AccountPasswordIdentity(endpoint, account)
  }
} catch (_: Exception) { null }

internal fun accountPasswordScope(server: String, email: String): String? =
  accountPasswordIdentity(server, email)?.scope

internal data class EncryptedAccountPassword(val iv: ByteArray, val ciphertext: ByteArray)

internal class AccountPasswordKeyLostException : GeneralSecurityException("Account password key is unavailable")

internal interface AccountPasswordCrypto {
  fun encrypt(scope: String, value: String): EncryptedAccountPassword
  fun decrypt(scope: String, value: EncryptedAccountPassword): String
}

/** AAD binds each ciphertext to its server/account and to its metadata/password purpose. */
internal class AccountPasswordCipher(
  private val encryptionKey: () -> SecretKey,
  private val decryptionKey: () -> SecretKey = encryptionKey,
) : AccountPasswordCrypto {
  override fun encrypt(scope: String, value: String): EncryptedAccountPassword {
    val plaintext = value.toByteArray(Charsets.UTF_8)
    try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
      cipher.updateAAD(scope.toByteArray(Charsets.UTF_8))
      val ciphertext = cipher.doFinal(plaintext)
      check(cipher.iv.size == 12)
      return EncryptedAccountPassword(cipher.iv, ciphertext)
    } finally { plaintext.fill(0) }
  }

  override fun decrypt(scope: String, value: EncryptedAccountPassword): String {
    require(value.iv.size == 12 && value.ciphertext.size in 16..20000)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, decryptionKey(), GCMParameterSpec(128, value.iv))
    cipher.updateAAD(scope.toByteArray(Charsets.UTF_8))
    val plaintext = cipher.doFinal(value.ciphertext)
    return try { String(plaintext, Charsets.UTF_8) } finally { plaintext.fill(0) }
  }
}
