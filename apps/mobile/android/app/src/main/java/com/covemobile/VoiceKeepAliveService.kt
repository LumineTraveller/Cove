package com.covemobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

class VoiceKeepAliveService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    startVoiceForeground()
    val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = powerManager.newWakeLock(
      PowerManager.PARTIAL_WAKE_LOCK,
      "Cove:VoiceSession",
    ).apply { acquire() }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startVoiceForeground()
    // WebRTC 与 React Native 进程被系统杀死后，单独重启服务无法恢复通话。
    // 因此只在当前语音会话存活期间保持，不创建没有媒体轨道的“幽灵服务”。
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    wakeLock?.takeIf { it.isHeld }?.release()
    wakeLock = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun startVoiceForeground() {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
      ?: Intent(this, MainActivity::class.java)
    val pendingIntent = PendingIntent.getActivity(
      this,
      0,
      launchIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    val notification = builder
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("Cove 语音通话中")
      .setContentText("麦克风将在息屏后继续工作，点击返回房间")
      .setContentIntent(pendingIntent)
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_CALL)
      .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "语音通话",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "保持 Cove 语音在息屏时继续运行"
      setShowBadge(false)
    }
    (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
      .createNotificationChannel(channel)
  }

  companion object {
    private const val CHANNEL_ID = "cove_voice_session"
    private const val NOTIFICATION_ID = 12122
  }
}
