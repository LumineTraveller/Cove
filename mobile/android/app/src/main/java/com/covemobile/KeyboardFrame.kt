package com.covemobile

internal data class KeyboardFrame(val visible: Boolean, val top: Int, val height: Int, val width: Int)

// Fabric measureInWindow uses window coordinates with visibleFrame.top removed
// (React Native RootViewUtil.getViewportOffset), not absolute screen coordinates.
internal fun keyboardFrame(
  visible: Boolean,
  windowBottom: Int,
  imeTop: Int?,
  visibleBottom: Int,
  visibleTop: Int,
  windowScreenY: Int,
  width: Int,
): KeyboardFrame {
  if (!visible) return KeyboardFrame(false, 0, 0, width)
  val screenTop = if (imeTop != null) minOf(imeTop, visibleBottom) else visibleBottom
  return KeyboardFrame(true, screenTop - windowScreenY - visibleTop,
    (windowBottom - screenTop).coerceAtLeast(0), width)
}
