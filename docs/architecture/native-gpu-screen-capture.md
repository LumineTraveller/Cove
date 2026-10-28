# Native GPU screen capture adapter

This increment starts from `f315aa5` on `codex/native-gpu-capture`. It keeps the
existing codec policy, RTP parameters, SFU protocol, audio bridge and remote-control
intent. The installed application and release channels are not changed.

## Availability and rollback

The first integration is an isolated opt-in candidate. The existing Chromium
capturer remains the normal path and is also the startup fallback. Opt-in is
enabled only by the native capture test build or `COVE_NATIVE_GPU_CAPTURE=1`;
`COVE_DISABLE_NATIVE_GPU_CAPTURE=1` takes precedence. No unsupported Chromium
flags or operating-system changes are involved.

Initial eligibility is Windows x64, tested Electron 44 shared-texture APIs,
one physical display, the actual stock-selected primary monitor, SDR landscape,
validated source dimensions, and preset mode. Native-resolution, other displays,
window capture, unsupported formats or unavailable APIs continue through stock.
The automatic upgrade is limited to the 60/120 FPS selections. The matched
30 FPS experiment did not establish a consistent CPU benefit, so 30 FPS keeps
the already sufficient stock path. The provider's direct diagnostic API still
accepts 30 FPS; normal publishing does not start it at that setting.
The helper independently checks its source. It cannot select another monitor to
make initialization succeed.

## Stock-first transaction

1. Invoke the existing `getDisplayMedia` synchronously in the user's operation.
   It supplies both the established source selection and a live fallback stream.
2. Complete the original stock `produce` / `replaceTrack` transaction first.
   Sharing becomes usable through the established path without waiting for
   native initialization. If eligible, start one bounded background acquisition.
   Cancellation, stock ending, bad metadata, timeout or no valid first frame
   releases only native resources and keeps the published stock stream.
3. Serialize native `replaceTrack` in the existing settings commit queue, using
   the same Producer. Keep stock live until replacement succeeds and ownership
   is rechecked. A superseded in-flight replacement rolls back to stock before
   the next settings commit. No second `produce`, Consumer or standby is added.
4. Stop, source update, leave, producer closure and renderer destruction own
   idempotent capture-session cancellation, including uncommitted fallback
   tracks, helper, writer and imported frames. Late events belong only to their
   old session and cannot stop or revive another publication.

After a committed native helper fails, the adapter ends that track so existing
sharing teardown revokes control and clears publication state. It does not
restart capture or leave voice. Native is disabled for subsequent retries in
that application session, so the user's retry uses stock. No automatic control
grant or cancelled intent is restored.

## Data and resource path

The diagram and GPU release barrier below describe the original protocol-2 BGRA
provider. The later, explicitly selected CPU NV12 experiment uses a different
ownership boundary; see [throughput investigation](../diagnostics/native-throughput-20261028.md).
It performs full-frame readback and CPU IPC copies. Neither route changes codec
selection or RTP settings. Experimental NV12 modes are not enabled in a normal build.

```text
DXGI primary-monitor texture + cursor metadata
  -> GPU cursor composition and area/box downscale
  -> three fixed shared BGRA texture slots
  -> main import / sandbox preload / VideoFrame
  -> video track / existing publisher / existing encoder and SFU
```

For the original GPU-texture route, only small protocol metadata and cursor-shape data enter CPU-side queues; there
is no per-frame full-size readback, image serialization, base64 or pixel pipe.
The helper exports only its own local NT handle values. A small main-process
N-API resource owner duplicates a handle from the verified live child, owns the
temporary main handle synchronously, and closes it after Electron imports its
own copy. A helper crash between protocol messages cannot orphan an unknown
handle in main. The close operation is idempotent and has a GC finalizer.

Each frame carries request/session, slot, sequence and monotonic timestamp. A
slot returns to the helper only after the matching `allReferencesReleased`,
which includes downstream frame/encoder references. Transfer completion, writer
completion or a timeout never authorizes slot reuse. Main and preload keep a
per-frame transfer/release barrier. Backpressure drops an opportunity to capture;
it does not grow a queue or overwrite a texture still in use.

Desktop and pointer updates are distinct from bounded idle refresh. A refresh
keeps late join / keyframe / unpause functional while the desktop is static;
refreshes are labelled and excluded from unique-capture performance claims.
`WAIT_TIMEOUT` is normal idle, not a failure. Device/access loss, changed
format/geometry or unsupported cursor state retire the session safely.

