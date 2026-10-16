package com.covemobile

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.Executors

/** Server bearer grants use a separate Keystore key and encrypted no-backup file. */
class ServerAccessGrantsModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val key = AndroidAccountPasswordKey("cove.server.access.grants.v1")
  private val store = AccountPasswordStore(
    AndroidAccountPasswordStorage(context.noBackupFilesDir, "cove-server-access-grants-v1.bin"),
    AccountPasswordCipher({ key.key(true) }, { key.key(false) }),
  )
  private val executor = Executors.newSingleThreadExecutor()
  override fun getName() = "CoveServerAccessGrants"

  private fun result(ok: Boolean, value: String? = null): WritableMap = Arguments.createMap().apply {
    putBoolean("available", true)
    putBoolean("ok", ok)
    if (value == null) putNull("value") else putString("value", value)
  }
  private fun run(promise: Promise, action: () -> WritableMap) {
    try {
      executor.execute { promise.resolve(try { action() } catch (_: Exception) { result(false) }) }
    } catch (_: Exception) { promise.resolve(result(false)) }
  }
  @ReactMethod fun get(serverURL: String, email: String, promise: Promise) = run(promise) {
    result(true, store.get(serverURL, email))
  }
  @ReactMethod fun save(serverURL: String, email: String, value: String, promise: Promise) = run(promise) {
    store.save(serverURL, email, value)
    result(true)
  }
  @ReactMethod fun remove(serverURL: String, email: String, promise: Promise) = run(promise) {
    store.remove(serverURL, email)
    result(true)
  }
  @ReactMethod fun clear(promise: Promise) = run(promise) {
    store.clear()
    result(true)
  }
  override fun invalidate() { executor.shutdown(); super.invalidate() }
}
