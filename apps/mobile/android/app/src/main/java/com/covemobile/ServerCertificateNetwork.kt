package com.covemobile

import com.facebook.react.modules.network.OkHttpClientProvider
import java.net.InetAddress
import java.net.Socket
import java.security.KeyStore
import java.security.cert.X509Certificate
import java.util.concurrent.CopyOnWriteArrayList
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient
import okhttp3.Protocol

/** Shared by React Native HTTP, WebSocket and react-native-video's OkHttp data source. */
object ServerCertificateNetwork {
  private val policy = ServerCertificatePolicy()
  private val clients = CopyOnWriteArrayList<OkHttpClient>()
  private val strictTrust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
    init(null as KeyStore?)
  }.trustManagers.filterIsInstance<X509TrustManager>().first()
  private val exceptionTrust = object : X509TrustManager {
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
      strictTrust.checkClientTrusted(chain, authType)
    // This context is selected only by ScopedSocketFactory for the explicit endpoint.
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
  }

  fun install() {
    OkHttpClientProvider.setOkHttpClientFactory { createClient(OkHttpClientProvider.createClientBuilder().build()) }
  }

  @Synchronized fun configure(url: String, enabled: Boolean) {
    policy.configure(url, enabled)
    // A connection accepted under an old exception must not be reused after switching servers.
    clients.forEach { it.dispatcher.cancelAll(); it.connectionPool.evictAll() }
  }

  internal fun createClient(base: OkHttpClient): OkHttpClient {
    val exceptionFactory = SSLContext.getInstance("TLS").apply {
      init(null, arrayOf(exceptionTrust), null)
    }.socketFactory
    return base.newBuilder()
      .sslSocketFactory(ScopedSocketFactory(base.sslSocketFactory, exceptionFactory, policy), strictTrust)
      // Disallow HTTP/2 origin coalescing across an exception boundary.
      .protocols(listOf(Protocol.HTTP_1_1))
      .hostnameVerifier { host, session ->
        if (policy.allows(host, session.peerPort)) true
        else {
          // Recheck trust if configuration changed while a permissive handshake was in flight.
          try {
            val chain = session.peerCertificates.map { it as X509Certificate }.toTypedArray()
            strictTrust.checkServerTrusted(chain, chain.first().publicKey.algorithm)
            base.hostnameVerifier.verify(host, session)
          } catch (_: Exception) { false }
        }
      }
      .build().also { clients.add(it) }
  }
}

/** Normal sockets always use the system trust store. No IP/DNS alias expands the exception. */
internal class ScopedSocketFactory(
  private val strict: SSLSocketFactory,
  private val exception: SSLSocketFactory,
  private val policy: ServerCertificatePolicy,
) : SSLSocketFactory() {
  private fun forEndpoint(host: String, port: Int) = if (policy.allows(host, port)) exception else strict
  override fun getDefaultCipherSuites(): Array<String> = strict.defaultCipherSuites
  override fun getSupportedCipherSuites(): Array<String> = strict.supportedCipherSuites
  override fun createSocket(): Socket = strict.createSocket()
  override fun createSocket(socket: Socket, host: String, port: Int, autoClose: Boolean): Socket =
    forEndpoint(host, port).createSocket(socket, host, port, autoClose)
  override fun createSocket(host: String, port: Int): Socket = forEndpoint(host, port).createSocket(host, port)
  override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket =
    forEndpoint(host, port).createSocket(host, port, local, localPort)
  override fun createSocket(host: InetAddress, port: Int): Socket = strict.createSocket(host, port)
  override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int): Socket =
    strict.createSocket(host, port, local, localPort)
}
