# Screen capture efficiency investigation, 2026-10-28

本轮结论：整屏路径仍先搬运大图到 CPU，再做缩放/色彩转换；Chromium
把包含等待的总历时纳入 50% 预算，形成约 70～80 FPS 的实际采集间隔。
本机 DXGI 和 GPU 预缩放原型都能取得更高帧率，不能把这个结果当成
正式 Cove 已达到 120 FPS。编码器、码率和服务端策略没有更改。

This is a local investigation on branch `codex/screen-capture-efficiency`, based
on `6d59a61dee659c582d3208258596138643bde4a0`. It does not change the codec,
bitrate policy, production server, operating-system configuration or release.
Measurements below use an owned moving pattern, not retained user screenshots.

## What is already established

The tested runtime is Electron 44.0.0 / Chromium 152.0.7977.54, Windows 11 23H2
(22631), with a 2560x1600, 240 Hz display. Test peers are isolated Electron
renderers and the existing local SFU. The renderer's actual capture size must
be read from the recorded track and RTC stats; a preset name is not proof of
the input or encoded size.

The `stable-prewire-controls-LhcoHH` run under
`runtime/fps-validation-efficiency-20261028/` passed its known-pattern,
current-stream association, dimension, codec and final resource checks:

| Source and route | Track / encoded size | Captured FPS | Sent FPS | Decoded FPS |
| --- | --- | ---: | ---: | ---: |
| Whole monitor, normal activity sampling | 1000x624 / 865x540 | 71.22 | 71.22 | 70.97 |
| Owned full-screen Electron window | 1000x624 / 865x540 | 119.73 | 119.73 | 119.60 |
| Whole monitor, 60 FPS request | 1000x624 / 865x540 | 57.06 | 57.06 | 56.93 |

All three use the same VP8 encoder path. This isolates a capture-path difference;
it does not establish that arbitrary external Windows windows reach 120 FPS.
Video-element callbacks and presentation counters are not physical scan-out.
Eight-second samples are throughput measurements, not a long-call validation.

### The internal-window control has a different device

Chromium's `window:HWND:AuraRegistryId` has a third, process-local field.
When it is nonzero, the capture-device launcher selects
`AuraWindowVideoCaptureDevice` / Viz FrameSink instead of
`DesktopCaptureDevice`. Electron can supply that registry field for its own
BrowserWindow. Therefore the owned-window control is useful proof that the
remaining encoding/SFU/decoding path can sustain 120 FPS under these conditions,
but it is not a WGC performance result.

Primary version-specific evidence:

