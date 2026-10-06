package com.covemobile

import org.junit.Assert.assertEquals
import org.junit.Test

class KeyboardFrameTest {
  @Test fun removesStatusBarOffsetToMatchFabricMeasurement() {
    assertEquals(KeyboardFrame(true, 1710, 1310, 1264),
      keyboardFrame(true, 3120, 1810, 1810, 100, 0, 1264))
  }
  @Test fun insetsIncludeToolbarEvenWhenVisibleFrameIsTooLow() {
    assertEquals(KeyboardFrame(true, 1710, 1310, 1264),
      keyboardFrame(true, 3120, 1810, 1930, 100, 0, 1264))
  }
  @Test fun resizedViewportIsNotSubtractedTwice() {
    assertEquals(1710, keyboardFrame(true, 3120, 1810, 1810, 100, 0, 1264).top)
  }
  @Test fun legacyAndroidUsesVisibleFrameWithoutSubtractingInsetsAgain() {
    assertEquals(1710, keyboardFrame(true, 3120, null, 1810, 100, 0, 1264).top)
  }
  @Test fun accountsForWindowOriginAndHiddenKeyboard() {
    assertEquals(540, keyboardFrame(true, 1200, 900, 900, 240, 120, 600).top)
    assertEquals(KeyboardFrame(false, 0, 0, 600), keyboardFrame(false, 1200, null, 1200, 240, 120, 600))
  }
}
