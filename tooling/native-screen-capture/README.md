# Native desktop-duplication stage probe

This diagnostic separates elapsed time from executing-thread CPU time around DXGI/D3D11 calls. It does not encode video or measure complete Cove/WebRTC performance. It does not alter drivers, OS scheduling, global timer resolution, production files, or browser flags.

## Existing toolchain and build

The machine has `C:\Strawberry\c\bin\g++.exe` (GCC 13.2.0, x86_64-w64-mingw32), matching Windows interface headers/import libraries, and Microsoft Windows SDK 10.0.22621.0/10.0.26100.0 headers. MSVC and clang were not found during this task; .NET Framework v4 `csc.exe` is present. Nothing is installed by this workflow.

The C++ source includes the compiler's actual `d3d11.h`, `dxgi1_2.h`, `windows.h`, and WRL headers. The relevant declarations were cross-checked against Microsoft SDK 26100. There are no handwritten COM vtable offsets. `build.ps1` statically links the existing compiler runtime and only writes its executable under the repository's ignored `runtime/native-screen-capture/` directory.

```powershell
& .\tooling\native-screen-capture\build.ps1
```

Building does **not** execute the binary. Run GPU work only after the parent benchmark coordinator has allocated an exclusive window.

## Scheduled execution

First run the GPU-only self-test. It creates a known 64×64 BGRA default texture, copies it to a staging texture, maps it, and checks every known byte with the actual `RowPitch`. It prints no pixels or content hash and uses no desktop-duplication API.

```powershell
& .\runtime\native-screen-capture\dxgi-microprofiler.exe --self-test
```

Profile mode also requires that self-test to pass on the exact adapter selected for the owned source. Supply the HWND/PID from the coordinator's own synthetic fullscreen source, after explicitly showing and focusing it. There is no default HWND, monitor, ordinary-desktop fallback, WARP fallback, or retry after access loss.

```powershell
& .\runtime\native-screen-capture\dxgi-microprofiler.exe --profile --owned-hwnd 0xYOUR_HWND --owned-pid YOUR_PID --seconds 10 --mode readback-copy --poll-us 1000
```

`--selftest` is an alias for `--self-test`. There is no native `--output` option: the coordinator saves stdout, so the probe never chooses or overwrites a file.

The three modes isolate progressively more work:

- `acquire-only`: `AcquireNextFrame(0)` and `ReleaseFrame` without desktop GPU copies/readback.
- `readback`: add full native-size `CopyResource → Map(READ) → Unmap`.
- `readback-copy`: also copy each mapped row into a temporary CPU buffer.
- `gpu-scaled-readback-copy`: copy the acquired GPU texture to an SRV, draw a
  full-frame bilinear scale into an even-sized BGRA target bounded by height
  540, then read back and copy only the smaller image. This is a diagnostic
  alternative, not the application's capture provider.

Check the supplied source's PID, visibility, foreground status, and complete monitor coverage before duplication and before each acquisition. Per-monitor-v2 DPI awareness is required to make these coordinate checks meaningful. Guard loss marks the run invalid and exits. These window checks cannot atomically prevent a notification or unrelated overlay from appearing between checking and acquisition; use a controlled source window and test session. No pixel bytes or image artifacts leave temporary process memory; the CPU destination buffer is cleared after the measured interval or on exception. The only output is numerical timing/counter JSON on stdout; errors go to stderr with a nonzero exit code. The coordinator may save that numerical output.

Empty acquisition uses a **process-local high-resolution waitable timer**, not `Sleep(1)` or `timeBeginPeriod`, to avoid inventing a ~64 FPS limit from coarse sleeps. `pollBackoff` records the actual delay. A zero polling interval explicitly uses `SwitchToThread`; its CPU cost is included in total-thread counters. Release is adjacent to the next acquisition, after all uses of the prior surface finish. `LastPresentTime == 0` pointer-only acquisitions are counted separately; duplicate nonzero timestamps are also counted separately. `desktopFps` counts unique increasing present timestamps, while `processedDesktopFps` counts every nonzero-timestamp acquisition. `valid=true` establishes API/ownership-guard success and does not establish that the synthetic source actually presented at 120 Hz.

