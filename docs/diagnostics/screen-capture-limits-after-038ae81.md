# Remaining monitor-capture limits after 038ae81

2026-10-23 UTC, branch `codex/validation-after-038ae81`. Product media/startup behavior remains frozen at `038ae81`; concurrent commit `c75797d` affects separate updater validation only. This report supplements [the original measurements](screen-capture-performance-20261023.md); its raw evidence and validity index are unchanged.

**The verified 540p VP8 gain remains 54–56 → 77–78 FPS, reproduced twice. Monitor capture still does not reach 120 FPS.** Native timing supports conversion/delivery plus Chromium's capture budget as the main common limit in that controlled workload. It does not establish a fixed 80 FPS ceiling or exclude shared encoder resources.

**The new AV1/VP8 × normal/game matrix is incomplete and excluded.** Native capture degraded to about 1 FPS with DXGI timeouts. A bounded known-pattern probe reproduced sparse new frames without encoding or an SFU. This distinct failure prevents a fair new comparison; it must not be attributed to the candidate, hardware capacity, or the earlier 77 FPS condition. No product change is justified by this follow-up.

## Dimensions and stage measurements

| Layer | Default 540p fixture | Meaning |
| --- | --- | --- |
| Native OS desktop frame | 2560×1600 | Incoming native frame before downscaling, explicitly logged in frozen legacy runs. |
| Browser media-source / track | 1000×624 | `getSettings()` and linked `media-source` output. This is not the OS grab area or a guarantee of the installed client's dimensions. |
| Encoded / decoded / video intrinsic | 865×540 | Actual RTP and video fields, not a preset label. |

Product capture constraints request preferred/maximum FPS only; preset scaling is later applied through RTP. Selecting 540p therefore does not quarter the 2560×1600 native grab. The separate fixture-only 1920×1080 bound yielded actual 1728×1080 throughout, preserving 16:10. No explicit capture-size cap was added to the frozen candidate.

Frozen device: Windows 10.0.22631 / Win11 23H2, Ryzen 9 7945HX / 32 logical processors, 16 GiB RAM, RTX 4060 Laptop / driver 32.0.15.6094, 2560×1600@240 Hz / scale 1.5. Electron 44.0.0, Chromium 152.0.7977.54, embedded Node 24.18.1, launcher Node 24.11.1. Each valid group uses 5 s warmup / approximately 8 s samples, owned fullscreen changing source, two real peers and private loopback SFU. Game mode disables activity analysis. VP8 is `libvpx`; AV1 is `libaom`, both software encoders.

| Frozen row | Browser source → encoded | rAF | Source | Encode | Send | Receive | Decode | Presented | Encode / decode ms/frame |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Original VP8 baseline, game | 1000×624 → 865×540 | 239.99 | 56.35 | 56.35 | 56.35 | 56.35 | 56.47 | 56.36 | 3.67 / 1.91 |
| Original AV1 baseline, game | 1000×624 → 865×540 | 239.86 | 56.01 | 56.01 | 56.01 | 56.00 | 56.00 | 56.14 | 3.06 / 0.83 |
| Repeated VP8 baseline, game | 1000×624 → 865×540 | 239.80 | 54.23 | 54.35 | 54.35 | 54.23 | 54.23 | 54.35 | 3.78 / 1.97 |
| Repeated VP8 ZeroCopy, game | 1000×624 → 865×540 | 240.08 | 76.87 | 76.87 | 76.87 | 76.75 | 76.75 | 76.75 | 3.45 / 1.64 |
| Actual 1080 baseline, game | 1728×1080 → 1728×1080 | 239.64 | 46.54 | 46.54 | 46.54 | 46.54 | 46.54 | 46.56 | 6.31 / 4.49 |
| Actual 1080 ZeroCopy, game | 1728×1080 → 1728×1080 | 239.83 | 58.62 | 58.75 | 58.75 | 58.75 | 58.62 | 58.62 | 6.44 / 4.47 |

Rates are FPS. The first ZeroCopy process additionally reached 78.44 source / 78.57 send / 78.44 decode at default 540p dimensions. Actual 1080 height has one pair only. **ZeroCopy AV1 same-condition throughput and normal-mode comparison remain unknown.** The prior AV1 ZeroCopy functional-only run verified actual AV1/libaom, non-black decoding, fresh receiver growth after stop/reacquire and cleanup; compilation overlap excludes its throughput.

Selected cumulative endpoints support the rates; raw per-second reports preserve IDs and timestamps:

| Frozen 540p row | Source | Encoded / sent | Received | Decoded | Presented |
| --- | --- | --- | --- | --- | --- |
| Original VP8 | 300→753 | 295→748 | 295→748 | 294→748 | 292→745 |
| Original AV1 | 293→743 | 293→743 | 293→743 | 290→740 | 288→739 |
| Repeated VP8 baseline | 287→723 | 277→714 | 276→712 | 276→712 | 272→709 |
| Repeated VP8 ZeroCopy | 399→1017 | 385→1003 | 384→1001 | 384→1001 | 380→997 |

