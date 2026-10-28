# Native GPU screen capture adapter

This increment starts from `f315aa5` on `codex/native-gpu-capture`. It keeps the
existing codec policy, RTP parameters, SFU protocol, audio bridge and remote-control
intent. The installed application and release channels are not changed.

Current measured status and test boundaries are recorded in
[the 2026-10-29 qualification](native-screen-capture-qualification-20261029.md).
The selected acceptance path is direct GPU BGRA to the existing Generator.
GPU NV12 is rejected before acquisition; Canvas remains a disabled research
route. Historical experiments below are not release qualification.

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

## Experimental renderer handoff (not a release qualification)

Acquisition, imported-texture ownership, renderer conversion, and publication
remain separate responsibilities. The helper/controller own the three native
slots. Preload preserves transfer/release-permit/all-references barriers. The
renderer frame sink owns only its conversion and writer work. The publisher
still owns the stock-to-native replaceTrack transaction and stock retirement.
No second Producer, encoder, audio output or remote-control grant is created.

The explicitly opted-in Electron 44 Canvas experiment uses a private **detached**
Canvas as a conversion surface. It is not a UI preview and must not be appended
to the page. Actual finite tests found a substantial difference: an attached
Canvas in a hidden/minimized test window stalled for about one second per
admission; the otherwise identical detached surface delivered the fixed
serial 11--110 window at 120.131 unique frames/s at 1728x1080. Native references
and test processes drained. This identifies an avoidable Canvas/compositor
coupling; it does not prove a specific Chromium internal defect or Cove FPS.

The Canvas track connects only to its private Processor. Its initial black
capture is consumed before native admission. One strictly newer output timestamp
can complete one admitted draw; old/duplicate outputs cannot create credits.
Only one Canvas request and one replaceable waiting input are retained. A
MessageChannel task spends an existing admission credit; it is not a frame
timer. Pixel sequence markers belong only to the synthetic fixture, never to
product frames or product completion detection.

Passing Canvas GPU-backed output straight into the generator is not qualified:
the first actual Cove/SFU attempt (`1080-canvas-detached-av1-OUoWn7`) committed
the source replacement but then hit a completion deadline. No performance pass
or FPS result is attributed to that run. Independent CPU pixel storage before
the writer has since been tested without enlarging native pools or weakening
reference barriers. It does not alone resolve the observed capture stall.
Timestamp-only `new VideoFrame(old, {timestamp})`
changes Blink's handle timestamp in the pinned runtime; it does not retime the
underlying native media frame. A CPU-buffer constructor gives that timestamp
an independent native-frame representation.

The experimental preload preference requires an exact launch flag, native
support and Electron 44.0.0. The route additionally requires GPU BGRA input and
the already-selected AV1/BT709 contract. CPU/VP8/BT601 and unknown contracts keep
their existing writer. No security, cross-origin isolation, codec, bitrate,
degradation or geometry policy is broadened. Unsupported startup still retains
the published stock source; post-commit faults use the existing sharing teardown.
Actual minimized-window, cancellation and end-to-end validation is required
before this experiment can be considered for a test package.

### Capture notification timing in the pinned browser

The actual module, freshly transpiled by the isolated `product` control, wrote
118 distinct, pixel-verified synthetic GPU inputs at about 120 output frames/s
(`product-chXZpN`). This control has no desktop capture or SFU, starts its source
after prime, and adds a separate CPU validation copy before the real Generator
write. It is not a Cove throughput pass. The ordinary hidden Cove peer still
failed (`1080-canvas-snapshot-av1-M5bjlq`): 17 native inputs, six Canvas draws,
one prime plus five delivered outputs, five completed copies/writes, and no
duplicate/regressed output. The sixth draw timed out waiting for capture.
An unpublished stock clone retained only at stock retirement did not prevent
the stall (`1080-canvas-stockalive-late-av1-HaPzzK`, six writes then timeout).
All owned resources drained after these failed runs.

Chromium 152.0.7977.54 has a specific notification gate:

- [`limits.h:58`](https://github.com/chromium/chromium/blob/152.0.7977.54/media/base/limits.h#L58)
  defines `kMaxFramesPerSecond=1000`.
- [`AutoCanvasDrawListener`](https://github.com/chromium/chromium/blob/152.0.7977.54/third_party/blink/renderer/modules/mediacapturefromelement/auto_canvas_draw_listener.cc#L20)
  records callback creation time, rejects a new request less than 1 ms later,
  and implements `RequestFrame` as a flag assignment without a delayed retry.
- `captureStream(0)` uses `OnRequestCanvasDrawListener`, which inherits that
  gate. [`NotifyListenersCanvasChanged`](https://github.com/chromium/chromium/blob/152.0.7977.54/third_party/blink/renderer/core/html/canvas/html_canvas_element.cc#L1012)
  returns when no listener currently needs a frame.

Consequently an output-credit-driven sink must not immediately draw a pending
input merely because copy/write settled quickly: a skipped notification has no
output to return its next credit. A browser-boundary admission gap of 2 ms from
the previous actual Processor delivery (including prime), checked again against
the monotonic clock at dispatch, is the focused control. It creates no frame,
request or replacement credit, and must be canceled with the owned MessageChannel
task/timer. The existing pending age and active completion deadline are retained.
The 2 ms gap is below the requested 120 FPS period; it is not an FPS increase or
a substitute for actual desktop/encoder/receiver measurements. This mechanism
is established in source; matching the observed stall still requires the
single-variable full-chain control.

The first 2 ms-gap control (`1080-canvas-gap2-av1-pn8fc1`) still timed out
after five writes. The gate therefore did not resolve the observed primary
stall. A separate observer control, with that exact module unchanged, skipped
the test runner's live `app.getGPUInfo('complete')` call immediately after the
source replacement. `1080-canvas-no-live-gpu-info-av1-YIf8d8` then passed a
12.349 s sample at 1728x1080, with the stock track stopped, no extra stock clone,
no diagnostic pixel flush, valid owned pixels and zero cleanup resources.
Its helper rate was 115.87/s, renderer receive 117.34/s, actual write 89.72/s,
media-source/encode 89.57/s and decode 89.43/s. These are different measurement
intervals/boundaries; this is not a 120 FPS result or an improvement over the
already qualified CPU delivery route.

Full GPU enumeration is an intrusive observer in this runtime: Electron's
[`FetchCompleteInfo`](https://github.com/electron/electron/blob/v44.0.0/shell/browser/api/gpuinfo_manager.cc#L52)
requests Dawn collection on the existing GPU service's main runner.
[`CollectDawnInfo`](https://github.com/chromium/chromium/blob/152.0.7977.54/components/viz/service/gl/gpu_service_impl.cc#L1405)
enumerates adapters and creates devices synchronously; Chromium explicitly
pauses its watchdog because driver loading may be slow. It can delay both
capture completion and release-fence callbacks. A returned enumeration promise
does not establish that every requested GPU collection operation has drained.
The fixture now keeps complete enumeration out of active measured capture by
default; startup basic GPU metadata remains. `COVE_FPS_LIVE_GPU_INFO=1` preserves
the explicit observer control. Earlier failed runs remain evidence of their
exact configuration, not proof that the product route intrinsically stalls.
