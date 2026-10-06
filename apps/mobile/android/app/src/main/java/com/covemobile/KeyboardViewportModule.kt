package com.covemobile

import android.graphics.Rect
import android.os.Build
import android.view.View
import android.view.ViewTreeObserver
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/** Observes without replacing/consuming the Activity's or SafeAreaView's inset listeners. */
class KeyboardViewportModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context), LifecycleEventListener {
  private var listenerCount = 0
  private var observedView: View? = null
  private var previous: KeyboardFrame? = null
  private val visibleFrame = Rect()
  private val screenLocation = IntArray(2)
  private val windowLocation = IntArray(2)
  private val preDraw = ViewTreeObserver.OnPreDrawListener {
    emitChangedFrame()
    true
  }

  init { context.addLifecycleEventListener(this) }
  override fun getName() = "CoveKeyboard"

  @ReactMethod fun addListener(eventName: String) {
    UiThreadUtil.runOnUiThread {
      listenerCount += 1
      attach()
    }
  }

  @ReactMethod fun removeListeners(count: Double) {
    UiThreadUtil.runOnUiThread {
      listenerCount = (listenerCount - count.toInt()).coerceAtLeast(0)
      if (listenerCount == 0) detach()
    }
  }

  @ReactMethod fun getKeyboardFrame(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      promise.resolve(readFrame()?.let(::payload))
    }
  }

  private fun readFrame(): KeyboardFrame? {
    val activity = context.currentActivity ?: return null
    val decor = activity.window.decorView
    if (decor.height <= 0) return null
    val insets = ViewCompat.getRootWindowInsets(decor) ?: return null
    decor.getWindowVisibleDisplayFrame(visibleFrame)
    decor.getLocationOnScreen(screenLocation)
    decor.getLocationInWindow(windowLocation)
    val windowScreenY = screenLocation[1] - windowLocation[1]
    val bounds = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
      activity.windowManager.currentWindowMetrics.bounds else null
    val windowBottom = bounds?.bottom ?: (screenLocation[1] + decor.height)
    val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
    return keyboardFrame(
      visible = insets.isVisible(WindowInsetsCompat.Type.ime()) && imeBottom > 0,
      windowBottom = windowBottom,
      imeTop = bounds?.let { it.bottom - imeBottom },
      visibleBottom = visibleFrame.bottom,
      visibleTop = visibleFrame.top,
      windowScreenY = windowScreenY,
      width = bounds?.width() ?: decor.width,
    )
  }

  private fun payload(frame: KeyboardFrame): WritableMap {
    val density = context.resources.displayMetrics.density.toDouble()
    return Arguments.createMap().apply {
      putBoolean("visible", frame.visible)
      putDouble("top", frame.top / density)
      putDouble("height", frame.height / density)
      putDouble("width", frame.width / density)
    }
  }

  private fun emitChangedFrame() {
    val frame = readFrame() ?: return
    if (frame == previous || !context.hasActiveReactInstance()) return
    previous = frame
    context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("coveKeyboardFrame", payload(frame))
  }

  private fun attach() {
    if (listenerCount == 0) return
    val view = context.currentActivity?.window?.decorView ?: return
    if (view !== observedView) {
      detach()
      observedView = view
      view.viewTreeObserver.addOnPreDrawListener(preDraw)
    }
    emitChangedFrame()
  }

  private fun detach() {
    observedView?.viewTreeObserver?.takeIf { it.isAlive }?.removeOnPreDrawListener(preDraw)
    observedView = null
    previous = null
  }

  override fun onHostResume() { attach() }
  override fun onHostPause() { detach() }
  override fun onHostDestroy() { detach() }
  override fun invalidate() {
    context.removeLifecycleEventListener(this)
    UiThreadUtil.runOnUiThread { listenerCount = 0; detach() }
    super.invalidate()
  }
}