Rates are counter deltas / report timestamp intervals, with small pipeline/sampling differences. Source rAF measures painting opportunities, not fresh captured frames. Browser `media-source.frames` precedes downstream encoding. The real inbound report excludes reserved SSRC 1234's zero decoded frames; fresh-consumer checks bind to the displayed receiver track. Repeated ZeroCopy's JavaScript video callback rate is **69.91**, versus **76.75** presented/decoded FPS: callbacks can coalesce. Neither proves physical scan-out.

Actual video's packet-loss and decoder-dropped counter deltas are **0** in these intervals; outbound limitation reason is `none`, and CPU/bandwidth limitation-duration deltas are **0**. These are measured zeros, not unlimited-resource proof. Encoder queue delay, per-operation conversion time, GPU busy time, memory bandwidth, physical scan-out and synchronized end-to-end latency are **unknown**. Similar AV1/VP8 rates do not exclude shared CPU/memory or encoder pressure with complex content. Repeated-pair Electron CPU sums average 7.34 / 8.71 reporting units, not complete host load or individual-core utilization.

## Native budget and conversion evidence

Exact [Chromium 152.0.7977.54 scheduling](https://github.com/chromium/chromium/blob/152.0.7977.54/content/browser/media/capture/desktop_capture_device.cc#L1161) uses `period=max(2D,requestedPeriod)` under the logged 50% budget. `D` is wallclock from capture start through callback, conversion and delivery, not measured thread CPU time. 120 FPS requires at most 4.17 ms before scheduling latency. Its [monitor-WGC gate](https://github.com/chromium/chromium/blob/152.0.7977.54/content/browser/media/capture/desktop_capture_device.cc#L241) requires Win11 24H2/build 26100; this host logs screen WGC disabled / window WGC enabled. A feature name alone does not establish the capture API.

The [ZeroCopy branch](https://github.com/chromium/chromium/blob/152.0.7977.54/content/browser/media/capture/desktop_capture_device.cc#L638) still handles CPU-accessible input and I420 output; texture delivery is separate. [RGB conversion](https://github.com/chromium/chromium/blob/152.0.7977.54/media/base/video_frame_converter.cc#L159) scales RGB before I420 conversion via [libyuv helpers](https://github.com/chromium/chromium/blob/152.0.7977.54/media/base/video_frame_converter_internals.cc#L19), unlike legacy full-size conversion before I420 scaling. That is a plausible gain mechanism, not proof of GPU texture capture or per-operation timings.

Retrospective VLOG matching includes only regular successful captures wholly inside each frozen sample window:

| Frozen run | Frames | Call → callback median / p95 ms | Callback → schedule median / p95 ms | Logged total median / p95 ms |
| --- | ---: | ---: | ---: | ---: |
| 540 VP8 baseline | 436 | 3 / 5 | 5 / 6 | 8 / 10 |
| 540 VP8 ZeroCopy | 617 | 3 / 4 | 2 / 3 | 5 / 7 |
| Actual 1080 baseline | 373 | 3 / 5 | 6 / 7 | 10 / 11 |
| Actual 1080 ZeroCopy | 471 | 4 / 5 | 4 / 5 | 7 / 9 |

The main observed reduction is after the callback; residual capture and delivery still consume the budget. These wallclock segments include waiting, copies, dispatch, conversion and buffer/delivery work; they are not pure API/converter stopwatches. Millisecond labels truncate precision, so 0 ms means below log resolution. Medians need not add. Refresh/warmup/cleanup are excluded; derived JSON retains original log line numbers. Local log labels align to UTC+08:00, recorded explicitly in new metadata and documented as alignment for older metadata which omitted timezone.

[Default Chromium capture options](https://github.com/chromium/chromium/blob/152.0.7977.54/content/public/browser/desktop_capture.cc#L45) permit DirectX with GDI fallback. **Successful API per frozen frame remains unknown**: adapter-specific warnings do not prove all adapters failed. Electron-patched log lines differ from upstream source lines. WebRTC DEPS pin is `6f37672d358475cd17544121a12494da454d85fb`; unrelated HEAD source was not substituted.

## Excluded follow-up and bounded stopping point

`default-codec-mode-L4fWZu`, **20:10:12.101–20:11:05.127 UTC**, used ZeroCopy and planned VP8 game → AV1 game → AV1 normal → VP8 normal, unchanged default constraints, expected browser1000×624 / encoded865×540, and actual codec assertions.

- First VP8 group matched dimensions but yielded only **0.75 FPS** through all pipeline stages, while rAF was170.34. Game-mode draw/read calls were **0**. This already invalidated the changing-source baseline.
- AV1 game then failed **709×442 !=865×540**. `maintain-framerate` can legitimately adapt dimensions; no size, scale or bitrate was forced to conceal it. Its raw samples were lost by the earlier assertion order, so quality limitation and codec implementation are **unknown**, not reconstructed. Normal groups never ran.
- Native log preserves DXGI's500ms timeout / `Duplication failed`, then successful callback with **872ms** duration / **1744ms** scheduled period. This differs materially from the frozen valid condition.
- Cleanup: **0** renderer timeouts, backend stopped, launcher naturally returned failure. Recorded Electron154860 / backend71792 were absent at the later read-only check; no process selected by name was killed.

`idle-probe-Okz0Kh` used public read-only Electron APIs: **idle**, not locked, with display still240Hz. Idle alone does not diagnose power state, driver fault or hardware insufficiency.

The single ~8s `visibility-probe-VzkWxc` used only owned fullscreen markers/counter and a native-video viewer, **without encoder/SFU/microphone**. All four known markers matched every sample, both unfocused `showInactive` and explicitly focused; window state was visible/fullscreen/non-minimized. Source count advanced388→660 in1.609s and835→1113 in1.607s (~169–173/s), while captured counts froze across0.4–1.6s observations and video callbacks advanced only0→2 /2→3. Focus did not restore fresh-frame cadence. Its800×500 output is not compared to the main fixture.

Probe `passed:true` means **owned marker recognition and multiple frames**, not performance success. DXGI errors also appeared in its terminal output; it did not save a separate native log. The matrix's native log is the persisted failure record. Only known-pattern booleans/counters were saved, no screenshots or personal pixels. Both probe launchers returned0 naturally and their finish paths closed owned windows/local HTTP server. No settings, drivers, power/security controls or installed client were changed. No additional calibration or matrix followed.

This isolates the current failure **before encoding**, but does not close its driver/system root cause. It blocks the new fair comparison and must remain separate from frozen valid results.

## Tool changes and retained boundaries

Product normal mode uses a detached video and160×90 readback every250ms, initially `detail` / `maintain-resolution`; static classification selects15FPS. Game mode disables that sampler and uses `motion`, later `maintain-framerate`. Normal/game changes encoder policy as well as analysis work. No valid normal-mode measurement exists here; deleting the sampler or claiming zero overhead would be unsupported.

Only tools/report change in this follow-up:

- Validated `COVE_FPS_RUNTIME_NAME` isolates new evidence; launcher/Electron/backend check the directory boundary.
- Expected dimensions require complete finite positive integer pairs; actual stage dimensions/codecs are checked. Completed raw samples now save **before** assertions with contract pass/error, preventing future lost invalid cases. Source hashes include the new config helper.
- Test-only160×90 draw/read instrumentation records JS elapsed totals/maxima and actual activity/hint/policy, restores methods on cleanup, adds no readbacks/timers. It excludes luminance-loop, detached-video, asynchronous GPU and `setParameters` costs; zero counters are not total analysis cost.

No production constraints, analysis, encoder, bitrate, fake frames, GPU switches or recovery lifecycle were changed. The frozen Windows/Chromium152 ZeroCopy policy and process opt-out remain unchanged. No further low-risk measured gain was established.

The next bounded step is to restore a reproducible native baseline and repeat the
missing matrix: roughly half to one engineer-day of application-level diagnosis
and measurement once that baseline is available, excluding external driver/OS
recovery. A new native/texture capture architecture would be a separate,
multi-week implementation and cross-GPU lifecycle-validation project. Current
evidence neither proves that rewrite necessary nor supports starting it here;
this follow-up stops before another unmeasured product change.

## Evidence and checks

`runtime/fps-candidate/measurement-validity.json` remains unchanged. Frozen runs: `screen-baseline-UmiuHi`, `screen-zero-copy-cgNxgD`, `screen-repeat-baseline-QoERGc`, `screen-repeat-zero-copy-5NqjbH`, `actual-1080-baseline-AH3YhA`, `actual-1080-zero-copy-9M0uXT`, functional-only `av1-functional-yu5ktV`.

New runtime namespace `runtime/fps-validation-after-038ae81/` contains its own `measurement-validity.json`, excluded matrix raw logs/samples/source hashes/PIDs, `idle-probe-Okz0Kh` / `visibility-probe-VzkWxc` and probe scripts, plus reproducible `summarize-native-log-timing.cjs` / `native-log-timing.json`. Runtime artifacts are not committed.

Config suite: **2 tests pass**. Four CJS files pass `node --check`. Targeted fixture strict TypeScript passes with:

```powershell
node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --skipLibCheck apps/desktop/tests/ui/screen-performance-fixture.ts
```

A later rerun should use the existing runner in a fresh `fps-validation-<label>` namespace with actual stage/codec expectations and a working dynamic native baseline. Current native capture must first regain usable cadence; no OS/driver modification is prescribed or authorized by this report.
