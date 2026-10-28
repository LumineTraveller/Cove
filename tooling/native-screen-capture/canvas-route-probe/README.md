# Finite GPU → CanvasCapture qualification probe

Tooling only. This does not modify Cove capture, transport, codec, bitrate,
quality, CSP, or product security settings. No desktop is read. The source is
the existing synthetic BGRA D3D texture helper with changing pixel sequence bits.

From the repository root, CPU-only checks:

```powershell
node tooling/native-screen-capture/canvas-route-probe/run.cjs --check --stage mechanism
node --test --test-isolation=none tooling/native-screen-capture/canvas-route-probe/probe.test.cjs tooling/native-screen-capture/canvas-route-probe/bootstrap.test.cjs tooling/native-screen-capture/canvas-route-probe/bounded.test.cjs
```

Explicit GPU runs, serially after coordinating GPU ownership:

```powershell
node tooling/native-screen-capture/canvas-route-probe/run.cjs --stage mechanism --helper runtime/nv12-shader-probe/readback-helper-hires.exe
node tooling/native-screen-capture/canvas-route-probe/run.cjs --stage paced --helper runtime/nv12-shader-probe/readback-helper-hires.exe
node tooling/native-screen-capture/canvas-route-probe/run.cjs --stage bounded --helper runtime/nv12-shader-probe/readback-helper-hires.exe
```

Use the explicitly built high-resolution stream fixture for throughput work.
Omitting `--helper` intentionally retains the original
`runtime/nv12-shader-probe/readback-helper.exe` comparison binary. Its legacy
GPU-completion `Sleep(1)` and command-poll `Sleep(2)` waits can starve the Canvas
input on this Windows timer configuration. The high-resolution fixture changes
only the synthetic source's local waits; it does not change Windows timer policy
or Cove capture. A helper filename alone supplies no throughput evidence: inspect
the recorded input cadence, missing-source ticks, unique output cadence, and
binary/source hashes for that run.

`mechanism` is 64×64 / 24 real source frames. It establishes API/format/color/
lease behavior only. `paced` is 1728×1080 / 120 real source frames. Both offer
at most one ready source per actual native 120 Hz high-resolution waitable timer
I/O tick. The three initial source frames are prefilled by the existing helper;
this is recorded separately and is not a claim of native production at 120 Hz.
Skipped/coalesced native ticks and missing source-at-tick events remain visible.
No Node 8 ms timer creates frame credits. Each stage has at most 120 input frames,
three native source leases, a 23 s case deadline, and a parent watchdog at 28.5 s.
Cleanup runs before the parent forcibly terminates its owned process tree.

The probe reuses the selected existing synthetic readback helper, the verified
native child handle bridge, the existing compiled product preload, and
`runtime/cpu-frame-socket-probe/pacer.exe`; it adds no helper protocol, dependency,
device install, or product change. Runtime artifacts live beneath
`runtime/canvas-route-probe/`. Every run records dependency source/binary SHA-256.
The original helper sources are never edited or copied by this tool.

Bootstrap diagnostics are created **before** the owned Electron child starts:
`result.json` supplies a failed-by-default scaffold, and `launch.json` records
the launcher PID, owned child PID, entry handshake, exit, watchdog, and log byte
counts. Electron dispatch checks `process.versions.electron` explicitly even
when Electron's CommonJS entry has `require.main !== module`. The child writes
its main PID and phase before configuring Electron; both early bootstrap errors
and errors in the main try retain a fixed `errorCode`. The launcher captures
`electron-stdout.log` and `electron-stderr.log`, capped at 64 KiB each while
continuing to drain both pipes. It records no inherited environment values and
removes `NODE_OPTIONS`, `NODE_PATH`, and `ELECTRON_RUN_AS_NODE` case-insensitively
from the child's environment. Parent environment values remain unchanged.

The first mechanism attempt `mechanism-eVJpc7` timed out before writing a result
or profile. Its empty directory and external `gpu-canvas-mechanism.log` remain
untouched. That attempt predates the explicit Electron entry dispatch and
bootstrap evidence above; it supplies no Canvas/GPU route result.