- [Chromium source-ID parsing](https://github.com/chromium/chromium/blob/152.0.7977.54/content/public/browser/desktop_media_id.cc#L67)
- [Device routing and trace markers](https://github.com/chromium/chromium/blob/152.0.7977.54/content/browser/renderer_host/media/in_process_video_capture_device_launcher.cc#L325)
- [Electron native-window source ID](https://github.com/electron/electron/blob/v44.0.0/shell/browser/native_window_views.cc#L1584)
- [Aura target to FrameSink](https://github.com/chromium/chromium/blob/152.0.7977.54/content/browser/media/capture/aura_window_video_capture_device.cc#L93)

### The monitor scheduler accounts for elapsed time, not measured CPU time

The monitor's native log explicitly records
`max_cpu_consumption_percentage=50`. In the locked Chromium source the effective
period is at least twice the capture/conversion/delivery elapsed duration.
This duration can include a synchronous GPU readback wait.

`tooling/analyze-screen-capture-timing.cjs` matches successful regular capture
segments wholly within each recorded sample window. In the 120 FPS monitor
case it finds 575 complete segments:

| Mean measured quantity | Milliseconds |
| --- | ---: |
| Capture call to successful callback | 3.710 |
| Callback to scheduling | 2.450 |
| Whole elapsed segment | 6.160 |
| Logged capture duration | 5.990 |
| Scheduled period | 12.480 |
| Actual next capture start interval | 14.042 |
| Interval beyond the previously scheduled period | 1.561 |

Log timestamps have millisecond resolution and omit the native thread ID. These
are elapsed segment measurements, not pure converter CPU or GPU durations.
No DXGI initialization timeout or duplication failure occurred in these sample
windows. The result explains why requesting 120 alone cannot overcome the
observed cadence; it does not yet assign all of the six milliseconds to one API.

- [Chromium capture scheduling](https://github.com/chromium/chromium/blob/152.0.7977.54/content/browser/media/capture/desktop_capture_device.cc#L1161)
- [WebRTC DXGI staging readback](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/desktop_capture/win/dxgi_texture_staging.cc#99)

### WGC is not an unrestricted switch on this OS

The Chromium monitor route requires Windows 11 24H2 for WGC. The locked WebRTC
WGC session separately requires 24H2 for texture output. On this 23H2 machine,
enabling a feature name cannot safely bypass those implementation conditions.
The CPU-memory WGC window path still has synchronous processing and the same
DesktopCaptureDevice budget. No OS upgrade, driver change or gate bypass is
part of this investigation.

- [Monitor OS condition](https://github.com/chromium/chromium/blob/152.0.7977.54/content/browser/media/capture/desktop_capture_device.cc#L241)
- [WGC texture condition](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/desktop_capture/win/wgc_capture_session.cc#272)

## Measurement discipline

- The source displays known corner colors and a changing binary frame counter.
  The receiver observer first validates six deterministic counter values, then
  samples the existing receiver video at about 1 Hz with one bounded VideoFrame
  copy, closes it and zeros the temporary pixel buffer. Only classifications,
  counters, timings and resource counts are retained.
- Source, outbound, inbound and video-element counters must refer to the current
  stream. Historical counters, requested FPS and source rAF are not capture FPS.
- Final cleanup unmounts the test application and waits for normal effects;
  media, audio contexts, timers, listeners and owned SFU resources must reach zero.
- Faulty observer / occluded-source runs remain in runtime with their failure
  result. They are excluded from throughput comparisons.
- Native tracing is a separate diagnostic run. Its overhead cannot be presented
  as normal performance. Missing thread-CPU timestamps mean CPU cost is unknown.

## Product change separated from throughput investigation

Local commit `c67766ddb2f65207c827a3eb77ebd8e8570d555d` serializes screen-update
commit ownership and promptly releases uncommitted capture candidates. It
preserves the immediate capture request required by user activation, invalidates
late sessions and installs ended handling before audio startup can complete.
It fixes reachable resource/lifecycle races; it is not a first-run FPS claim.
The focused lifecycle/capture tests passed 42/42 before that commit, with desktop
type checking and an independent patch review.

The small maximum-dimension change was frozen while native profiling proceeded;
its initial patch remains in
`runtime/fps-validation-efficiency-20261028/frozen-size-experiment.patch`
(SHA-256 `15c8d3314f7dad46c776c71749ce82daada3ba5ccc07ddb0586e4dcc33a3403b`).
After the native cost was understood, it was resumed separately: start and
update now request only maximum preset width/height before the RTP stage,
without ideal/minimum/exact dimensions or upscaling. Native-resolution mode
keeps the original FPS-only request. The new call-site test first failed against
the unwired hook; after wiring, all 37 focused capture/publication tests passed.
This saves downstream work but does not remove DXGI's full-size readback or
Chromium's native budget. It must not be advertised as solving monitor 120 FPS.

Earlier ABBA investigation at 540p compared 1000x624 capture / 865x540 encoding
with 864x540 capture/encoding: capture mean changed from about 71.65 to 74.53 FPS,
and RTC encode time from about 3.33 to 2.46 ms. This was an ideal-plus-maximum
test override, not the final maximum-only product call. The one-pixel encoded
width difference and normal run variability are limitations. Final product
native acceptance must be reported separately, never substituted with this
experiment or the native-only GPU numbers below.

## Direct DXGI measurement

`native-api-dNV4Rx` completed three eight-second modes with the same owned,
foreground full-screen source. Its independent 64x64 GPU roundtrip passed
before capture, and each profile also validated roundtrip on the capture
adapter. The physical duplication surface was 2560x1600, not the renderer's
1000x624 adapted track. `DesktopImageInSystemMemory` was false.

| Native probe mode | Different LastPresentTime values / second | Mean processed iteration |
| --- | ---: | ---: |
| Acquire / release only | 239.97 | 0.055 ms |
| Add full-size staging readback | 237.62 | 1.540 ms |
| Add full-size CPU row copy | 180.23 | 3.329 ms |

In the third mode, mean `CopyResource` submission was 0.0025 ms, synchronous
`Map` 1.485 ms, CPU row copy 1.762 ms and `Unmap` 0.021 ms. The first figure is
asynchronous submission time, not GPU execution time. Polling/backoff, ownership
guards and release have separate counters. Distinct present timestamps are
counted; cursor-only updates and duplicate presents are not inflated into FPS.

The probe is deliberately a separate native program without Chromium color
conversion, encoder, SFU or receiver. Its 180 FPS result is not a product FPS
claim. It falsifies an absolute 80 FPS limit at desktop duplication on this
machine. Full-size CPU-accessible image handling plus subsequent conversion and
the budget multiplier remain the relevant product costs.

GetThreadTimes has coarse and uneven per-stage accounting in this run (including
zero accumulated time for some busy stages). Do not interpret those zero values
as no CPU work, or use them alone to quantify GPU wait. Raw thread cycles and
QPC are retained separately and cycles are not converted to milliseconds.

Executable SHA-256:
`37dedcc3b31f30b316d28d8a9b7fd7cbbf8b4f790ce1c925e54f59e457daa601`.
`tooling/verify-native-capture.cjs` owns the visible synthetic source and bounded
probe process; Escape cancels. It does not open or stop the formal Cove client.

## Trace limits and verified trace data

The first broad trace failed to finish exporting. Its incomplete, explicitly
owned exporter temporary file was audited and removed; that run remains failed.
The narrower three-second trace in `trace-monitor-narrow-YIWoHu` successfully
exported and sanitized 25,747 events, including `UsingDesktopCapturer` and native
thread CPU fields. It recorded 181 `ConvertAndScale` calls on
`desktopCaptureThread`: 399.993 ms elapsed and 399.625 ms thread CPU in total
(approximately 2.21 ms per call). This is real conversion/scaling CPU work,
separate from the earlier GPU readback wait.

The locked build labels its native TRACE macro lambdas `operator()`. The offline
analyzer only matches outermost `webrtc` spans on `desktopCaptureThread` that
contain known `ConvertAndScale` work. For 181 matched complete segments:

| Mean per capture segment, profiling startup only | Time |
| --- | ---: |
| Elapsed | 6.786 ms |
| Recorded thread CPU | 5.080 ms |
| Elapsed minus thread CPU | 1.705 ms |
| Scaling/color-conversion thread CPU | 2.208 ms |
| Other thread CPU outside known converter/delivery spans | 2.858 ms |

Nested converter/delivery CPU intervals are unioned before subtraction. Elapsed
minus CPU includes scheduling and other waits; it is not a GPU timestamp query.
The data refutes both “all of this is CPU” and “all of this is GPU waiting”.

The trace run's media/resource cleanup passed, but Electron then exited with
`0x80000003` and logged `PostQueuedCompletionStatus: (6)`. The overall run is
therefore **failed**. Its completed trace supports local stage analysis only;
it does not count as a successful stability check. This experimental trace
option is off by default and is not enabled in the product.

## GPU-first control and interoperability

`native-api-WhJYzQ` completed a same-source, same-executable ABBA control with
four six-second samples. Whole-frame staging/copy iterations averaged 3.304 and
3.227 ms, versus 0.649 and 0.669 ms when the complete image was first scaled on
the GPU to 864x540. The latter sampled 239.80 and 239.48 distinct presents/s,
versus 183.31 and 187.49 for full-size staging/copy. There were no duplicate
present timestamps counted as fresh frames. The three synthetic GPU scale
pixel/reference tests passed before capture, including orientation and alpha.

This confirms a native data-movement opportunity: choose the final small image
before crossing to CPU memory. It is not a whole-app 80% CPU reduction or a
product 240 FPS result. The native benchmark does not include Chromium's CPU
color conversion, WebRTC's subsequent processing, encoding or viewing.

The prototype uses bilinear GPU sampling. It establishes the data-movement
benefit; it is not a quality-equivalent replacement for every existing scaler.
Production integration must preserve intended filtering/color behavior, as well
as handle cursor and display changes. The current probe is not enabled by a
product setting, environment fallback or update channel.

The one-frame shared-texture probe also passed on actual Electron 44 with its
sandboxed preload: 64x64 BGRA, all 4096 pixels matched, frame closed, main-table
temporary handle closed, all import references released, helper exited 0.
See `runtime/shared-texture-probe/interop-EQIONY/result.json` and
`tooling/shared-texture-probe/README.md`. It establishes API interoperability,
not a streaming/native capture provider. No product path imports the probe.

The expected native-provider boundary is `CaptureAdapter` / `CaptureSession`:
native capture and GPU-size choice own platform resources; the existing
publisher keeps its codec, Producer, SFU and watch/recovery logic. A real provider
still needs a bounded slot pool and all-reference credits, explicit cancellation
through every stop/update/leave path, cursor composition, monitor geometry,
adapter/display changes and GPU/helper failure tests. `track.stop()` alone does
not stop an external helper. These requirements are reasons not to silently
replace the stable default with the one-frame probe.

## Final implemented-path acceptance

Local commit `1b729fe` contains the preset maximum capture dimensions and its
call-site regressions, separate from lifecycle commit `c67766d`. It does not
change the codec preference, negotiated capability, RTP bitrate ceiling,
system-audio path or server protocol.

`final-native-acceptance-PgQePn` passed using the actual desktop publishing and
watching hooks, two Chromium peers and the isolated local SFU. Both cases
identified the owned monitor pattern and a changing, nonfuture counter, stopped
and republished with a new consumer track, decoded at least 20 fresh frames,
and cleared renderer and server resources. Normal exit was 0.

| Actual product path | Track / encoded / decoded size | Captured FPS | Sent FPS | Decoded FPS |
| --- | --- | ---: | ---: | ---: |
| 540p preset, 120 FPS request, game mode | 864x540 throughout | 78.12 | 78.12 | 77.95 |
| Native-resolution mode, 60 FPS request | 1000x624 throughout | 57.25 | 57.25 | 57.42 |

These are six-second samples after five-second warmup, not long-call tests.
Native-resolution acceptance means the existing FPS-only request and no preset
RTP downscale were preserved. The test renderer's adapted input was 1000x624;
it is not proof of a 2560x1600 encoded native-resolution stream. Earlier
same-scene monitor samples were around 71–72 FPS; the final 78 FPS sample is not
a controlled percentage improvement estimate against those earlier times.

`final-generated-republication-23qFUz` also passed with current-stream counters:
960x540 preset at 116.76 captured/sent/decoded FPS, and FPS-only native mode at
1920x1080 with approximately 58 FPS. Stop/republication and full cleanup passed.
This synthetic source excludes Windows capture and cannot replace the native
result above.

Validation on the implemented change:

- New hook contract first failed against the unwired production calls; after
  wiring, 37 focused capture/publication tests passed.
- Existing desktop `test:screen-capture`: 94/94 passed. This overlaps the focused
  suite and is not counted as 94 additional unique cases.
- Diagnostic/parser/native-launcher contracts: 21/21 passed, including nested
  CPU interval accounting and trace export sanitation.
- Desktop type checking and the media/performance fixture type check passed.
- Existing desktop frontend production build passed. Its pre-existing Vite CJS,
  icon resolution and chunk-size warnings remain; this is not an installer build.
- Both native probes compiled with the existing compiler, warnings as errors.
  Real GPU self-tests, native ABBA and one-frame shared-texture interop passed.

## Failed experiments and remaining boundaries

- The early broad trace export failed; the narrow trace produced valid stage
  evidence but failed at process shutdown. Neither is a stability pass.
- `native-window-route-XdqyHc` requested the same owned HWND with its Aura
  registry field removed. Regular DesktopCaptureDevice captures now appeared;
  its short qualified-image sample was below 30 FPS and the run aborted after
  about one second. This is not an eight-second WGC benchmark, and is no basis
  for recommending an unconditional switch from monitor to native window capture.
- Several native API repeats were refused before capture because the owned
  source was not foreground. One app run failed known-pattern qualification
  while another window covered its source. Those runs stay failed and are not
  averaged into valid measurements. User-scheduled foreground runs above passed.
- `final-generated-behavior-JrAQeR` did not resume decoding within 20 seconds
  after the test deliberately terminated its own Electron GPU process. The
  generated Canvas/VideoFrame source also depends on GPU resources; evidence
  from that run does not establish whether the fixture or the product was the
  cause. This fault test is **not passed**. Normal stop/republication is tested
  separately rather than relabeled GPU recovery.
- The one-frame texture probe does not test streaming slot reuse, long calls,
  cursor composition, multi-monitor/rotation/HDR, adapter/display changes or
  GPU/helper loss. It is not a replacement capture provider. No such provider
  is loaded by the app or enabled in an update channel.
- Independent review covered the earlier lifecycle fix and native probe plan.
  A new final independent pass could not complete because the delegated model
  reported its usage limit; this is not a completed review of a production GPU
  provider. The implemented small patch has local type, unit, build and actual
  client evidence; no release or installation was performed.

The remaining structural implementation is a bounded native GPU capture adapter
with explicit CaptureSession ownership, all-reference slot credits and tested
failure/stop behavior, keeping the current codec/Producer/SFU path. It must be
validated as a real end-to-end provider before becoming the stable default.
