# Windows screen capture: measured throughput and scoped improvement

2026-10-23 UTC. Checkout baseline: `e31362c`; isolated local tests only. No installed client, live server, system security setting, encoder limit, capture lifecycle, resolution policy or release version was changed.

## Result and production change

The shared monitor-capture path is the main limit in this controlled test. On the same changing 240 Hz monitor, the selected 540p/120/VP8 profile improved from **54–56 captured/decoded FPS to 77–78 FPS** with Chromium's existing `ZeroCopyDesktopCapture` conversion path. Two independent process runs reproduced the improvement, approximately 39–42%. A separate pair with an actual **1728×1080 input/output** improved from **46.54 to 58.62 FPS**, approximately 26% in one comparison. **120 FPS remains unachieved on the monitor path.** The generated-source and owned-window controls reached about 119 FPS; those controls are not evidence that desktop monitor capture reaches 120.

Production only merges `ZeroCopyDesktopCapture` into Windows startup for the measured Chromium major version 152. External `--disable-features` remains authoritative. Set `COVE_DISABLE_ZERO_COPY_DESKTOP_CAPTURE=1` before launching a new process to restore Chromium's legacy conversion branch. Existing feature choices are preserved; other operating systems and unvalidated Chromium majors retain their earlier defaults. The older `AllowWgcScreenCapturer` entry is preserved for compatibility but must not be interpreted as proof that WGC is selected.

The optional capture-size constraint experiment is **not shipped**: a single 540p sample changed 56.35 to 59.11 FPS, insufficient evidence of a stable gain. Leaving capture constraints unchanged also preserves native-resolution sharing and existing 540p-to-1080p source updates. No bitrate ceiling or startup bitrate was increased.

## Machine and method

- Windows `10.0.22631` (Windows 11 23H2), AMD Ryzen 9 7945HX, 32 logical processors, 16 GiB RAM.
- NVIDIA GeForce RTX 4060 Laptop GPU, driver `32.0.15.6094`; GPU acceleration enabled after initialization.
- Display 2560×1600 at 240 Hz, scale 1.5 (1707×1067 device-independent pixels).
- Desktop Electron 44.0.0, Chromium 152.0.7977.54, embedded Node 24.18.1; standalone test launcher Node 24.11.1.
- Existing product `useWebRTC` publishing/viewing hooks, two real Chromium peers, real mediasoup and SQLite in a private loopback SFU, independent profile/cache/database and random media port per run. Physical microphone access is replaced with generated audio on a silent sink.
- A runner-owned fullscreen window covers the selected monitor and paints a moving block, background change and frame counter at a measured 239.7–240 FPS. Monitor tests require the Electron display handler to run. No screenshot of a personal application is retained.
- Each comparison uses five seconds of warmup and eight seconds of counters sampled about once per second. Screen activity analysis is disabled by the existing game-mode setting. The same resolution, frame-rate and encoder settings are compared. Receiver video uses an offscreen compositor; this measures its video/compositor counters, not physical display scan-out.
- During coordinated comparisons the other agents avoided large builds. Raw files record each test application's per-process CPU and memory samples. The sum of Electron `percentCPUUsage` averaged 7.34 in the repeated baseline and 8.71 with the faster path; this is not a complete system-wide load measurement. WMI hardware queries were denied; no system permissions were changed.

## Stage measurements

All rows below are real **monitor** capture. “540p/1080p” is the selected preset; actual capture and encoded dimensions are listed separately because a label does not establish captured pixels.

