package com.covemobile

import java.io.File
import java.net.Socket
import java.nio.file.Files
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.Assert.*
import org.junit.Test

class ServerCertificateNetworkTest {
  @Test fun originPolicyIsExplicitAndPortScoped() {
    val policy = ServerCertificatePolicy()
    assertFalse(policy.allows("localhost", 443))
    policy.configure("https://LOCALHOST:51758/api/rooms", true)
    assertTrue(policy.allows("localhost", 51758))
    assertFalse(policy.allows("localhost", 443))
    assertFalse(policy.allows("localhost.evil.test", 51758))
    assertFalse(policy.allows("127.0.0.1", 51758))
    policy.configure("https://[::1]", true)
    assertTrue(policy.allows("::1", 443))
    policy.configure("", false)
    assertFalse(policy.allows("::1", 443))
    for (url in listOf("http://localhost", "https://name:pass@localhost", "https://localhost:0", "not-a-url")) {
      assertThrows(IllegalArgumentException::class.java) { policy.configure(url, true) }
      assertFalse(policy.allows("localhost", 443))
    }
  }

  @Test fun realSelfSignedHttpsAndWebSocketAreScopedAndRevocable() {
    val directory = Files.createTempDirectory("cove-tls-test").toFile()
    try {
      val keyStoreFile = File(directory, "fixture.p12")
      val keytool = File(System.getProperty("java.home"), "bin/keytool.exe").let { if (it.exists()) it else File(System.getProperty("java.home"), "bin/keytool") }
      val process = ProcessBuilder(keytool.absolutePath, "-genkeypair", "-alias", "fixture", "-keyalg", "RSA", "-keystore", keyStoreFile.absolutePath,
        "-storetype", "PKCS12", "-storepass", "test-only-password", "-keypass", "test-only-password", "-dname", "CN=localhost", "-ext", "SAN=dns:localhost", "-validity", "1", "-noprompt")
        .redirectErrorStream(true).redirectOutput(File(directory, "keytool.log")).start()
      assertTrue(process.waitFor(30, TimeUnit.SECONDS))
      assertEquals(0, process.exitValue())
      val store = KeyStore.getInstance("PKCS12").apply { keyStoreFile.inputStream().use { load(it, "test-only-password".toCharArray()) } }
      val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, "test-only-password".toCharArray()) }
      val context = SSLContext.getInstance("TLS").apply { init(keys.keyManagers, null, null) }
      LocalTlsServer(context).use { first -> LocalTlsServer(context).use { second ->
        val client = ServerCertificateNetwork.createClient(OkHttpClient.Builder().callTimeout(4, TimeUnit.SECONDS).build())
        val url = "https://localhost:${first.port}"
        fun get(target: String) = client.newCall(Request.Builder().url(target).build()).execute().use { it.body!!.string() }
        ServerCertificateNetwork.configure("", false)
        assertThrows(Exception::class.java) { get(url) }
        ServerCertificateNetwork.configure(url, true)
        assertEquals("ok", get(url))
        // Update traffic must still reject exactly the certificate the user allowed for Cove.
        val updater = createMobileUpdateClient()
        assertThrows(javax.net.ssl.SSLException::class.java) {
          updater.newCall(Request.Builder().url(url).build()).execute().use { it.body!!.string() }
        }
        updater.connectionPool.evictAll()
        assertThrows(Exception::class.java) { get("https://localhost:${second.port}") }
        assertThrows(Exception::class.java) { get("https://127.0.0.1:${first.port}") }
        first.redirect = "https://localhost:${second.port}"
        assertThrows(Exception::class.java) { get("$url/redirect") }
        first.redirect = null
        val opened = CountDownLatch(1)
        var failure: Throwable? = null
        val websocket = client.newWebSocket(Request.Builder().url("wss://localhost:${first.port}/socket").build(), object : WebSocketListener() {
          override fun onOpen(webSocket: WebSocket, response: Response) { opened.countDown() }
          override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { failure = t; opened.countDown() }
        })
        assertTrue(opened.await(5, TimeUnit.SECONDS))
        assertNull(failure)
        websocket.cancel()
        ServerCertificateNetwork.configure("", false)
        assertThrows(Exception::class.java) { get(url) }
      } }
    } finally {
      ServerCertificateNetwork.configure("", false)
      // Only this test's newly created temporary directory is removed.
      directory.deleteRecursively()
    }
  }

  private class LocalTlsServer(context: SSLContext) : AutoCloseable {
    private val server = context.serverSocketFactory.createServerSocket(0) as SSLServerSocket
    val port: Int get() = server.localPort
    @Volatile var redirect: String? = null
    private val worker = Thread {
      while (!server.isClosed) {
        val socket = try { server.accept() } catch (_: Exception) { break }
        Thread { handle(socket) }.apply { isDaemon = true; start() }
      }
    }.apply { isDaemon = true; start() }

    private fun handle(socket: Socket) {
      socket.use {
        try {
          socket.soTimeout = 4000
          val reader = socket.getInputStream().bufferedReader()
          val request = reader.readLine() ?: return
          val headers = mutableMapOf<String, String>()
          while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
            val parts = line.split(":", limit = 2)
            if (parts.size == 2) headers[parts[0].lowercase()] = parts[1].trim()
          }
          val key = headers["sec-websocket-key"]
          val response = if (key != null) {
            val accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()))
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n"
          } else if (request.contains("/redirect") && redirect != null) {
            "HTTP/1.1 302 Found\r\nLocation: $redirect\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
          } else "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
          socket.getOutputStream().apply { write(response.toByteArray()); flush() }
          if (key != null) socket.getInputStream().read()
        } catch (_: Exception) { /* Invalid certificates deliberately abort handshakes. */ }
      }
    }
    override fun close() { server.close(); worker.join(1000) }
  }
}
