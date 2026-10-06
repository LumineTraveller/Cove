package com.covemobile.audio

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.covemobile.RnnoiseEngine
import org.webrtc.Logging
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * Lists and switches communication input/output devices.
 *
 * react-native-webrtc's enumerateDevices only exposes cameras plus one fake
 * audio entry on Android, so routing has to go through AudioManager. Output
 * uses setCommunicationDevice on API 31+ and the legacy SCO/speakerphone
 * flags below. Input is applied through JavaAudioDeviceModule so WebRTC's
 * AudioRecord follows the chosen microphone.
 */
object AudioRouteRuntime {
  private const val TAG = "CoveAudioRoute"

  const val DEFAULT_INPUT_ID = "default"

  // AudioDeviceInfo.TYPE_BLUETOOTH_LE is API 31+; keep the numeric value for minSdk 24.
  private const val TYPE_BLE = 26

  data class DeviceEntry(
    val id: String,
    val label: String,
    val type: Int,
    val isInput: Boolean,
    val isDefault: Boolean = false,
  )

  @Volatile
  private var adm: JavaAudioDeviceModule? = null

  @Volatile
  private var selectedInputId: String = DEFAULT_INPUT_ID

  @Volatile
  private var selectedOutputId: String? = null

  private val mainHandler = Handler(Looper.getMainLooper())
  private var audioManager: AudioManager? = null
  private var deviceCallbackRegistered = false

  private val reapplyOutput = Runnable { applyOutputRoute() }

  private val deviceCallback = object : android.media.AudioDeviceCallback() {
    override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = scheduleReapply()
    override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = scheduleReapply()
  }

  fun bind(context: Context, deviceModule: JavaAudioDeviceModule?) {
    adm = deviceModule
    audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    registerDeviceCallback()
  }

  fun release() {
    unregisterDeviceCallback()
    mainHandler.removeCallbacks(reapplyOutput)
    adm = null
    audioManager = null
  }

  fun listInputs(): List<DeviceEntry> {
    val manager = audioManager ?: return emptyList()
    val devices = manager.getDevices(AudioManager.GET_DEVICES_INPUTS)
    val usable = devices.filter { isUsableInput(it) }
    val default = DeviceEntry(DEFAULT_INPUT_ID, "系统默认麦克风", 0, isInput = true, isDefault = true)
    val rest = usable
      .sortedWith(compareBy({ typeRank(it.type) }, { it.id }))
      .map { DeviceEntry("in-${it.id}", inputLabel(it), it.type, isInput = true) }
    return listOf(default) + rest
  }