| Run / profile | Capture pixels | Encoded pixels | Source FPS | Encode FPS | Send FPS | Decode FPS | Encode ms/frame |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Default constraints, 1080p selected, VP8 | 1000×624 | 1000×624 | 54.29 | 54.29 | 54.29 | 54.29 | 3.71 |
| Baseline, 540p VP8 | 1000×624 | 865×540 | 56.35 | 56.35 | 56.35 | 56.47 | 3.67 |
| Baseline, 540p AV1 | 1000×624 | 865×540 | 56.01 | 56.01 | 56.01 | 56.00 | 3.06 |
| Zero-copy, 540p VP8 | 1000×624 | 865×540 | 78.44 | 78.57 | 78.57 | 78.44 | 3.03 |
| Repeated baseline, 540p VP8 | 1000×624 | 865×540 | 54.23 | 54.35 | 54.35 | 54.23 | 3.78 |
| Repeated zero-copy, 540p VP8 | 1000×624 | 865×540 | 76.87 | 76.87 | 76.87 | 76.75 | 3.45 |
| Explicit 1080-height baseline, VP8 | 1728×1080 | 1728×1080 | 46.54 | 46.54 | 46.54 | 46.54 | 6.31 |
| Explicit 1080-height zero-copy, VP8 | 1728×1080 | 1728×1080 | 58.62 | 58.75 | 58.75 | 58.62 | 6.44 |

The repeated receiver presented-frame rates were 54.35 and 76.75 FPS. No artificial duplicate-frame producer or counter adjustment is used. Small sub-frame differences between stage rates follow sampling time and pipeline occupancy. VP8 was `libvpx`; AV1 was `libaom`, both software encoders. Those results show that the monitor source is the dominant common limit for this simple workload; they do not exclude encoder or shared CPU/GPU pressure with more complex content.

The explicit 1080-height comparison requests a 1920×1080 bound only in the test fixture and asserts actual capture, encoding, decoding and video intrinsic dimensions of 1728×1080, preserving this monitor's 16:10 ratio. Its baseline/zero-copy source ran at 239.64/239.83 FPS; receiver presented rates were 46.56/58.62 FPS and decode time 4.49/4.47 ms per frame. Both runs stopped their backends. These are one comparison at actual 1080 height, not the earlier preset-only 1000×624 rows or physical display scan-out.

The optional 960×540 capture cap actually yielded 864×540 for this 16:10 display: baseline source/send 59.11 FPS and zero-copy 81.04 FPS. That dimension-changing experiment is retained as an experiment only. **Zero-copy AV1 throughput, normal-mode activity analysis, physical viewer scan-out, WAN/network loss, long-duration thermal behavior, other GPUs/OS builds and end-to-end latency were not measured.** Do not extrapolate the VP8 gains to those conditions.

## Why lowering the preset was insufficient

`screenCaptureVideoConstraints` requests only preferred/maximum frame rate. The selected preset is applied later through RTP `scaleResolutionDownBy`; it does not guarantee a proportionate reduction of work in the native monitor capturer. In this exact test the browser delivered 1000×624 at both preset selections, rather than the native monitor pixels promised by an old source comment. Actual `getSettings()` and media-source dimensions are authoritative.

The exact [Chromium 152.0.7977.54 desktop-capture implementation](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.54/content/browser/media/capture/desktop_capture_device.cc) gates monitor WGC on Windows 11 24H2/build 26100, while window WGC is allowed on this older system. It also schedules capture under a 50% single-core time budget. The native test log confirms `allow_wgc_screen_capturer: 0`, `allow_wgc_window_capturer: 1`; after the optimization it records capture durations around five milliseconds and scheduled periods around 10–11 milliseconds. This supports the remaining capture-budget explanation without claiming a particular graphics API merely from a flag name. The same implementation branches between `OnCaptureResultZeroCopy` and `OnCaptureResultLegacy` using the feature; disabling it selects the existing legacy branch.

The owned-window control delivered approximately 119.6–120 FPS. A separately paced `MediaStreamTrackGenerator` with distinct pixels/timestamps delivered approximately 118.9 source/send and 118.8 decode FPS at a 540p output. Neither control replaces the monitor result.

## Stability and cleanup validation

`recovery-final-cOt6Ly` is the final functional validation, excluded from performance comparisons because it ran during other work with a short sample:

