package com.covemobile.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.SoundPool
import android.os.Handler
import com.covemobile.R

/** Owns only the two local UI cues; voice audio and its route remain untouched. */
class PresenceTonePlayer(context: Context, private val handler: Handler) {
  private val context = context.applicationContext
  @Volatile private var closed = false
  private var pool: SoundPool? = null
  private val sounds = mutableMapOf<String, Int>()
  private val loaded = mutableSetOf<Int>()
  private var pending: String? = null

  fun play(action: String) {
    if (closed || (action != "join" && action != "leave")) return
    handler.post {
      if (closed) return@post
      try {
        val current = pool ?: createPool()
        val sound = sounds[action] ?: return@post
        if (sound == 0) return@post
        if (sound in loaded) {
          pending = null
          playLoaded(current, sound)
        } else pending = action // No queue of stale join/leave cues during loading.
      } catch (_: Exception) {
        releasePool()
      }
    }
  }

  fun close() {
    closed = true // Reject queued plays and late load callbacks immediately.
    handler.post { releasePool() }
  }

  private fun createPool(): SoundPool {
    val current = SoundPool.Builder()
      .setMaxStreams(2)
      .setAudioAttributes(AudioAttributes.Builder()
        .setLegacyStreamType(AudioManager.STREAM_MUSIC)
        .build())
      .build()
    pool = current
    current.setOnLoadCompleteListener { completed, sound, status ->
      handler.post {
        if (closed || pool !== completed) return@post
        if (status == 0) loaded.add(sound)
        val next = pending
        if (next != null && sounds[next] == sound) {
          pending = null
          if (status == 0) playLoaded(completed, sound)
        }
      }
    }
    sounds["join"] = current.load(context, R.raw.voice_join, 1)
    sounds["leave"] = current.load(context, R.raw.voice_leave, 1)
    return current
  }

  private fun playLoaded(current: SoundPool, sound: Int) {
    if (closed || pool !== current) return
    try {
      // The WAV already contains the chosen gain. Respect the user's current
      // music-stream volume rather than changing any system/call volume.
      current.play(sound, 1f, 1f, 0, 0, 1f)
    } catch (_: Exception) {
      releasePool()
    }
  }

  private fun releasePool() {
    val old = pool
    pool = null
    pending = null
    sounds.clear()
    loaded.clear()
    try {
      old?.setOnLoadCompleteListener(null)
    } catch (_: Exception) {
      // UI feedback must never interrupt a voice operation or module teardown.
    }
    try { old?.release() } catch (_: Exception) { }
  }
}