  fun listOutputs(): List<DeviceEntry> {
    val manager = audioManager ?: return emptyList()
    val candidates = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      manager.availableCommunicationDevices
    } else {
      manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).filter { isUsableOutput(it) }
    }
    val entries = candidates
      .filter { isUsableOutput(it) }
      .sortedWith(compareBy({ typeRank(it.type) }, { it.id }))
      .map { DeviceEntry("out-${it.id}", outputLabel(it), it.type, isInput = false) }
    // 保证扬声器/听筒一定可选，个别机型 availableCommunicationDevices 不全。
    val hasSpeaker = entries.any { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
    val hasEarpiece = entries.any { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
    val extras = mutableListOf<DeviceEntry>()
    if (!hasEarpiece) extras += DeviceEntry("out-earpiece", "听筒", AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, isInput = false)
    if (!hasSpeaker) extras += DeviceEntry("out-speaker", "扬声器", AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, isInput = false)
    return entries + extras
  }

  fun selectedInputId(): String = selectedInputId

  fun selectedOutputId(): String? = selectedOutputId

  fun setInput(deviceId: String?): Boolean {
    val normalized = deviceId?.takeIf { it.isNotBlank() } ?: DEFAULT_INPUT_ID
    val deviceModule = adm
    val manager = audioManager
    if (normalized == DEFAULT_INPUT_ID) {
      selectedInputId = DEFAULT_INPUT_ID
      try {
        // null clears the preferred device so WebRTC follows the system route.
        deviceModule?.setPreferredInputDevice(null)
      } catch (error: Throwable) {
        Logging.w(TAG, "clear preferred input failed: ${error.message}")
      }
      return true
    }
    val numeric = normalized.removePrefix("in-").toIntOrNull() ?: return false
    val info = manager
      ?.getDevices(AudioManager.GET_DEVICES_INPUTS)
      ?.firstOrNull { it.id == numeric && isUsableInput(it) }
      ?: return false
    return try {
      deviceModule?.setPreferredInputDevice(info)
      selectedInputId = normalized
      true
    } catch (error: Throwable) {
      Logging.w(TAG, "setPreferredInputDevice failed: ${error.message}")
      false
    }
  }

  fun setOutput(deviceId: String?): Boolean {
    selectedOutputId = deviceId?.takeIf { it.isNotBlank() }
    return applyOutputRoute()
  }

  fun status(): Map<String, Any?> = mapOf(
    "inputId" to selectedInputId,
    "outputId" to selectedOutputId,
    "rnnoiseEngineReady" to RnnoiseEngine.isReady(),
  )

  private fun applyOutputRoute(): Boolean {
    val manager = audioManager ?: return false
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    val targetId = selectedOutputId
    if (targetId.isNullOrBlank()) {
      // 未指定时交给系统按插入耳机/蓝牙自动选择，只去掉强制扬声器。
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        manager.clearCommunicationDevice()
      } else {
        legacySetSpeaker(false)
        legacySetBluetoothSco(false)
      }
      return true
    }

    val numeric = targetId.removePrefix("out-")
    // 兼容逻辑 id（听筒/扬声器在个别机型没有稳定 AudioDeviceInfo.id）。
    when (numeric) {
      "earpiece" -> return routeLegacy(manager, speaker = false, bluetooth = false)
      "speaker" -> return routeLegacy(manager, speaker = true, bluetooth = false)
      "bluetooth" -> return routeLegacy(manager, speaker = false, bluetooth = true)
    }

    val id = numeric.toIntOrNull() ?: return false
    val info = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull {
      it.id == id && isUsableOutput(it)
    } ?: return routeTypeFallback(manager, targetId)

    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try {
        if (manager.communicationDevice?.id == info.id) return true
        manager.setCommunicationDevice(info)
      } catch (error: Throwable) {
        Logging.w(TAG, "setCommunicationDevice failed: ${error.message}")
        routeLegacy(manager, info.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, info.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
      }
    } else {
      routeLegacy(
        manager,
        speaker = info.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        bluetooth = info.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      )
    }
  }

  private fun routeTypeFallback(manager: AudioManager, targetId: String): Boolean {
    val numeric = targetId.removePrefix("out-").toIntOrNull()
    // 设备已拔出时按类型退到默认策略。
    return routeLegacy(manager, speaker = true, bluetooth = false).also {
      selectedOutputId = null
      Logging.w(TAG, "output $targetId unavailable (probe=$numeric), fell back to speaker")
    }
  }

  private fun routeLegacy(manager: AudioManager, speaker: Boolean, bluetooth: Boolean): Boolean {
    return try {
      if (bluetooth) {
        legacySetSpeaker(false)
        legacySetBluetoothSco(true)
      } else {
        legacySetBluetoothSco(false)
        legacySetSpeaker(speaker)
      }
      true
    } catch (error: Throwable) {
      Logging.w(TAG, "legacy route failed: ${error.message}")
      false
    }
  }

  @Suppress("DEPRECATION")
  private fun legacySetSpeaker(enabled: Boolean) {
    audioManager?.isSpeakerphoneOn = enabled
  }

  @Suppress("DEPRECATION")
  private fun legacySetBluetoothSco(enabled: Boolean) {
    val manager = audioManager ?: return
    if (enabled) {
      manager.startBluetoothSco()
      manager.isBluetoothScoOn = true
    } else {
      manager.isBluetoothScoOn = false
      manager.stopBluetoothSco()
    }
  }

  private fun scheduleReapply() {
    mainHandler.removeCallbacks(reapplyOutput)
    mainHandler.postDelayed(reapplyOutput, 120)
  }

  private fun registerDeviceCallback() {
    if (deviceCallbackRegistered) return
    audioManager?.registerAudioDeviceCallback(deviceCallback, mainHandler)
    deviceCallbackRegistered = true
  }

  private fun unregisterDeviceCallback() {
    if (!deviceCallbackRegistered) return
    audioManager?.unregisterAudioDeviceCallback(deviceCallback)
    deviceCallbackRegistered = false
  }

  private fun isUsableInput(info: AudioDeviceInfo): Boolean {
    if (!info.isSource) return false
    return info.type in setOf(
      AudioDeviceInfo.TYPE_BUILTIN_MIC,
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      TYPE_BLE,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_USB_DEVICE,
      AudioDeviceInfo.TYPE_TELEPHONY,
    )
  }

  private fun isUsableOutput(info: AudioDeviceInfo): Boolean {
    if (!info.isSink) return false
    return info.type in setOf(
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      TYPE_BLE,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_USB_DEVICE,
    )
  }

  private fun typeRank(type: Int): Int = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> 0
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> 1
    AudioDeviceInfo.TYPE_BUILTIN_MIC -> 2
    AudioDeviceInfo.TYPE_WIRED_HEADSET -> 3
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> 4
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> 5
    TYPE_BLE -> 6
    AudioDeviceInfo.TYPE_USB_HEADSET -> 7
    AudioDeviceInfo.TYPE_USB_DEVICE -> 8
    else -> 9
  }

  private fun inputLabel(info: AudioDeviceInfo): String {
    val base = when (info.type) {
      AudioDeviceInfo.TYPE_BUILTIN_MIC -> "内置麦克风"
      AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "有线耳机麦克风"
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO, TYPE_BLE -> "蓝牙耳机麦克风"
      AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE -> "USB 麦克风"
      AudioDeviceInfo.TYPE_TELEPHONY -> "电话麦克风"
      else -> info.productName?.toString()?.takeIf { it.isNotBlank() } ?: "输入设备"
    }
    return base
  }

  private fun outputLabel(info: AudioDeviceInfo): String {
    val base = when (info.type) {
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "听筒"
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "扬声器"
      AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "有线耳机"
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO, TYPE_BLE -> "蓝牙耳机"
      AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE -> "USB 耳机"
      else -> info.productName?.toString()?.takeIf { it.isNotBlank() } ?: "输出设备"
    }
    return base
  }
}