The original-helper runs `mechanism-oaHK9k` and `paced-FtGAkr` passed finite
mechanism/color/lifetime/cleanup checks. They observed 23/24 and 118/120 unique
source serials respectively. The paced run delivered only 63.756 input FPS and
65.279 unique output FPS, with 105 missing-source ticks. Its native pacer I/O ran
at 119.997 Hz with zero native skipped phases or coalesced I/O ticks. This is
source-starved evidence, and does not establish a Canvas limit near 65 FPS or
qualify 1080p120. The paced raster is 1728×1080; it does not qualify 1920×1080.
`passed:true` means the finite mechanism checks passed; it is not a throughput
acceptance flag. These artifacts remain unchanged for comparison.

The frozen high-resolution helper (`2f1b5e4dd6c76632b58bfcb84a97162399d435e85ba16fd89975f69dad522e24`)
subsequently passed `mechanism-1ceIF2` and `paced-hg9YCb`. The latter observed
118/120 unique outputs, missing serials 3 and 117. Whole-run input/output rates
were 114.258/120.868 FPS, affected by startup. The fixed serial 11–110 window
contained 100 inputs and 100 distinct outputs at 120.015 FPS, with no missing or
duplicate serials in that window. Raw NV12/709 color error was at most one code;
all 120 native leases reached the original allRefs barrier and cleanup cleared
owned resources. This demonstrates that this finite synthetic route can carry
120 distinct frames per second after startup. It remains synthetic 1728×1080
evidence, and supplies no real Cove, 1920×1080, sustained-memory, or RTP result.

The page is an owned token-protected loopback HTTP document with **no COOP,
COEP, CORP, SAB exception flag, or cross-origin isolation**. Electron 44 runs
with sandbox/contextIsolation/webSecurity true, nodeIntegration false, an owned
window (hidden by default), and the existing product preload. All external requests and permissions
are denied. `--check` does not load Electron or start native processes.

The renderer uses Canvas2D `{alpha:false, willReadFrequently:false}` and a same
size 1:1 `drawImage`. Within each real input callback it calls `requestFrame()`
before the draw on `captureStream(0)`. It then closes the JavaScript source
VideoFrame. This is **not** a native slot release: source reuse still requires
the original Electron `allReferencesReleased` callback, settled main transfer,
main import release, renderer release permit, and native imported ACK. Source
lease lifetime and import→allRefs duration are reported per real serial.

A MediaStreamTrackProcessor reads actual Canvas track frames. Its queue limit
is three, but that limit does not bound pending Canvas copies. Omitted-format
`copyTo(ArrayBuffer)` measures actual native NV12/I420 planes. An eight-bit pixel
sequence is decoded independently of transport metadata; unknown, future, or
regressed output serials fail. Legitimate refreshes of the last frame are counted
as duplicates and excluded from unique FPS. At most one initial black output is
classified as warmup. Missing/coalesced real serials remain explicit in the
summary. A finite probe can pass the mechanism check while `allFramesObserved`
is false; consult that flag and the rates before drawing any throughput conclusion.

The actual input/output metadata is recorded. Raw YUV color checks select only
the primary-source contracts NV12/BT.709-limited or fallback I420/BT.601-limited;
unknown pairings fail. Uniform 2×2 regions use fixed matrices with a one-code
rounding allowance. No rational YUV→RGB inverse or fitted/tolerantly adjusted RGB
oracle is used. CPU tests check the oracle/contracts without GPU execution.

Results include actual input FPS, unique output FPS, duplicates, missing serials,
`copyTo` call/promise latency, draw latency, frame age, native lease lifetimes,
renderer heap (when exposed), per-process Electron memory before/during/after,
and cleanup. Copy buffers are erased only after the real copy settles; cleanup
also waits for the actual copy and preserves errors discovered while draining.
Handles and pixel payloads are never persisted. A watchdog retires the session
instead of acknowledging an uncompleted native lease.

The result always says `productionEligible:false`: Canvas exposes no public
pending-capture bound. Finite good memory/age/FPS numbers cannot prove safe
continuous 1080p120 backpressure. Context attributes, output NV12, or a fast
`copyTo` call alone do not prove GPU acceleration or mappability. This version
does not capture a trace, and makes no zero-copy or Cove FPS claim.

## Admission and completion boundary

