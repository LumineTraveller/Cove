'use strict';
const { sharedTexture, ipcRenderer } = require('electron');
let release;
const releasePermit = new Promise(resolve => { release = resolve; });
ipcRenderer.once('probe:release', () => release());
sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture: imported }, nonce) => {
  let frame, bytes;
  const result = { nonce, passed: false, stage: 'getVideoFrame', frameClosed: false };
  try {
    frame = imported.getVideoFrame();
    Object.assign(result, { width: frame.codedWidth, height: frame.codedHeight, format: frame.format, timestamp: frame.timestamp });
    if (frame.codedWidth !== 64 || frame.codedHeight !== 64 || frame.timestamp !== 1000) throw Error('frame_metadata_mismatch');
    result.stage = 'copyToRGBA';
    const options = { format: 'RGBA' };
    bytes = new Uint8Array(frame.allocationSize(options));
    const [layout] = await frame.copyTo(bytes, options);
    let mismatches = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const top = y < 32, left = x < 32, dy = y - 31;
      let r = left ? (top ? 255 : 0) : (top ? 0 : 255), g = left ? 0 : 255, b = left && !top ? 255 : 0;
      if ((x >= 12 && x <= 43 && Math.abs(dy) <= 2) || (x >= 42 && x <= 52 && Math.abs(dy) <= 52 - x)) r = g = b = 255;
      const offset = layout.offset + y * layout.stride + x * 4;
      if ([r, g, b, 255].some((value, channel) => Math.abs(value - bytes[offset + channel]) > 2)) mismatches++;
    }
    Object.assign(result, { stage: 'classified', mismatchedPixels: mismatches,
      classification: mismatches === 0 ? 'exact_four_quadrants_and_right_arrow' : 'channel_orientation_or_content_mismatch', passed: mismatches === 0 });
  } catch (error) { result.error = String(error); }
  finally {
    if (bytes) bytes.fill(0);
    if (frame) { frame.close(); result.frameClosed = true; }
    ipcRenderer.send('probe:classification', result);
    // Main permits release only after sendSharedTexture has registered its
    // renderer reference. A very fast receiver must not release ahead of that.
    await releasePermit;
    imported.release();
  }
});
ipcRenderer.send('probe:receiver-ready');
