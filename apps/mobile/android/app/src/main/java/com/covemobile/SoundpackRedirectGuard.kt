package com.covemobile

import java.net.ProtocolException
import okhttp3.Interceptor
import okhttp3.Response

/** A network interceptor sees the response before OkHttp can forward a custom account header. */
internal class SoundpackRedirectGuard : Interceptor {
  override fun intercept(chain: Interceptor.Chain): Response {
    val request = chain.request()
    val response = chain.proceed(request)
    if (request.header("X-Cove-Account-Token") != null && response.code in 300..399) {
      response.body?.close()
      // OkHttp treats ProtocolException as non-recoverable; no redirect or retry follows.
      throw ProtocolException("Redirects are not allowed for protected Cove sound requests")
    }
    return response
  }
}
