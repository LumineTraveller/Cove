function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1)
    view.setUint8(offset + index, value.charCodeAt(index));
}

/** Encode a decoded AudioBuffer segment as a browser-playable PCM WAV file. */
export function encodeAudioBufferSegment(
  buffer: AudioBuffer,
  startSeconds: number,
  endSeconds: number,
): Blob {
  const start = Math.max(0, Math.floor(startSeconds * buffer.sampleRate));
  const end = Math.min(
    buffer.length,
    Math.max(start + 1, Math.ceil(endSeconds * buffer.sampleRate)),
  );
  const frameCount = Math.max(1, end - start);
  const channelCount = Math.max(1, Math.min(2, buffer.numberOfChannels));
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  const channels = Array.from({ length: channelCount }, (_, index) =>
    buffer.getChannelData(Math.min(index, buffer.numberOfChannels - 1)),
  );
  for (let frame = start; frame < end; frame += 1) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([output], { type: "audio/wav" });
}
