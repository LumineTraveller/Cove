package com.covemobile

import java.net.URI
import java.util.Locale

/** An exception is never inherited by a different host, port, or protocol. */
class ServerCertificatePolicy {
  @Volatile private var endpoint: Pair<String, Int>? = null

  fun configure(url: String, enabled: Boolean) {
    endpoint = if (enabled) parseOrigin(url) else null
    require(!enabled || endpoint != null) { "证书例外需要有效的 HTTPS 服务器地址" }
  }

  fun allows(host: String, port: Int): Boolean =
    endpoint == Pair(host.lowercase(Locale.ROOT).removeSurrounding("[", "]"), port)

  private fun parseOrigin(value: String): Pair<String, Int>? = try {
    val uri = URI(value.trim())
    val host = uri.host
    val port = if (uri.port == -1) 443 else uri.port
    if (!uri.scheme.equals("https", true) || host.isNullOrBlank() || uri.rawUserInfo != null || port !in 1..65535) null
    else Pair(host.lowercase(Locale.ROOT).removeSurrounding("[", "]"), port)
  } catch (_: Exception) { null }
}
