'use strict';

// Run on the isolated viewer before mediasoup adds its video receiver.
function observeAv1SequenceHeaders() {
  const evidence = [];
  window.coveAv1SequenceEvidence = () => evidence.slice();
  if (!globalThis.RTCRtpScriptTransform) return false;

  function inspect() {
    function sequenceHeader(data) {
      const bytes = new Uint8Array(data);
      let cursor = 0;
      for (let unit = 0; unit < 12 && cursor < bytes.length; ++unit) {
        const header = bytes[cursor++];
        if (header & 0x81) return null;
        const type = (header >> 3) & 15;
        if (header & 4) cursor++;
        let size = bytes.length - cursor;
        if (header & 2) {
          size = 0;
          for (let shift = 0; ; shift += 7) {
            if (shift > 21 || cursor >= bytes.length) return null;
            const part = bytes[cursor++];
            size += (part & 127) * 2 ** shift;
            if (!(part & 128)) break;
          }
        }
        if (size > bytes.length - cursor) return null;
        // Retain a fingerprint of codec configuration only, never picture data.
        if (type === 1 && size > 0 && size <= 256) {
          let hash = 2166136261;
          for (let i = cursor; i < cursor + size; ++i) hash = Math.imul(hash ^ bytes[i], 16777619);
          return { sequenceBytes: size, sequenceHash: hash >>> 0 };
        }
        cursor += size;
      }
      return null;
    }
    self.onrtctransform = event => {
      let ordinal = 0, retained = 0;
      event.transformer.readable.pipeThrough(new TransformStream({
        transform(frame, controller) {
          ordinal++;
          if (retained < 64) {
            const configuration = sequenceHeader(frame.data);
            if (configuration || frame.type === 'key' || ordinal <= 3) {
              self.postMessage({ ordinal, keyFrame: frame.type === 'key', ...configuration });
              retained++;
            }
          }
          controller.enqueue(frame);
        },
      })).pipeTo(event.transformer.writable).catch(() => {});
    };
  }

  const url = URL.createObjectURL(new Blob([`(${inspect.toString()})()`], { type: 'text/javascript' }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  worker.onmessage = event => {
    if (evidence.length < 64) evidence.push(event.data);
  };
  const Connection = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Connection {
    constructor(configuration) {
      super(configuration);
      this.addEventListener('track', ({ track, receiver }) => {
        if (track.kind === 'video' && !receiver.transform) receiver.transform = new RTCRtpScriptTransform(worker);
      });
    }
  };
  window.addEventListener('pagehide', () => worker.terminate(), { once: true });
  return true;
}

module.exports = { observeAv1SequenceHeaders };
