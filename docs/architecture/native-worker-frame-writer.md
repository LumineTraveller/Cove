# Native frame Worker writer (experimental, default off)

This experiment moves only the existing Generator writable sink to a DedicatedWorker.
The Window retains the Generator track, MediaStream, publisher and stop ownership.
It transfers the unlocked writable once, directly to the final bundled module Worker;
the Worker cannot construct a Generator in the qualified Electron 44 runtime.

Enable only with `COVE_NATIVE_FRAME_SINK=worker` (performance runner:
`COVE_FPS_NATIVE_FRAME_SINK=worker`). The Electron/preload gate requires exactly
Electron 44.0.0 and native GPU BGRA. CPU NV12, Canvas and the default Generator
remain on their existing paths. No codec, bitrate, GPU pool or security policy changes.

## Ownership and bounds

- Worker readiness, first write and track settings share the original 1500 ms
  upgrade deadline. An unsupported Worker, transfer failure, cancellation or timeout
  leaves the already published stock stream intact.
- Window validates native session metadata before transferring the actual VideoFrame.
  There is no pixel readback, second capture or encoding chain. At most three frame
  acknowledgements can be outstanding, matching the unchanged GPU pool.
- The Worker reuses the one-active/one-latest queue and its two-frame-period expiry.
  It closes every received frame after writing, dropping or stopping. A per-sink
  generation and increasing sequence reject old, duplicate and malformed messages.
- A write ACK observes native sink acceptance, not encoding, sending, or GPU texture
  release. The preload permit and `allReferencesReleased` barriers still exclusively
  authorize GPU slot reuse. Worker metrics use its own clock and contain no pixels,
  source/session identifiers or credentials.
- Stop settles Window waiters synchronously, stops the Window-owned track and asks
  the Worker to abort/release its writer. A bounded termination fallback handles a
  stuck Worker without blocking stock fallback. Termination alone is never treated
  as an abort or proof that GPU references were released.
- A running sink error uses the existing native failure teardown. It does not
  automatically acquire a source, restart a session, or change media intent.

## Validation and remaining qualification

Deterministic CPU tests cover readiness failure, timeouts, cancellation, bounded
queueing, stale acknowledgements, write failure and stop while a write is pending.
Vite must emit the Worker as a separate bundled asset; dev and packaged `file://`
must both be checked with the real security settings before considering this usable.
The earlier CPU API probe proves writable/VideoFrame transfer in Electron 44 only;
it does not prove shared-texture transfer, performance, or end-to-end media stability.
One actual GPU/AV1/full-room-UI/SFU run has passed source pixels, advancing sequence,
1728x1080 output and complete resource cleanup (`full-ui-qualified-worker-av1-Cd3SEe`).
Its 12.393 s sample measured helper 119.05, write 114.74, encode 112.31 and decode
112.47 fps. The nearby default Generator run measured encode 117.90 fps with the
same requested policy; this does not establish a Worker performance benefit.
An earlier Worker run had a bandwidth limitation before the Worker was created and
encoded 576x360; it failed qualification and is not counted as an optimization.
Both-codec and repeated stop/start/recovery qualification remain incomplete.
Keep the Worker experimental and default off; do not enable it to claim 120 fps.

Rollback: remove the opt-in environment variable to use the existing Generator path.
No server or mobile protocol changes are required.

## Repeatable checks

Run the `test:native-screen-capture` desktop test entry for deterministic CPU
coverage, plus desktop and Electron type checks. The optional actual Electron CPU
smoke deliberately has no capture permissions, SDP, sockets or microphone. It uses
16×16 synthetic frames to check the **production bundled module**, not a Blob:

```powershell
# From the worktree root; no existing client is stopped.
node tooling/build-native-worker-smoke.cjs
node tooling/verify-native-worker-sink.cjs file

# Starts an owned ephemeral Vite origin and stops it after this smoke.
node tooling/verify-native-worker-sink.cjs dev
```

The smoke result is written under `runtime/native-worker-sink-smoke/<mode>-*/result.json`.
Passing it proves real writable/frame transfer, raw playback and bounded cleanup
with that loading mode. It does not prove GPU texture lifetime or performance.
The runner denies capture permissions and non-fixture network requests, retains
`sandbox`, `contextIsolation` and `webSecurity`, and owns only its isolated process.

Native qualification uses the existing `tooling/verify-screen-performance.cjs` with
`COVE_FPS_NATIVE_FRAME_SINK=worker` and qualified GPU BGRA settings. Compare identical
source geometry, codec, product UI, sender/receiver and test duration to Generator.
Do not infer success from helper capture or write ACK rate: check actual encoded,
received/decoded, displayed unique frame counts, source age, startup and broker
resource release. Report both codecs and stop/restart/recovery separately.

## Runtime basis

The qualified Chromium implementation exposes the Generator on Window and provides
a [native writable transfer optimizer](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.54/third_party/blink/renderer/modules/breakout_box/media_stream_video_track_underlying_sink.cc).
The received sink pushes the same source broker; write completion is not encoder
completion. Electron's [context bridge special case](https://raw.githubusercontent.com/electron/electron/v44.0.0/shell/renderer/api/electron_api_context_bridge.cc)
rewraps the VideoFrame; it does not require copying pixels. Neither fact removes
RGB conversion, GPU synchronization or the source's texture-release contract.

## Local CPU/packaging checkpoint (2026-10-29)

- Native regression entry: 393 TypeScript tests plus 31 preload/IPC tests pass.
  Full output: `runtime/native-worker-sink-smoke/native-regression.log`.
- Desktop and Electron `tsc --noEmit` pass; desktop production build passes and
  emits `dist/assets/nativeFrameWorker-CtvyGVgu.js` (4.62 kB). Build output:
  `runtime/native-worker-sink-smoke/product-build.log`.
- Actual hidden Electron CPU fixtures pass in both built file and dev mode:
  `runtime/native-worker-sink-smoke/file-QCIDp5/result.json` and
  `runtime/native-worker-sink-smoke/dev-QDKkAN/result.json`. Each transferred the
  writable and two real CPU VideoFrames, played the original Window track with
  expected RGBA `[32,144,224,255]`, then ended the track/stopped Worker with zero
  pending ACKs. No capture permissions or peer connection were used.
- Independent static review found no confirmed blocker. Shared-texture GPU
  transfer, full product UI/SFU performance, codecs and recovery are **not yet
  qualified** by this checkpoint; the feature remains explicitly opt-in.
