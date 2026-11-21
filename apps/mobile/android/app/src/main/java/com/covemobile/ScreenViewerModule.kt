package com.covemobile

import android.content.pm.ActivityInfo
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.views.modal.ReactModalHostView

class ScreenViewerModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private var previousOrientation: Int? = null

  override fun getName() = "CoveScreenViewer"

  @ReactMethod
  fun setScreenViewerOrientation(enabled: Boolean) {
    UiThreadUtil.runOnUiThread {
      val activity = context.currentActivity ?: return@runOnUiThread
      if (enabled && previousOrientation == null) {
        previousOrientation = activity.requestedOrientation
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR
      } else if (!enabled) {
        previousOrientation?.let { activity.requestedOrientation = it }
        previousOrientation = null
      }
    }
  }

  @ReactMethod
  fun setScreenViewerImmersive(modalTag: Int, hidden: Boolean) {
    UiThreadUtil.runOnUiThread {
      val activity = context.currentActivity ?: return@runOnUiThread
      val modal = if (modalTag > 0) runCatching {
        UIManagerHelper.getUIManagerForReactTag(context, modalTag)?.resolveView(modalTag) as? ReactModalHostView
      }.getOrNull() else null
      // React Native syncs the dialog's system bars from the activity on resume.
      // Apply the same visibility to both windows.
      for (window in listOfNotNull(activity.window, modal?.dialog?.window)) {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (hidden) {
          controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
          controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
          controller.show(WindowInsetsCompat.Type.systemBars())
        }
      }
    }
  }

  override fun invalidate() {
    setScreenViewerImmersive(0, false)
    setScreenViewerOrientation(false)
    super.invalidate()
  }
}