[`requestFrame()`](https://w3c.github.io/mediacapture-fromelement/#dom-canvascapturemediastreamtrack-requestframe)
sets a request flag and returns `undefined`. There is no public per-request
token, completion promise, pending-copy count, or cancellation operation.
[`maxBufferSize`](https://www.w3.org/TR/mediacapture-transform/#mediastreamtrackprocessor)
limits the Processor's delivered-frame queue; overflow may discard frames. It
does not reserve capacity in Canvas or stop upstream copying. `reader.cancel()`
and `track.stop()` retire the consumer/session; neither is an acknowledgment that
every asynchronous Canvas copy has settled.

In the pinned Chromium implementation, `GetNewFrameCallback()` increments
`pending_send_new_frame_calls_`; completion or callback destruction decrements
it. `NeedsNewFrame()` checks whether capture is running, without enforcing a
maximum on that counter. The counter also defers refresh output. See
[CanvasCaptureHandler source](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.54/third_party/blink/renderer/modules/mediacapturefromelement/canvas_capture_handler.cc).

A Processor handshake can bound application-issued draws if it withholds the
next draw until a corresponding output has completed. It cannot by itself prove
a bound on Canvas-internal work: initial, refresh, stale, or dropped outputs do
not provide reliable per-request completion credits. This probe's pixel serials
identify synthetic output; production timestamps or read order alone must not be
assumed to provide the same identity. A timeout must close admission and retire
the session, never grant replacement credits while old work may remain alive.
The source lease's Electron `allReferencesReleased` barrier remains independent
of any Processor output or generator write.

Throughput success is a prerequisite for considering a product prototype, and
does not waive these admission/cancellation or existing codec-color contracts.
The existing product requires BT.601-limited for VP8 and BT.709-limited for AV1
(`apps/desktop/src/features/media/screen/nativeScreenColorPolicy.ts`). Canvas
NV12/709 output cannot preserve the VP8 contract by changing metadata alone.

## Separate `bounded` stage

`bounded` uses `bounded-renderer.cjs`; `mechanism` and `paced` retain their
original renderer. It is another finite 1728×1080 / 120-native-frame experiment,
with no encoder, RTC loopback, desktop capture, or product change. Its only
Canvas track consumer is a Processor with `maxBufferSize:1`. Actual Processor
output frames go through the same `MediaStreamTrackGenerator({kind:'video'})`
writer API used by the current product. A real writer settlement is measured;
it does not mean an encoder or remote receiver consumed the frame. The result
records generator settings, writer timings, input supersedes, and the maximum
counts for application Canvas admissions, retained pending input, and writes.

Initialization creates the opaque Canvas, attaches the Processor, requests a
frame, and fills black in one synchronous task. The native helper is spawned
only after the actual black output has been copied and observed. Initial auto
capture and the explicit prime set the same boolean request flag, giving no
extra credits. Each admitted native frame is drawn, closed, and its preload
callback resolved immediately. While that admission is awaiting output/write,
at most one subsequent native VideoFrame is retained; a newer input closes and
resolves the superseded frame. The original native allRefs gate still controls
slot reuse. A pending input promoted after an output/write completion is drawn
in one new `MessageChannel` task. At most one promotion task can be scheduled;
its message spends the completed credit and creates no extra request or timer
credit. Cancellation closes both message ports and the retained pending input.

A credit returns only after an actual Canvas output has a strictly newer
timestamp, its synthetic pixel serial matches the sole admitted frame, and
`writer.ready` plus `writer.write(frame)` really settle. An initial or last-frame
refresh with the same timestamp is closed and never grants a credit. Unexpected
new output without an admission, changed pixels on a duplicate timestamp,
correlation mismatch, or a regressed timestamp fails the stage. A two-second
completion deadline closes admission and disposes of the pending source; it
does not race a copy/write promise or issue replacement credits. Cleanup closes
pending input first, cancels the Processor reader, waits for the real in-flight
copy/write, closes the writer, stops tracks, and reports any uncompleted
admission. The existing outer watchdog retires a hung owned process tree.
Native completion and 500 ms of quiet output do not end this stage while a
Canvas admission or pending promotion remains uncompleted.

The first bounded attempt `bounded-IpfK90` failed and remains unchanged. It
received 120 native inputs, admitted only serials 1/3/4/5/120, and completed
four output/writes. Serial5's draw preceded its Canvas output by 1003.2 ms;
the output timestamp itself jumped about 1001.7 ms from the previous snapshot.
Its copy and writer were short. This locates the stall before snapshot creation
or delivery, rather than in the generator writer. The initial version promoted
pending input directly from the output promise continuation and exited before
the final admission completed. A task-observer interaction is a hypothesis,
not a traced root cause. The separate message task and completion-aware exit
are the next controlled test; no larger capture window or synthetic refresh
was introduced.

The second attempt `bounded-FzzbY3` completed/drained correctly with
`passed:true`, but failed the throughput goal: only 5/120 native receipts were
admitted and written (serials 1/3/4/5/120); 115 were superseded. The final two
outputs arrived about 1006/997 ms after their draws. MessageChannel promotion
did not remove that stall. `allFramesObserved:true` refers only to those five
admitted draws. Neither bounded result qualifies product integration or a
continuous 120 FPS route.

The same bounded stage now accepts an explicit sink control. All controls keep
the same prime, native pacer, one Canvas admission, one replaceable pending
input, MessageChannel promotion, color/serial validation, and deadlines:

| `--bounded-sink` | Controlled downstream behavior |
| --- | --- |
| `direct` (default) | Write the original Canvas output to the real Generator, preserving the second attempt's behavior. |
| `none` | Construct no Generator; close the validated Canvas output and return its admission credit. This tests whether a Generator is necessary for the stall. |
| `cpu` | Use the existing completed raw-plane `copyTo(ArrayBuffer)` result to construct a new CPU VideoFrame with the same format/layout/color/Canvas timestamp and `transfer:[buffer]`. Require real buffer detachment, then close the original Canvas output before writing the CPU frame. |
| `timestamp` | Create `new VideoFrame(canvasOutput,{timestamp:nativeTimestamp})`, close the original JS output, and write the new handle. This shares pixel resources and tests the product's retimestamping shape. |

The no-writer control was run serially with the frozen source helper:

```powershell
node tooling/native-screen-capture/canvas-route-probe/run.cjs --stage bounded --bounded-sink none --helper runtime/nv12-shader-probe/readback-helper-hires.exe
```

`bounded-Czkmc8` reproduced the stall without any Generator: 120 receipts,
4 admitted outputs (serials 1/4/5/120), about 1.490 unique output FPS and
one-second tail latency. A Generator is therefore not necessary for the stall.
The CPU-backing and timestamp controls were not GPU-executed; they add no useful
discrimination for this observed visibility problem.

`completedSerials` counts validated admission completions; `writtenSerials`
counts actual settled Generator writes and is empty for `none`. Results record
the selected control, CPU buffer transfers, constructor time, source-output
closure before write, and the writer frame timestamp. CPU mode transfers buffer
ownership to the CPU frame; detached memory is never erased or reused by JS.
Other buffers are erased after their real copy/write operation settles. These
are controls, without encoder/RTC qualification, and keep
`productionEligible:false`.

The ownership hypotheses remain distinct from established source facts:

- [RenderableMappableSharedImageVideoFramePool](https://github.com/chromium/chromium/blob/152.0.7977.54/media/video/renderable_mappable_shared_image_video_frame_pool.cc)
  allocates new resources when none are available for reuse. Its
  `kMaxAvailableFrames=2` bounds returned idle resources, not all live frames;
  this source does not establish a three-live-frame limit.
- [Generator underlying sink](https://github.com/chromium/chromium/blob/152.0.7977.54/third_party/blink/renderer/modules/breakout_box/media_stream_video_track_underlying_sink.cc)
  takes a native frame reference and closes the passed JS VideoFrame. NV12
  bypasses its RGB-only eager conversion. It may mutate the native frame's
  `capture_begin_time` from the JS handle timestamp, subject to a one-minute
  timestamp-domain check. The ordinary write resolves after handing the frame
  to the broker, not after downstream native references disappear.
- [PushableMediaStreamVideoSource broker](https://github.com/chromium/chromium/blob/152.0.7977.54/third_party/blink/renderer/modules/breakout_box/pushable_media_stream_video_source.cc)
  posts the referenced frame to the video task runner; the inspected path does
  not itself retain a multi-frame cache or schedule a one-second refresh.
- [VideoFrame construction](https://github.com/chromium/chromium/blob/152.0.7977.54/third_party/blink/renderer/modules/webcodecs/video_frame.cc)
  with only `timestamp` changes a JS handle timestamp while retaining the same
  underlying native frame. Other metadata overrides can create a native wrapper.
  Retimestamping alone therefore does not isolate native metadata or release
  shared pixel resources. The `cpu` control supplies independent pixel storage.

## Visibility and Canvas placement controls

`--visibility hidden|visible` changes only the owned probe window's presentation;
the default remains `hidden`. A visible window is 720×480 and shows the same
synthetic Canvas. The sandbox, permission denial, CSP, network boundary, source
resolution, and `backgroundThrottling:false` remain unchanged. Results record
the requested mode separately from BrowserWindow `isVisible`, focus, minimized
state, and renderer `document.visibilityState`/`hasFocus`. Main window state is
also included in memory samples. These APIs may report different states; a
requested mode is not substituted for an observed value.

The controlled finite results were:

| Artifact | Window / sink | Native receipts → admitted unique outputs | Unique output FPS | Age p95 |
| --- | --- | --- | --- | --- |
| `bounded-Czkmc8` | hidden / none | 120 → 4 | 1.490 | 1000 ms |
| `bounded-RmJsA3` | visible / none | 120 → 118 | 120.185 | 5.7 ms |
| `bounded-mtE3JX` | visible / direct | 120 → 118, all 118 written | 120.086 | 5.1 ms |

Each visible run superseded only two startup inputs, and the admitted serials
had no missing or duplicate output. The fixed serial 11–110 windows contained
100 outputs at 119.724 and 119.942 FPS respectively. The visible artifacts
reported renderer state `visible`/focused while the main `isVisible` field was
false; that discrepancy is preserved. The comparison establishes
visibility-related Canvas forward progress on this host. It does not qualify
never-shown, hidden, minimized, or real Cove operation.

For `bounded`, `visible-then-hidden` and `visible-then-minimized` first show the
owned window and complete the real black prime. They then hide/minimize only
that window, confirm its main-process state within one second, record the
before/after renderer and window states, and finally start the native source.
They distinguish never-shown initialization from practical background use:

```powershell
node tooling/native-screen-capture/canvas-route-probe/run.cjs --stage bounded --bounded-sink direct --visibility visible-then-minimized --helper runtime/nv12-shader-probe/readback-helper-hires.exe
```

The independent `--canvas-placement attached|detached` control defaults to the
original `attached` behavior. `detached` creates the same HTMLCanvasElement and
context but omits only `document.body.append(canvas)`. It sets no display,
visibility, or opacity style; there is no extra draw, request, readback, or
credit. `canvasConnection` records the chosen placement, actual `isConnected`,
Canvas dimensions, inline style values, and connection after cleanup. Detached
placement is currently supported only for the bounded stage:

```powershell
node tooling/native-screen-capture/canvas-route-probe/run.cjs --stage bounded --bounded-sink direct --visibility hidden --canvas-placement detached --helper runtime/nv12-shader-probe/readback-helper-hires.exe
```

This placement control has a specific source basis:
[CanvasRenderingContext2D::FinalizeFrame](https://github.com/chromium/chromium/blob/152.0.7977.54/third_party/blink/renderer/modules/canvas/canvas2d/canvas_rendering_context_2d.cc)
tracks outstanding animation commits for displayed Canvas elements and can
create a rate limiter after two uncommitted frames. Its
[SharedContextRateLimiter](https://github.com/chromium/chromium/blob/152.0.7977.54/third_party/blink/renderer/platform/graphics/gpu/shared_context_rate_limiter.cc)
uses GPU queries or `Finish()` once its pending-tick limit is exceeded. Hidden
native callbacks continued arriving during the observed one-second stalls, so
the evidence does not support a one-second synchronous block of the renderer
thread. A particular rate-limiter/commit cause is still a hypothesis.

The inspected lower-level paths include explicit submission:
[SignalQuery](https://github.com/chromium/chromium/blob/152.0.7977.54/gpu/command_buffer/client/implementation_base.cc)
issues a shallow flush;
[GpuChannelHost::CopyToGpuMemoryBufferAsync](https://github.com/chromium/chromium/blob/152.0.7977.54/gpu/ipc/client/gpu_channel_host.cc)
flushes pending requests before sending its async IPC; and the
[D3D async readback](https://github.com/chromium/chromium/blob/152.0.7977.54/gpu/command_buffer/service/shared_image/d3d_image_backing.cc)
uses [EnqueueSetEvent](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgidevice2-enqueuesetevent),
which submits outstanding rendering commands. These sources do not support a
missing flush in those operations as the established cause. No global feature
flags, transparent window, or one-pixel readback workaround has been added.

The pinned Chromium152 topology supports this experiment:

- [OnRequestCanvasDrawListener](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.54/third_party/blink/renderer/modules/mediacapturefromelement/on_request_canvas_draw_listener.cc)
  clears its request flag when obtaining one snapshot callback;
  [AutoCanvasDrawListener](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.54/third_party/blink/renderer/modules/mediacapturefromelement/auto_canvas_draw_listener.cc)
  requires that flag for another snapshot.
- [CanvasRenderingContext](https://github.com/chromium/chromium/blob/152.0.7977.54/third_party/blink/renderer/core/html/canvas/canvas_rendering_context.cc)
  registers a task observer on the first draw in a task. `DidProcessTask()`
  finalizes the frame and calls `PostFinalizeFrame()`. This is why pending
  promotion has its own task boundary; a microtask continuation is not treated
  as a substitute for a new script task.
- [Processor underlying source](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.54/third_party/blink/renderer/modules/breakout_box/media_stream_video_track_underlying_source.cc)
  attaches one sink and queues received frames. It does not request refreshes
  when reading. [MediaStreamVideoTrack](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.54/third_party/blink/renderer/modules/mediastream/media_stream_video_track.cc)
  requests refresh on sink addition, but the default Canvas track is not a
  screencast and does not start the screencast refresh timer. The initial
  sink-add refresh is harmless while Canvas has no `last_frame_`.
- [CanvasCaptureHandler](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.54/third_party/blink/renderer/modules/mediacapturefromelement/canvas_capture_handler.cc)
  stamps snapshots from their callback-creation time relative to the first
  snapshot. Refresh delivery reuses `last_frame_` and its timestamp.
  [FrameQueueUnderlyingSource](https://github.com/chromium/chromium/blob/152.0.7977.54/third_party/blink/renderer/modules/breakout_box/frame_queue_underlying_source.cc)
  starts delivery synchronously. Its output timestamp uses the media-frame
  timestamp unless capture/reference time is present; those paths clamp time
  precision and do not constitute a public request token.

This is a constrained implementation contract to test, with one Canvas
admission at a time; it does not add a public browser pending-copy bound or
cancellation acknowledgment. Pixel serials are independent fixture evidence;
a product path must not add visible markers or read desktop pixels for credit.
Any later product prototype must keep the Canvas track private to the Processor,
pass only generator output to the existing publisher, forbid new Canvas sinks,
clones, resizing, and constraints during the session, and retire on unexpected
output or timeout. The stock capture remains an untouched fallback, codec/quality
policy stays intact, and VP8 retains the current CPU/601 route. Even a passing
bounded fixture leaves `productionEligible:false` until real Cove qualification.

Primary-source route background (Chromium 152.0.7977.54):

- [CanvasCaptureHandler](https://chromium.googlesource.com/chromium/src/+/152.0.7977.54/third_party/blink/renderer/modules/mediacapturefromelement/canvas_capture_handler.cc)
- [StaticBitmapImageToVideoFrameCopier](https://chromium.googlesource.com/chromium/src/+/152.0.7977.54/third_party/blink/renderer/platform/graphics/static_bitmap_image_to_video_frame_copier.cc)
- [WebGraphicsContext3DVideoFramePool](https://chromium.googlesource.com/chromium/src/+/152.0.7977.54/third_party/blink/renderer/platform/graphics/web_graphics_context_3d_video_frame_pool.cc)
- [PaintCanvasVideoRenderer](https://chromium.googlesource.com/chromium/src/+/152.0.7977.54/media/renderers/paint_canvas_video_renderer.cc)
- [RenderableMappableSharedImageVideoFramePool](https://chromium.googlesource.com/chromium/src/+/152.0.7977.54/media/video/renderable_mappable_shared_image_video_frame_pool.cc)

Optional later route evidence should keep only fixed trace event names/times:
`StaticBitmapImageToVideoFrameCopier::Convert` accelerated pool copy,
`CopyRGBATextureToVideoFrame`, `GpuChannelMessageFilter::CopyToGpuMemoryBufferAsync`,
`D3DImageBacking::ReadbackToMemoryAsync`, and
`D3DImageBacking::ReadbackFromStagingTexture`. A scope event by itself is not an
asynchronous copy completion measurement.
