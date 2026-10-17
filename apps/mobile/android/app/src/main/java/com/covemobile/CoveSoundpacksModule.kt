package com.covemobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.modules.network.OkHttpClientProvider
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.Call

private data class SoundpackSelection(val file: File, val name: String, val mimeType: String,
  val duration: Double, val revoked: AtomicBoolean = AtomicBoolean(false))
private data class SoundpackDocumentRequest(val code: Int, val picking: Boolean, val promise: Promise, val generation: Int,
  val file: File? = null, val filename: String? = null, val booleanResult: Boolean = false)

/** SAF grants access only to explicitly selected documents; all previews use private cache copies. */
class CoveSoundpacksModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newSingleThreadExecutor()
  private val generation = AtomicInteger()
  private val requestCodes = AtomicInteger()
  private val busy = AtomicBoolean(false)
  private val selections = ConcurrentHashMap<String, SoundpackSelection>()
  private val cache = File(context.cacheDir, "cove-soundpack-selections").apply { mkdirs() }
  @Volatile private var pending: SoundpackDocumentRequest? = null
  @Volatile private var activeCall: Call? = null
  private val client by lazy { soundpackDownloadClient(OkHttpClientProvider.getOkHttpClient()) }

  private val listener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      val request = synchronized(this@CoveSoundpacksModule) {
        val value = pending?.takeIf { it.code == requestCode } ?: return
        pending = null
        value
      }
      if (resultCode != Activity.RESULT_OK || generation.get() != request.generation) {
        request.file?.delete(); busy.set(false)
        resolveCancelled(request)
        return
      }
      executor.execute {
        try {
          val cancelled = { generation.get() != request.generation }
          if (request.picking) {
            val uris = mutableListOf<Uri>()
            data?.clipData?.let { clip -> for (index in 0 until clip.itemCount) uris.add(clip.getItemAt(index).uri) }
            if (uris.isEmpty()) data?.data?.let { uris.add(it) }
            require(uris.isNotEmpty() && uris.size <= MAX_SOUNDPACK_SELECTIONS) { "Choose between 1 and 20 audio files" }
            val imported = mutableListOf<Pair<String, SoundpackSelection>>()
            try {
              for (uri in uris.distinct()) {
                check(!cancelled()) { "Soundpack operation cancelled" }
                imported.add(importAudio(uri, cancelled))
              }
              synchronized(this@CoveSoundpacksModule) {
                check(!cancelled()) { "Soundpack operation cancelled" }
                val result = Arguments.createArray()
                for ((id, audio) in imported) {
                  selections[id] = audio
                  result.pushMap(Arguments.createMap().apply {
                    putString("id", id); putString("name", audio.name); putString("mimeType", audio.mimeType)
                    putDouble("size", audio.file.length().toDouble()); putString("uri", Uri.fromFile(audio.file).toString())
                    putDouble("duration", audio.duration)
                  })
                }
                request.promise.resolve(result)
              }
            } catch (error: Exception) {
              imported.forEach { (_, audio) -> audio.file.delete() }
              throw error
            }
          } else {
            val uri = data?.data ?: error("No save destination was selected")
            require(uri.scheme == "content") { "The destination must be a system document" }
            check(!cancelled()) { "Soundpack operation cancelled" }
            val file = request.file ?: error("Download cache is unavailable")
            reactApplicationContext.contentResolver.openOutputStream(uri, "wt")?.use { output ->
              file.inputStream().use { copySoundpackBytes(it, output, cancelled) }
            } ?: error("The document provider cannot save this file")
            synchronized(this@CoveSoundpacksModule) {
              check(!cancelled()) { "Document operation cancelled" }
              if (request.booleanResult) request.promise.resolve(true)
              else request.promise.resolve(Arguments.createMap().apply {
                  putBoolean("cancelled", false); putString("filename", request.filename)
                })
            }
          }
        } catch (error: Exception) {
          if (generation.get() != request.generation) {
            resolveCancelled(request)
          } else request.promise.reject("SOUNDPACK_FILE", error.message ?: "Audio document operation failed")
        } finally { request.file?.delete(); busy.set(false) }
      }
    }
  }

  init { context.addActivityEventListener(listener) }
  override fun getName() = "CoveSoundpacks"
  // A cancelled picker's late callback cannot consume a new picker's request.
  private fun nextRequestCode() = 27000 + requestCodes.incrementAndGet() % 4096
  private fun resolveCancelled(request: SoundpackDocumentRequest) {
    when {
      request.picking -> request.promise.resolve(Arguments.createArray())
      request.booleanResult -> request.promise.resolve(false)
      else -> request.promise.resolve(Arguments.createMap().apply { putBoolean("cancelled", true) })
    }
  }

  private fun importAudio(uri: Uri, cancelled: () -> Boolean): Pair<String, SoundpackSelection> {
    require(uri.scheme == "content") { "Choose an audio file in the system file picker" }
    val resolver = reactApplicationContext.contentResolver
    var name = "audio"
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) {
        val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (nameColumn >= 0) name = cursor.getString(nameColumn) ?: name
        val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) require(cursor.getLong(sizeColumn) <= MAX_SOUNDPACK_BYTES) { "Audio exceeds 8 MB" }
      }
    }
    val reported = resolver.getType(uri)?.lowercase()?.substringBefore(';')
    val mime = if (reported?.startsWith("audio/") == true) reported else when (name.substringAfterLast('.', "").lowercase()) {
      "mp3" -> "audio/mpeg"; "wav", "wave" -> "audio/wav"; "m4a", "mp4" -> "audio/mp4"
      "aac" -> "audio/aac"; "ogg", "oga", "opus" -> "audio/ogg"; "flac" -> "audio/flac"
      else -> error("The selected document is not a supported audio file")
    }
    val id = UUID.randomUUID().toString()
    val extension = name.substringAfterLast('.', "audio").lowercase().takeIf { Regex("[a-z0-9]{1,8}").matches(it) } ?: "audio"
    val file = File(cache, "$id.$extension")
    try {
      resolver.openInputStream(uri)?.use { input -> file.outputStream().use { copySoundpackBytes(input, it, cancelled) } }
        ?: error("The document provider cannot read this file")
      check(!cancelled()) { "Soundpack operation cancelled" }
      val duration = soundpackDuration(file)
      require(duration.isFinite() && duration > 0) { "Android cannot read this audio format" }
      return id to SoundpackSelection(file, safeSoundpackFilename(name), mime, duration)
    } catch (error: Exception) { file.delete(); throw error }
  }

  private fun launch(request: SoundpackDocumentRequest, intent: Intent) {
    reactApplicationContext.runOnUiQueueThread {
      try {
        synchronized(this) {
          check(generation.get() == request.generation) { "Soundpack operation cancelled" }
          check(pending == null) { "Another document picker is open" }
          val activity = reactApplicationContext.currentActivity ?: error("Open Cove before choosing a file")
          pending = request
          try { activity.startActivityForResult(intent, request.code) }
          catch (error: Exception) { pending = null; throw error }
        }
      } catch (error: Exception) {
        request.file?.delete(); busy.set(false)
        request.promise.reject("SOUNDPACK_PICKER", error.message ?: "Cannot open the system document picker")
      }
    }
  }

  @ReactMethod fun pickAudioFiles(promise: Promise) {
    if (!busy.compareAndSet(false, true)) { promise.reject("SOUNDPACK_BUSY", "Another audio operation is running"); return }
    launch(SoundpackDocumentRequest(nextRequestCode(), true, promise, generation.get()), Intent(Intent.ACTION_OPEN_DOCUMENT)
      .addCategory(Intent.CATEGORY_OPENABLE).setType("audio/*")
      .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
  }

  @ReactMethod fun readAudioSelection(id: String, startSeconds: Double, endSeconds: Double, promise: Promise) {
    val epoch = generation.get()
    executor.execute {
      var preview: File? = null
      try {
        val selection = selections[id] ?: error("This audio selection is no longer available")
        val cancelled = { epoch != generation.get() || selection.revoked.get() }
        check(!cancelled()) { "Soundpack operation cancelled" }
        val (start, end) = validateSoundpackRange(startSeconds, endSeconds, selection.duration)
        val full = start == 0.0 && end >= selection.duration - 0.001
        val trimmed = if (full) null else trimSoundpack(selection.file, start, end, cancelled)
        val bytes = trimmed?.bytes ?: selection.file.inputStream().use { input ->
          java.io.ByteArrayOutputStream().apply { copySoundpackBytes(input, this, cancelled) }.toByteArray()
        }
        if (trimmed != null) {
          preview = File(cache, "$id-trim-${UUID.randomUUID()}.wav").also { it.writeBytes(bytes) }
        }
        synchronized(this) {
          check(!cancelled()) { "Soundpack operation cancelled" }
          promise.resolve(Arguments.createMap().apply {
            putString("data", Base64.encodeToString(bytes, Base64.NO_WRAP)); putString("mimeType", if (full) selection.mimeType else "audio/wav")
            putDouble("size", bytes.size.toDouble()); putDouble("duration", trimmed?.duration ?: selection.duration)
            putString("uri", Uri.fromFile(preview ?: selection.file).toString())
          })
        }
      } catch (error: Exception) { preview?.delete(); promise.reject("SOUNDPACK_READ", error.message ?: "Cannot read this audio selection") }
    }
  }

  @Synchronized @ReactMethod fun releaseAudioFiles(ids: ReadableArray, promise: Promise) {
    for (index in 0 until ids.size()) {
      val id = ids.getString(index) ?: continue
      selections.remove(id)?.let { it.revoked.set(true); it.file.delete() }
      // UUID names belong only to this module; never interpret user-provided paths.
      if (Regex("[a-f0-9-]{36}").matches(id)) cache.listFiles()?.filter { it.name.startsWith("$id-trim-") }?.forEach { it.delete() }
    }
    promise.resolve(null)
  }

  @ReactMethod fun saveSoundpack(options: ReadableMap, promise: Promise) {
    val request = try {
      val supplied = options.getMap("headers") ?: error("Soundpack download headers are required")
      val headers = linkedMapOf<String, String>()
      val keys = supplied.keySetIterator()
      while (keys.hasNextKey()) {
        val key = keys.nextKey()
        require(supplied.getType(key) == ReadableType.String) { "Invalid soundpack download header" }
        headers[key] = supplied.getString(key) ?: error("Invalid soundpack download header")
      }
      soundpackDownloadRequest(options.getString("url") ?: "", options.getString("serverURL") ?: "",
        options.getString("roomId") ?: "", options.getString("soundId") ?: "",
        options.getString("variant") ?: "", headers)
    } catch (_: Exception) { null }
    if (request == null) { promise.reject("SOUNDPACK_SOURCE", "The download must be an authorized sound from the current room"); return }
    if (!busy.compareAndSet(false, true)) { promise.reject("SOUNDPACK_BUSY", "Another audio operation is running"); return }
    val epoch = generation.get()
    val filename = safeSoundpackFilename(options.getString("filename") ?: "audio")
    executor.execute {
      val file = File(cache, "download-${UUID.randomUUID()}.audio")
      try {
        val cancelled = { generation.get() != epoch }
        val call = client.newCall(request)
        synchronized(this) {
          check(!cancelled()) { "Soundpack operation cancelled" }
          activeCall = call
        }
        call.execute().use { response ->
          check(response.isSuccessful) { "Audio download HTTP ${response.code}" }
          val body = response.body ?: error("Empty audio response")
          check(body.contentLength() <= MAX_SOUNDPACK_BYTES) { "Audio exceeds 8 MB" }
          body.byteStream().use { input -> file.outputStream().use { copySoundpackBytes(input, it, cancelled) } }
        }
        check(!cancelled()) { "Soundpack operation cancelled" }
        launch(SoundpackDocumentRequest(nextRequestCode(), false, promise, epoch, file, filename), Intent(Intent.ACTION_CREATE_DOCUMENT)
          .addCategory(Intent.CATEGORY_OPENABLE).setType("audio/*").putExtra(Intent.EXTRA_TITLE, filename)
          .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
      } catch (error: Exception) {
        file.delete(); busy.set(false)
        if (generation.get() != epoch) promise.resolve(Arguments.createMap().apply { putBoolean("cancelled", true) })
        else promise.reject("SOUNDPACK_DOWNLOAD", error.message ?: "Audio download failed")
      } finally { activeCall = null }
    }
  }

  /** Diagnostics text comes from JS; this never reads a device or existing user document. */
  @ReactMethod fun saveTextFile(text: String, fileName: String, promise: Promise) {
    val document = try { soundpackTextDocument(text, fileName) } catch (error: Exception) {
      promise.reject("DOCUMENT_CONTENT", error.message); return
    }
    val (filename, bytes) = document
    if (!busy.compareAndSet(false, true)) { promise.reject("SOUNDPACK_BUSY", "Another document operation is running"); return }
    val epoch = generation.get()
    executor.execute {
      val file = File(cache, "text-${UUID.randomUUID()}.txt")
      try {
        check(generation.get() == epoch) { "Document operation cancelled" }
        file.writeBytes(bytes)
        launch(SoundpackDocumentRequest(nextRequestCode(), false, promise, epoch, file, filename, true),
          Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(if (filename.endsWith(".json", true)) "application/json" else "text/plain")
            .putExtra(Intent.EXTRA_TITLE, filename).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
      } catch (error: Exception) {
        file.delete(); busy.set(false)
        if (generation.get() != epoch) promise.resolve(false)
        else promise.reject("DOCUMENT_SAVE", error.message ?: "Cannot save this text")
      }
    }
  }

  @Synchronized private fun cancel() {
    generation.incrementAndGet(); activeCall?.cancel()
    val request = pending.also { pending = null }
    request?.file?.delete()
    request?.let {
      resolveCancelled(it)
      reactApplicationContext.runOnUiQueueThread { reactApplicationContext.currentActivity?.finishActivity(it.code) }
      busy.set(false)
    }
    selections.values.forEach { it.revoked.set(true); it.file.delete() }; selections.clear()
    // Defer final cleanup until in-flight decoders/readers have observed cancellation.
    executor.execute { cache.listFiles()?.forEach { it.delete() } }
  }

  @ReactMethod fun cancelOperations(promise: Promise) { cancel(); promise.resolve(null) }
  override fun invalidate() {
    cancel(); reactApplicationContext.removeActivityEventListener(listener)
    executor.shutdown(); super.invalidate()
  }
}
