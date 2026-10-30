package com.covemobile

import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.network.OkHttpClientProvider
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Call
import okhttp3.Request

/** Bounded, private, session-only prepared audio. Never changes AudioManager routing/focus. */
class CoveSoundpackPlaybackModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
  private class Entry(val id: String, val version: String, val request: Request) {
    val cancelled = AtomicBoolean(false)
    @Volatile var call: Call? = null
    @Volatile var file: File? = null
    var player: MediaPlayer? = null
    var ready = false
    var played = false
  }
  private val main = Handler(Looper.getMainLooper())
  private val downloads = Executors.newFixedThreadPool(2)
  private val entries = LinkedHashMap<String, Entry>(8, 0.75f, true)
  private val client by lazy { soundpackDownloadClient(OkHttpClientProvider.getOkHttpClient()) }
  @Volatile private var session = ""
  @Volatile private var foreground = true
  private var playing: Entry? = null
  private var playKey = 0.0
  private var pausedForBackground = false
  private val cache = File(context.cacheDir, "cove-prepared-soundpacks").apply {
    mkdirs()
    // No audio survives process restarts or account changes.
    listFiles()?.filter { it.isFile }?.forEach { it.delete() }
  }
  init { context.addLifecycleEventListener(this) }
  override fun getName() = "CoveSoundpackPlayback"
  @ReactMethod fun addListener(name: String) {}
  @ReactMethod fun removeListeners(count: Double) {}

  private fun release(entry: Entry) {
    entry.cancelled.set(true)
    entry.call?.cancel()
    entry.player?.release()
    entry.player = null
    entry.file?.delete()
    if (playing === entry) { playing = null; pausedForBackground = false }
  }
  private fun clearAll() { entries.values.forEach { release(it) }; entries.clear(); playing = null; pausedForBackground = false }
  @ReactMethod fun configure(value: String) { main.post { if (session != value) { clearAll(); session = value } } }
  @ReactMethod fun clear(value: String) { main.post { if (session == value) { session = ""; clearAll() } } }

  @ReactMethod fun prepare(value: String, source: ReadableMap, promise: Promise) {
    val id: String
    val version: String
    val request: Request
    try {
      id = source.getString("soundId") ?: error("Missing sound")
      version = source.getString("version") ?: error("Missing sound revision")
      val values = source.getMap("headers") ?: error("Missing authorization")
      val headers = linkedMapOf<String, String>()
      val keys = values.keySetIterator()
      while (keys.hasNextKey()) { val key = keys.nextKey(); headers[key] = values.getString(key) ?: error("Invalid header") }
      request = soundpackDownloadRequest(source.getString("uri") ?: "", source.getString("serverURL") ?: "",
        source.getString("roomId") ?: "", id, "playback", headers) ?: error("Invalid protected sound source")
    } catch (_: Exception) { promise.resolve(false); return }
    main.post {
      if (session != value || value.isEmpty()) { promise.resolve(false); return@post }
      val previous = entries[id]
      if (previous?.version == version) { promise.resolve(previous.ready); return@post }
      previous?.let { release(it); entries.remove(id) }
      while (entries.size >= 8) {
        val oldest = entries.values.firstOrNull { it !== playing } ?: break
        entries.remove(oldest.id); release(oldest)
      }
      val entry = Entry(id, version, request)
      entries[id] = entry
      promise.resolve(false)
      downloads.execute {
        var file: File? = null
        try {
          if (entry.cancelled.get() || session != value) return@execute
          val call = client.newCall(request)
          entry.call = call
          if (entry.cancelled.get()) { call.cancel(); return@execute }
          val downloadFile = File.createTempFile("sound-", ".audio", cache)
          file = downloadFile
          entry.file = downloadFile
          call.execute().use { response ->
            check(response.isSuccessful) { "Audio download failed" }
            val body = response.body ?: error("Empty audio")
            require(body.contentLength() <= MAX_SOUNDPACK_BYTES) { "Audio is too large" }
            body.byteStream().use { input -> downloadFile.outputStream().use { output ->
              copySoundpackBytes(input, output) { entry.cancelled.get() || session != value }
            } }
          }
          val preparedFile = downloadFile
          main.post {
            if (entry.cancelled.get() || session != value || entries[id] !== entry) { preparedFile.delete(); return@post }
            try {
              val player = MediaPlayer()
              entry.player = player
              player.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
              player.setDataSource(preparedFile.absolutePath)
              player.setOnPreparedListener { entry.ready = true }
              player.setOnCompletionListener { if (playing === entry) { playing = null; emitEnd(value, playKey, false) } }
              player.setOnErrorListener { _, _, _ ->
                if (playing === entry) emitEnd(value, playKey, true)
                entries.remove(id); release(entry); true
              }
              player.prepareAsync()
            } catch (_: Exception) { entries.remove(id); release(entry) }
          }
        } catch (_: Exception) {
          file?.delete()
          main.post { if (entries[id] === entry) { entries.remove(id); release(entry) } }
        } finally { entry.call = null }
      }
    }
  }

  @ReactMethod fun play(value: String, id: String, version: String, key: Double, volume: Double, promise: Promise) {
    val requested = SystemClock.elapsedRealtimeNanos()
    main.post {
      val entry = entries[id]
      val player = entry?.player
      if (!foreground || session != value || entry == null || !entry.ready || entry.version != version || player == null) { promise.resolve(false); return@post }
      try {
        playing?.player?.pause()
        playing = entry; playKey = key; pausedForBackground = false
        val gain = volume.toFloat().coerceIn(0f, 1f)
        player.setVolume(gain, gain)
        val start = {
          if (foreground && session == value && playing === entry && playKey == key && !entry.cancelled.get()) {
            try {
              player.start(); entry.played = true
              // This measures native scheduling, not acoustic output latency.
              val metrics = Arguments.createMap().apply {
                putString("session", value); putDouble("key", key)
                putBoolean("isPlaying", player.isPlaying)
                putDouble("nativeStartMs", (SystemClock.elapsedRealtimeNanos() - requested) / 1_000_000.0)
              }
              emit("CoveSoundpackStarted", metrics)
            } catch (_: Exception) { entries.remove(id); release(entry); emitEnd(value, key, true) }
          }
        }
        if (entry.played) { player.setOnSeekCompleteListener { start() }; player.seekTo(0) } else start()
        promise.resolve(true)
      } catch (_: Exception) { entries.remove(id); release(entry); promise.resolve(false) }
    }
  }
  @ReactMethod fun stop(value: String) { main.post { if (session == value) { playing?.player?.pause(); playing = null; pausedForBackground = false } } }
  @ReactMethod fun setVolume(value: String, volume: Double) { main.post { if (session == value) { val gain = volume.toFloat().coerceIn(0f, 1f); playing?.player?.setVolume(gain, gain) } } }
  private fun emitEnd(value: String, key: Double, error: Boolean) {
    val result = Arguments.createMap().apply { putString("session", value); putDouble("key", key); putBoolean("error", error) }
    emit("CoveSoundpackEnded", result)
  }
  private fun emit(name: String, result: WritableMap) {
    // React can be destroyed between a queued player callback and its delivery.
    runCatching { reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, result) }
  }
  override fun onHostResume() {
    foreground = true
    main.post {
      if (pausedForBackground) {
        pausedForBackground = false
        val entry = playing
        if (entry != null && !entry.cancelled.get()) {
          try { entry.player?.start() } catch (_: Exception) { release(entry); emitEnd(session, playKey, true) }
        }
      }
    }
  }
  override fun onHostPause() {
    val activity = reactApplicationContext.currentActivity
    if (activity?.isInMultiWindowMode == true || (android.os.Build.VERSION.SDK_INT >= 26 && activity?.isInPictureInPictureMode == true)) return
    foreground = false
    main.post {
      if (playing != null) {
        runCatching { playing?.player?.pause() }; pausedForBackground = true
      }
    }
  }
  override fun onHostDestroy() { session = ""; main.post { clearAll() } }
  override fun invalidate() {
    session = ""; reactApplicationContext.removeLifecycleEventListener(this)
    main.post { clearAll() }; downloads.shutdownNow(); super.invalidate()
  }
}