- Only this test application's GPU subprocess was terminated. Electron created a different GPU PID and current-receiver decoding resumed in 627 ms.
- A decoded background pixel was `[23, 51, 76, 255]`, consistent with the controlled source rather than a black frame.
- Product stop ended all original native source tracks. Republishing produced a different receiver-track token; the same new receiver/report then decoded **30 additional frames**. Full-PC historical counters cannot satisfy this assertion.
- Both renderer cleanups were deliberately left unresolved. Two-second cleanup deadlines forced destruction of only the owned windows, and the backend still stopped successfully (`cleanupTimeouts: 2`, `backendStopped: true`).
- `backend-disconnect-LOAEaR` independently closed the parent's IPC channel after backend readiness. The backend exited by itself with code 0 in 34 ms.

An additional functional-only run, `av1-functional-yu5ktV`, used the zero-copy
path with actual `video/AV1` / `libaom`, without a VP8 fallback. The current
receiver decoded 22 additional frames and a non-black pixel; product stop ended
the original tracks, and a different receiver track then decoded 24 additional
frames. Cleanup completed without timeouts and the backend stopped. This short
run overlapped compilation and is excluded from all throughput comparisons;
zero-copy AV1 throughput remains unmeasured.

Six feature-policy tests cover platform/version guards, preserving external parameters, explicit feature disable and process rollback. Together with existing screen capture/publishing tests, 24 tests passed. The new policy and performance fixture passed targeted TypeScript checks; JavaScript runners passed syntax checks. Full desktop integration checks are owned by the parent task.

## Evidence and rerun

Raw artifacts remain under `runtime/fps-candidate/` and are intentionally not committed. Each complete run has `source.json` hashes, `result.json`, `electron.log`, Vite logs, isolated database/profile and optional `native-capture.log`.

Valid throughput runs: `screen-baseline-UmiuHi`, `screen-zero-copy-cgNxgD`, `screen-repeat-baseline-QoERGc`, `screen-repeat-zero-copy-5NqjbH`; actual 1080-height pair: `actual-1080-baseline-AH3YhA`, `actual-1080-zero-copy-9M0uXT`. Window-only control: `native-real-R0kqh9`. Final stability checks: `recovery-final-cOt6Ly`, `backend-disconnect-LOAEaR`, `av1-functional-yu5ktV`. `measurement-validity.json` indexes all runs.

Earlier failed/calibration runs are preserved: `baseline-Yit24K` hit sandbox process creation limits; `baseline-wujz1n` hit an unclonable Socket cleanup return value; `baseline-ObClUu` used a Chromium fake-device flag; `native-baseline-X44wit` used a fake-UI flag which bypassed the intended display handler. Their native rows are excluded even if an earlier runner wrote `passed: true`. Generated-source rows are controls only. Preliminary stop/reacquire assertions in old runs were superseded by the receiver-bound final test above.

From the repository root, run the two conditions sequentially with no competing heavy build:

```powershell
$env:COVE_FPS_CASES='[{"source":"native","captureTarget":"screen","preset":"540p","fps":120,"game":true,"compatibility":true}]'
$env:COVE_FPS_CAPTURE_LOGS='1'
$env:COVE_FPS_CAPTURE_FEATURES=''
$env:COVE_FPS_LABEL='baseline'
node tooling/verify-screen-performance.cjs
$env:COVE_FPS_CAPTURE_FEATURES='ZeroCopyDesktopCapture'
$env:COVE_FPS_LABEL='zero-copy'
node tooling/verify-screen-performance.cjs
```

For a functional-only recovery run, add `COVE_FPS_RECOVERY_CHECKS=1`; `COVE_FPS_CLEANUP_HANG_CHECK=1` additionally checks bounded cleanup. Clear these variables for throughput comparisons. No existing Vite/SFU service is needed or stopped. The fullscreen test window temporarily covers the monitor and is destroyed on completion.