## Encoding semantics and verification

Generator defaults differ from display sources. Preserve the existing `motion`
or `detail` content hint before publication, and retain sender degradation,
codec/Fmtp, bitrate and scalability settings. At the locked WebRTC revision,
these hints also override the sending `is_screencast` option. Zero-hertz source
refresh capability is separate, so the adapter supplies explicit bounded refresh.

Verification must compare actual stock/native capture, encode, send, receive and
decode counters, dimensions, content type and encoder implementation. It must
also cover first-frame/publication failure, queue cancellation, late release,
stop/leave, helper/renderer/GPU loss, static late join, rapid repeated sharing,
cursor formats and final zero owned resources. Native-only or one-frame interop
results are prerequisites, not end-to-end acceptance. Unavailable hardware or
display scenarios remain on stock rather than being labelled tested.

## Module ownership and extension

- `native-screen-capture-helper.cpp`: selected monitor, cursor, GPU area scaling,
  pacing and the three-slot pool. It has no encoder, room, microphone or socket.
- `native-screen-handles.cpp`: stable N-API ownership of one verified child
  process and each temporary imported handle. No raw close operation is exposed.
- `native-screen-capture.ts` in Electron: validates protocol 2, bounds sessions,
  owns helper/imports/watchdogs and returns credits only after downstream release.
- `nativeScreenCapture.ts` in the renderer: turns frames into a disposable
  capture candidate. Its stream/stop contract follows `CaptureSession<TStream>`;
  commit only ends preparation cancellation, not the stock source itself.
- `nativeScreenUpgrade.ts`: acquires outside the commit queue and serializes
  replacement/rollback. It checks current stock geometry, which can settle after
  the initial `getDisplayMedia` response, without altering RTP parameters.
- `useScreenPublishing.ts`: continues owning user intent, producer and audio.
  New providers should implement the candidate boundary, not another media hook
  or competing reconnect state machine.

Generator settings also settle asynchronously after its first write. The
startup-only 5 ms check stays inside the original 1500 ms total deadline, closes
frames immediately and is cancelled on teardown. It is not a per-frame delay.

Renderer/receiver faults use two fixed fault-stop codes. They disable native
for the application session. Ordinary stop, superseded preparation and old
request callbacks do not disable a newer session. Request IDs are never reused.

## Local build and validation

```powershell
npm run native-screen-capture:build -w cove-client
npm run electron:compile -w cove-client
npm run test:native-screen-capture -w cove-client
& .\tooling\native-screen-capture\validation\run.ps1
```

The optional native build uses an existing x64 MinGW compiler and cached N-API
headers; it never installs or downloads a toolchain. Normal builds/CI retain
stock and run the pure native lifecycle tests without compiling a C++ binary.
The synthetic validation uses small staging readback only to compare test pixels,
never as a production capture path.

For actual local SFU measurements, compile Electron first and run
`tooling/verify-screen-performance.cjs` with `COVE_FPS_NATIVE_GPU=0` and `1`
in separate runs. Keep identical cases, features, dimensions and codec contracts.
`COVE_FPS_NATIVE_LIFECYCLE_CHECKS=1` adds the bounded single-monitor 540p120
static-viewer, six settings changes, owned-helper failure and manual stock retry
sequence. It records whether the no-desktop-present heartbeat branch actually
ran; `COVE_FPS_REQUIRE_IDLE_REFRESH=1` makes lack of that branch a test failure.
Freezing owned pixels alone does not force DWM to stop presenting a desktop.

The existing diagnostic export now includes aggregate native capture counters.
Received/written/busy-drop counts and write wall time distinguish the provider
from WebRTC media-source/encoded/decoded counts. Requested or nominal
`getSettings().frameRate` is not measured capture FPS. Main diagnostics retain
fixed failure codes and resource counts, never handles, pixels, tokens or SDP.
Performance CPU accounting includes the native helper; it does not label GPU
execution time, SFU CPU or a whole-device total as measured.

After successful frontend/native builds, `node tooling/package-native-capture-lab.cjs`
creates a fresh portable Windows folder under `runtime/`, with an independent
app ID/profile and disabled formal update/repair channels. `Start-Native.cmd`
opts in; `Start-Stock.cmd` rolls back this launch after the lab is closed.
Neither launcher installs anything or changes the formal Cove application.
Source rollback is `f315aa5`; the branch has not been pushed or published.
