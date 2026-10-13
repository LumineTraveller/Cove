package com.covemobile

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.*
import org.junit.Test

class SoundpackFilesTest {
  @Test fun downloadStaysInCurrentServerSoundResourcesAndRetainsAuthorizationQuery() {
    val base = "https://synthetic.test/cove/"
    val allowed = soundpackDownloadUrl("https://synthetic.test/cove/sounds/original.mp3?access_token=synthetic", base)!!
    assertEquals("synthetic", allowed.queryParameter("access_token"))
    assertNotNull(soundpackDownloadUrl("http://10.0.2.2:3301/sounds/local.wav", "http://10.0.2.2:3301"))
    for (value in listOf("https://other.test/cove/sounds/x.mp3", "http://synthetic.test/cove/sounds/x.mp3",
      "https://synthetic.test:444/cove/sounds/x.mp3", "https://user:password@synthetic.test/cove/sounds/x.mp3",
      "https://synthetic.test/cove/uploads/x.mp3", "https://synthetic.test/sounds/x.mp3",
      "https://synthetic.test/cove/sounds/a/b.mp3", "https://synthetic.test/cove/sounds/a%2Fb.mp3",
      "https://synthetic.test/cove/sounds/a%5Cb.mp3", "https://synthetic.test/cove/sounds/../secret", "https://synthetic.test/cove/sounds/x#fragment")) {
      assertNull(value, soundpackDownloadUrl(value, base))
    }
  }

  @Test fun boundedCopyRejectsEmptyOversizeAndCancellationIncludingUnknownLength() {
    val output = ByteArrayOutputStream()
    assertEquals(4, copySoundpackBytes(ByteArrayInputStream(byteArrayOf(1, 2, 3, 4)), output) { false })
    assertArrayEquals(byteArrayOf(1, 2, 3, 4), output.toByteArray())
    assertThrows(IllegalStateException::class.java) { copySoundpackBytes(ByteArrayInputStream(ByteArray(0)), output) { false } }
    assertThrows(IllegalStateException::class.java) { copySoundpackBytes(ByteArrayInputStream(ByteArray(MAX_SOUNDPACK_BYTES + 1)), ByteArrayOutputStream()) { false } }
    var checks = 0
    assertThrows(IllegalStateException::class.java) {
      copySoundpackBytes(ByteArrayInputStream(ByteArray(65536)), ByteArrayOutputStream()) { ++checks > 1 }
    }
  }

  @Test fun wavPreservesSamplesWithCorrectStereoRateLengthAndHeader() {
    val pcm = byteArrayOf(0, 0, -1, 127, 0, -128, 0, 0)
    val wav = soundpackWav(pcm, 48000, 2)
    val header = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
    assertEquals("RIFF", String(wav.copyOfRange(0, 4)))
    assertEquals("WAVE", String(wav.copyOfRange(8, 12)))
    assertEquals(44, header.getInt(4)); assertEquals(2, header.getShort(22).toInt())
    assertEquals(48000, header.getInt(24)); assertEquals(192000, header.getInt(28))
    assertEquals(4, header.getShort(32).toInt()); assertEquals(16, header.getShort(34).toInt())
    assertEquals(8, header.getInt(40)); assertArrayEquals(pcm, wav.copyOfRange(44, wav.size))
    assertThrows(IllegalArgumentException::class.java) { soundpackWav(byteArrayOf(0), 48000, 2) }
    assertThrows(IllegalArgumentException::class.java) { soundpackWav(pcm, 48000, 3) }
    assertThrows(IllegalArgumentException::class.java) { soundpackWav(ByteArray(MAX_SOUNDPACK_BYTES), 48000, 2) }
  }

  @Test fun rangeGuardsRejectNaNReverseAndOutOfBoundsButKeepOriginalFullSelection() {
    assertEquals(0.0 to 1.5, validateSoundpackRange(0.0, 0.0, 1.5))
    assertEquals(0.25 to 0.75, validateSoundpackRange(0.25, 0.75, 1.5))
    for ((start, end) in listOf(Double.NaN to 1.0, -1.0 to 1.0, 1.0 to 1.0, 0.0 to 2.0, 0.0 to Double.POSITIVE_INFINITY)) {
      assertThrows(IllegalArgumentException::class.java) { validateSoundpackRange(start, end, 1.5) }
    }
  }

  @Test fun downloadNamesCannotInterpretPathsOrControlCharacters() {
    assertEquals("测试_.mp3", safeSoundpackFilename("测试/.mp3"))
    assertEquals("Cove-soundpack.audio", safeSoundpackFilename(" .. "))
    assertFalse(safeSoundpackFilename("../test\n.mp3").contains('/'))
    assertFalse(safeSoundpackFilename("test\r.mp3").contains('\r'))
  }

  @Test fun textDocumentsUseUtf8ByteLimitAndOnlyJsonOrTextNames() {
    val (filename, bytes) = soundpackTextDocument("测试", "诊断.json")
    assertEquals("诊断.json", filename); assertEquals(6, bytes.size)
    assertEquals("测试", String(bytes, Charsets.UTF_8))
    assertThrows(IllegalArgumentException::class.java) { soundpackTextDocument("x", "diagnostic.apk") }
    assertThrows(IllegalArgumentException::class.java) { soundpackTextDocument("", "diagnostic.json") }
    assertThrows(IllegalArgumentException::class.java) { soundpackTextDocument("x".repeat(1024 * 1024 + 1), "diagnostic.txt") }
    assertThrows(IllegalArgumentException::class.java) { soundpackTextDocument("测".repeat(400000), "diagnostic.json") }
  }
}
