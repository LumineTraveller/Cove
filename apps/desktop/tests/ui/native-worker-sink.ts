import { createNativeWorkerFrameSink } from '../../src/features/media/screen/nativeWorkerFrameSink';

type GeneratorTrack = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
const state = globalThis as typeof globalThis & {
  MediaStreamTrackGenerator?: new (options: { kind: 'video' }) => GeneratorTrack;
  coveWorkerSmokeResult?: unknown;
};

/** CPU tiny-frame API/packaging smoke only. No desktop, microphone, peer or socket. */
async function run() {
  const Generator = state.MediaStreamTrackGenerator;
  if (!Generator) throw new Error('generator_unavailable');
  const track = new Generator({ kind: 'video' });
  const video = document.getElementById('preview') as HTMLVideoElement;
  const writes: { writeMs: number; queueAgeMs: number; idleMs: number }[] = [];
  const failures: string[] = [];
  const sink = createNativeWorkerFrameSink({
    writable: track.writable, width: 16, height: 16, fps: 120, startupTimeoutMs: 1500,
    onWritten: timing => writes.push(timing), onDropped() {}, onFailure: reason => failures.push(reason),
  });
  let sent = 0;
  let interval: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let callback = 0;
  let detached = true;
  try {
    await sink.ready;
    const writableTransferred = track.writable.locked;
    if (!writableTransferred) throw new Error('writable_not_transferred');
    video.srcObject = new MediaStream([track]);
    const playing = video.play();
    const raw = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < raw.length; i += 4) { raw[i] = 32; raw[i + 1] = 144; raw[i + 2] = 224; raw[i + 3] = 255; }
    const presented = new Promise<void>((resolve, reject) => {
      callback = video.requestVideoFrameCallback(() => resolve());
      deadline = setTimeout(() => reject(new Error('raw_playback_timeout')), 2000);
    });
    async function send() {
      const next = new VideoFrame(raw, { format: 'RGBA', codedWidth: 16, codedHeight: 16, timestamp: ++sent * 8333 });
      try {
        const submitted = sink.submit(next);
        detached = detached && next.displayWidth === 0;
        await submitted;
      }
      finally { next.close(); }
    }
    const first = send();
    // Test-only repeated tiny frames let an initially starting HTMLVideoElement
    // present; real source ownership/credit is covered by the native tests.
    interval = setInterval(() => { void send().catch(() => {}); }, 20);
    await Promise.all([first, playing, presented]);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas_unavailable');
    context.drawImage(video, 0, 0, 16, 16);
    const pixel = [...context.getImageData(8, 8, 1, 1).data];
    const playback = pixel.slice(0, 3).every((value, index) => Math.abs(value - [32, 144, 224][index]) <= 5);
    if (!playback || !writes.length || failures.length || !detached) throw new Error('raw_playback_mismatch');
    clearInterval(interval); interval = undefined;
    track.stop(); sink.stop();
    // Observe bounded teardown without assuming track.stop means worker closed.
    const until = performance.now() + 500;
    while (sink.snapshot().state !== 'stopped' && performance.now() < until)
      await new Promise(resolve => setTimeout(resolve, 10));
    const snapshot = sink.snapshot();
    if (snapshot.state !== 'stopped' || snapshot.pending !== 0) throw new Error('cleanup_incomplete');
    return { ok: true, writableTransferred, rawPlayback: playback,
      frameDetached: detached, trackEnded: track.readyState === 'ended',
      writes: writes.length, failures, snapshot, pixel };
  } finally {
    if (interval !== undefined) clearInterval(interval);
    if (deadline !== undefined) clearTimeout(deadline);
    if (callback) video.cancelVideoFrameCallback(callback);
    track.stop(); sink.stop(); video.pause(); video.srcObject = null;
  }
}
void run().then(result => { state.coveWorkerSmokeResult = result; }, error => {
  state.coveWorkerSmokeResult = { ok: false, reason: error instanceof Error ? error.message : 'unknown' };
});