## Reading the measurements

Every stage records QPC wall time, `GetThreadTimes` kernel/user execution time, and raw `QueryThreadCycleTime` cycles. `emptyClockPair` reports instrumentation overhead. Thread CPU time is coarse at individual-frame scale: interpret aggregate totals, not one-frame CPU quantiles. `desktopIteration` includes instrumentation and acquisition/readback/copy work, excludes the next `ReleaseFrame`, guard, and timeout backoff; these have separate stages. Overall thread CPU also includes loop/instrumentation overhead. Stage samples are aggregate metrics and contain no content identifiers.

`CopyResource` queues asynchronous GPU work. Its short return time does not establish that the GPU copy completed. A high-wall, low-thread-CPU `Map` supports waiting rather than CPU execution, but wall-minus-thread-CPU also includes scheduling delays and must **not** be labeled pure GPU time. Raw cycles must not be converted to milliseconds. There are no GPU timestamp queries in this minimal probe.

To test the proposed “50% wall time becomes a CPU budget” explanation, compare identical owned-source runs across the three modes, then inspect mean `desktopIteration` wall time alongside **aggregate** stage and total-thread CPU. Compute hypothetical budgets from wall time and measured CPU separately; the tool deliberately does not report either as a product FPS ceiling. A native 120 FPS result is not evidence that Chromium plus encoding plus transport can sustain 120 FPS.

Relevant primary API contracts:

- [AcquireNextFrame](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-acquirenextframe)
- [ReleaseFrame and recommended release timing](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-releaseframe)
- [Frame metadata and pointer-only updates](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/ns-dxgi1_2-dxgi_outdupl_frame_info)
- [CopyResource asynchronous execution](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-copyresource)
- [Map](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-map)
- [GetThreadTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getthreadtimes)
- [QueryThreadCycleTime limitations](https://learn.microsoft.com/en-us/windows/win32/api/realtimeapiset/nf-realtimeapiset-querythreadcycletime)

## GPU scale variant and controlled result

The current build produces `runtime/native-screen-capture/dxgi-microprofiler-gpu-scale.exe`
and links the existing system D3DCompiler. It does not replace the earlier
baseline executable; the original source, executable and hash are preserved in
`runtime/native-screen-capture/baseline-37dedcc3/`.

GPU self-test checks 64x40 to 32x20, identity-size, and odd-size scaling against
a CPU bilinear reference for every output pixel. The source has quadrant colors,
x/y gradients and varying alpha. It checks row pitch, full-frame direction and
channel values with tolerance 3; actual maximum error was 1. This is not a
lossless or perceptual quality equivalence claim.

`native-api-WhJYzQ`, under `runtime/fps-validation-efficiency-20261028`, completed
four six-second modes in ABBA order with one source, one executable and no codec:

| Mode | Distinct presents/s | Capture/readback/copy iteration mean |
| --- | ---: | ---: |
| Full-size readback/copy A | 183.31 | 3.304 ms |
| GPU scale then smaller readback B | 239.80 | 0.649 ms |
| GPU scale then smaller readback B | 239.48 | 0.669 ms |
| Full-size readback/copy A | 187.49 | 3.227 ms |

Input is the complete 2560x1600 monitor; GPU scale output is 864x540. Mean Map
time changes from approximately 1.49 to 0.45 ms, and mean CPU row copy from 1.70
to 0.13 ms. These measurements exclude Chromium color conversion, WebRTC, the
encoder, SFU and viewer. They show where work can be removed, not a delivered
product FPS improvement. Loop guard, polling and release are separately timed.

The coordinator is `tooling/verify-native-capture.cjs`. Set `COVE_NATIVE_MODES`
to a comma-separated bounded list to repeat modes; it defaults to the original
three. Use the named executable inside this investigation's runtime, with
`--exe <path> --seconds 6`. `--focus-wait-ms` in the native probe waits at most
20 seconds for the same ownership/foreground condition **before** capture; it
never captures while waiting or injects input. Guard loss still invalidates a
run. Windows foreground restrictions and a busy UI helper invalidated several
earlier repetitions; they are retained as failures, not averaged into ABBA.
