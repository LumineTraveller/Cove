# 1080p120 throughput investigation — 2026-10-28

Work in progress on `codex/native-gpu-throughput`, from rollback commit
`578b0b418e6fa94d71409939bad9713ec9dc47b4`. This is a local experiment, not a
published update or a claim of stable 120 FPS desktop sharing. The earlier
`307981d` portable package and installed applications are unchanged.

## Measurement boundary

The machine has a 2560×1600, 240 Hz display, Ryzen 7945HX and RTX 4060 Laptop.
The existing aspect-preserving 1080p preset therefore produces **1728×1080**,
not 1920×1080. Every native result below uses actual desktop duplication,
two Chromium peers, existing product publication hooks and a loopback SFU.
Codec, Fmtp, content hint, sender maxFramerate/maxBitrate and scale are recorded.
The real sender parameters are 120 FPS, 200000000 bit/s maximum and scale 1.
No bitrate, codec, hint or image-detail policy is changed to manufacture a gain.
The native 1728×1080 path has not reached sustained 120 FPS. A passing result
means the native handoff, owned pixels and cleanup passed qualification; it does
not mean the 120 FPS target passed. The generated 1918/1920×1080 controls below
do not establish native 1920×1080 capture throughput.

Received pixels include fixed markers and an advancing sequence. Helper refresh
frames are separately counted; they are not unique desktop updates. Encoded,
decoded and compositor counts are separate. Offscreen presentation is not a
physical scan-out measurement. Whole-app CPU includes the source, sender,
receiver and browser/GPU processes, so it is not capture-only CPU.

## Ownership experiment

```text
DXGI source + cursor
  → native GPU area resize / NV12 conversion
  → three staging textures and tight, fixed-size shared-memory sections
  → verified-child, read-only mapping in main
  → three ordinary main-owned ArrayBuffers, reused only after matching ACK
  → independent structured-clone IPC buffer
  → sandbox preload CPU VideoFrame → existing generator / producer / codec / SFU
```

This CPU route is protocol 4 and is selected only with explicit native/NV12/CPU
options. It is not zero-copy. The normal BGRA GPU path and protocol 2 remain
available; old bridges without CPU capabilities cannot start this route.

Main never exposes mapped pointers or writable shared memory to renderer JS.
Every cache hit duplicates the current child's handle and compares its actual
kernel object with `CompareObjectHandles`; numeric handle reuse is rejected.
At most three read-only views and three main buffers exist per session. The
renderer must acknowledge the exact request/session/slot/serial/timestamp before
that slot and its main buffer can be reused. Stop and failure retire the session
without manufacturing a credit. CPU ACKs never substitute for GPU release permits.

Native copies check the full requested length and reject detached/shared/view
targets. Mapping and partial-copy failures are tested. The helper closes its
section owners on exit without scrubbing bytes that another process could still
be copying; initial zeroing and full tight overwrite prevent stale row padding.

The writer has one active frame and one replaceable latest frame, with a bounded
pending age. It never creates a historical frame queue. Stock is retained until
the existing producer replacement transaction commits; cancellation, leave and
late callbacks retain their previous precedence. No new capture, voice session or
remote-control grant is started by recovery.

## Actual measurements

All run directories are under `runtime/fps-validation-throughput-20261028/`.
Numbers are bounded samples after warmup, not long-call or remote-network claims.

| Real desktop case | Main accepted updates/s (legacy label) | Writer/s | Source/s | Decoded/s | Mean write / encode ms |
| --- | ---: | ---: | ---: | ---: | --- |
| BGRA, original writer (`1080-baseline-writer-full-xYhn3s`) | 111.78 | 86.77 | 85.06 | 82.06 | 6.94 / 10.08 |
| CPU NV12, allocated copies (`1080-cpu-nv12-latest-full-XrDigw`) | 96.55 | 96.71 | 95.40 | 82.01 | 0.10 / 11.04 |
| CPU NV12, cached maps, VP8 (`1080-cpu-cached-init-vp8-Fj4ZTU`) | 98.39 | 98.39 | 96.65 | 79.85 | 0.11 / 11.57 |
| CPU NV12, pooled main buffers, AV1 (`1080-cpu-pooled-av1-full-oUuiZ6`) | 111.87 | 112.03 | 110.04 | 106.59 | 0.10 / 8.17 |
| CPU NV12, query / acquire timeout, AV1 (`1080-acquire-timeout-av1-WNkh8U`) | 111.55 | 111.71 | 109.97 | 106.11 | 0.10 / 8.22 |
| CPU NV12, query / acquire poll, AV1 (`1080-acquire-poll-av1-UQbP0l`) | 110.90 | 111.06 | 108.98 | 104.97 | 0.11 / 8.18 |
| CPU NV12, acquire timeout, low main observer, AV1 (`1080-cpu-low-observer-av1-9dzx8c`) | 113.22 | 113.30 | 111.23 | 107.82 | 0.10 / 7.75 |

The first numeric column above was historically named `helperNewUpdateFps` in
the harness, but is derived from broker accepted/sent `frames - refreshFrames`
over the JS sampling interval. It is a main-boundary rate, not an independent
helper acquisition measurement. New results deprecate that name; helper capture
uses the separate cumulative helper-clock calculation described below.

These rows do not establish a direct VP8-to-AV1 optimization: codec remains a
controlled variable, and the latest row uses the user's existing AV1 path.
Within the main-copy experiment, cached allocated copy averaged 2.19 ms; pooled
copy averaged 0.80 ms. Synchronous IPC send remained about 2.42 ms. The main copy
microbenchmark alone reached 4957 FPS; it is not a capture/encode benchmark.

### Codec resource-policy control

`cpu-nv12-thread-cliff-matrix-ready-4gwW0R` uses renderer-generated CPU NV12, not
desktop capture. The same 1728×1080 effective content is placed in 1918×1080
and 1920×1080 frames, differing only in two black padding columns. This is a
diagnostic control; the product does not add padding or distort the source.

| Full coded size / codec | Source/s | Encoded/s | Decoded/s | Encode wall ms |
| --- | ---: | ---: | ---: | ---: |
| 1918×1080 / VP8 | 119.12 | 98.95 | 98.96 | 9.89 |
| 1920×1080 / VP8 | 119.13 | 112.96 | 112.88 | 8.49 |
| 1918×1080 / AV1 | 120.03 | 120.03 | 120.04 | 5.99 |
| 1920×1080 / AV1 | 119.56 | 119.56 | 119.47 | 6.54 |

The pinned WebRTC VP8 policy chooses three threads below 1920×1080 and eight at
that size on this 32-logical-core Windows host. `encoder_thread_limit` only caps
that selection; it cannot raise three to eight. AV1 uses eight at both sizes.
This control proves the AV1 encode/receive path can sustain approximately 120
distinct Full HD frames on this machine; it does not prove desktop handoff can.

### Acquire timing and observer controls

The [timeout result](../../runtime/fps-validation-throughput-20261028/1080-acquire-timeout-av1-WNkh8U/result.json)
and [poll result](../../runtime/fps-validation-throughput-20261028/1080-acquire-poll-av1-UQbP0l/result.json)
use separate helper builds with `selectedAcquireMode` recorded by the helper.
All other requested capture settings remain query completion, CPU NV12, AV1 and
the full owned-pixel reader. Poll reduced aggregate acquire wall time, but its
sample-window legacy main-accepted/source/decode rates were lower by 0.65/0.99/1.14 FPS.
One serial pair cannot establish a performance regression or a hard upper bound.

Helper timing records are cumulative. To examine steady behavior, subtract the
first and last nonfinal records whose `newFrames` lie within the corresponding
sample-window broker frame counts. These interior windows are approximately
helper seconds 6–17, rather than the entire startup-inclusive helper lifetime:

| Interior helper window | Duration s | New frames/s | Added missed ticks | Added noSlot / s | Added noPresent | Acquire wall ms | Slot-credit wait wall ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Timeout, 6.015432–17.037912 | 11.022480 | 112.50 | 0 | 82 / 7.44 | 1 | 477.364 | 1222.005 |
| Poll, 6.008352–17.041158 | 11.032806 | 110.94 | 0 | 97 / 8.79 | 3 | 227.606 | 1424.678 |

The timeout run's final 72 missed ticks include 71 by helper second 2.009 and
the remaining one by second 6.015; poll recorded zero throughout. They do not
explain a continuing steady loss of roughly eight slot opportunities per second.
`noSlot` is a helper counter, not a measurement of every distinct desktop frame
lost. The unresolved slot residency crosses main copy/send, sender dispatch,
VideoFrame construction, the listener/writer and the return ACK. Across the full
sample windows, main import/send/reference means were 0.82/2.41/10.74 ms for
timeout and 0.82/2.40/10.90 ms for poll. Reference starts before the main copy and
ends at the accepted renderer ACK; it is not pure transport or GPU time.

The [low main-observer result](../../runtime/fps-validation-throughput-20261028/1080-cpu-low-observer-av1-9dzx8c/result.json)
sets `COVE_FPS_LOW_OBSERVER=1`: only the first/last samples collect full process
CPU and window state, and sample-loop JSON serialization/synchronous file writes
are deferred until completion or failure. Every sample still obtains actual
peer statistics, the same decoded owned-pixel guards, the source sequence counter
and native broker evidence. Its legacy main-accepted/source/decode differences from timeout
are +1.67/+1.26/+1.71 FPS; these are small, unreplicated harness differences,
not product performance gains or evidence that observation is the main limit.
Import/send/reference means were 0.78/2.32/9.88 ms. The first/last full metrics
calls took 1.562/0.685 ms; source-state calls took 0.055/0.068 ms. Source-frame
queries and peer sampling are asynchronous waits: their recorded wall time,
including a 3.498 ms initial source query and 24.1–75.7 ms peer waits, must not be
reported as continuous main-thread blocking.

The owned-pixel reader runs in the viewer page's renderer main thread; native
CPU frame dispatch, construction, listener and ACK run in the sender preload on
the sender renderer main thread. They share GPU, CPU and memory resources, but
do not share a JS event loop. The main process awaits both samples and separately
performs the synchronous main copy/send/ACK handling and, in the original observer
mode, result serialization/file writes. Full readback in timeout/poll consumed
376.4/382.6 ms over 13 copies, each returning 7,464,960 RGBA bytes. These are
copy promise wall times, not a count of main-thread CPU time; allocation, buffer
zeroing and GC costs are not fully included. ROI retains the same pixel guards
but makes five copy calls per snapshot and adds synchronization. Its separate
run (`1080-acquire-timeout-av1-roi-ry5zFU`) did not demonstrate an observer
optimization. Full remains the comparison default.

### Separate helper capture and main copying

The optional `copy-complete` ownership experiment releases the native source
lease after copying into a bounded main buffer, while that main buffer still
waits for the renderer's matching final ACK. Main may discard a superseded source
candidate without copying it. Therefore helper capture, main source copies,
IPC sends, writer submissions and encoded frames are distinct counters.

The first [copy-complete result](../../runtime/fps-validation-throughput-20261028/1080-owner-copy-complete-age-ADppFE/result.json)
has an old `helperNewUpdateFps` value of 113.01; that value describes the main
boundary, not helper capture. The helper's nonfinal reports at 6.013391 and
17.031068 seconds instead give `newFrames` 520 and 1803: 1283 updates over
11.017677 helper-clock seconds, or 116.45 FPS. The separate JS sample interval
reports main copied 113.01, media source 111.54 and decoded 110.05 FPS. These
different time windows must not be subtracted as a precise per-stage frame loss.
The recorded controlled-source age observations were 13/13 matched, mean 66.22 ms
and descriptive sample p95/max 84.10 ms; they do not establish a latency tail.
This run still does not demonstrate native 120 FPS.

Future samples retain a minimal `nativeHelperTiming` snapshot from the current
active helper's last valid fixed-field TIMING record. `summary.nativeHelper`
calculates `uniqueCaptureFps` from `delta newFrames / delta elapsedUs` on that
same helper clock. Changing helper index, ownership/completion/acquire mode or
period, or any counter/time rollback, invalidates the rate. Missing helper TIMING
produces null rather than zero. Reports update approximately once per second;
each endpoint nominally precedes its JS sample by up to one report interval,
with additional scheduling/pipe delay possible. The returned helper elapsed
endpoints and duration are explicit and need not coincide with the source,
writer, encoder or decoder sampling interval.

The compatibility `nativeProvider.helperNewUpdateFps` field is now marked
deprecated and is null under `copy-complete`. `mainCopiedFrameFps` uses the
explicit `sourceCopied` counter over the JS interval. `mainCopiedUpdateFps`
subtracts the broker refresh count only when the two endpoint copy and accepted
totals coincide; otherwise its unique-update count is unknown and null. These
fields do not substitute main copies for the helper's real capture count. Old
result files are retained unchanged.

## Rejected interpretations and remaining checks

- Keeping a DXGI frame until the next nonblocking acquire alone reduced capture
  to about 60 FPS. The bounded readiness window is needed; that failed standalone
  variant is not a performance fix.
- A GPU frame `copyTo({format:'NV12'})` rejection was an API misuse. Omitting
  `format` reads the actual NV12 planes correctly. The isolated 64×64 result
  `runtime/nv12-shader-probe/interop-DA8gh1/result.json` has zero raw Y/U/V marker
  error, but a synchronous call of about 11 ms, so it is not a demonstrated fast
  route. Its local RGB blue-channel error exactly matches pinned libyuv H709
  integer constants; it must not be confused with an RTP metadata failure.
- VP8 over the current SFU does not negotiate the color-space RTP extension.
  The implemented CPU-input policy follows the existing producer codec: VP8 uses
  limited SMPTE170M/BT601 and validated AV1 uses limited BT709; ambiguous or
  unverified codecs retain stock. It changes input conversion metadata, not the
  codec choice, bitrate or palette. The real desktop
  [color-contract result](../../runtime/fps-validation-throughput-20261028/native-601-709-contract-5o2ruS/result.json)
  passed both paths at 1728×1080. Receiver VP8 frames were I420 with SMPTE170M
  primaries/transfer/matrix and limited range; AV1 frames were NV12 with BT709
  primaries/transfer/matrix and limited range. Maximum RGB marker channel error
  was 4 for VP8 and 3 for AV1, under the unchanged pixel guard. Both cases and
  final resources cleaned up. This validates these bounded cases, not every
  remote device or a delivery-default decision.
- Occasional native preparation timeouts safely retain stock. Successful helper
  initialization measured 394–448 ms; this does not explain all earlier failures.
  Startup timing excludes OS process/DLL load. The failed startup trace
  `1080-pooled-query-startup-trace-v2-Ct4lQE` recorded an OK bridge response after
  477 ms and `deadline_timeout` at 1502.9 ms. In the following 1.043 s of helper
  loop time it made 78 acquires, all WAIT_TIMEOUT, with zero frames. Source JS
  advancement/visibility alone does not prove DWM presentation or desktop updates.
  Do not blame shader compilation or extend the startup deadline from this evidence.
- Display availability is a separate unresolved startup condition. A later failed
  fence preparation (`1080-fence-pooled-av1-awake-Sczktb`) also had an advancing,
  visible, focused source and zero successful acquires despite an active display
  sleep blocker. Following an operator-reported local display wake, the
  [fence run](../../runtime/fps-validation-throughput-20261028/1080-fence-display-wake-av1-e9pOL7/result.json)
  passed. That single recovery is consistent with display/presentation state
  affecting acquisition; it does not prove sleep caused all failures. The fixed
  suspend/resume/lock/unlock event counters were zero. The opt-in blocker prevents
  display sleep while owned, is stopped on normal/error cleanup, and neither wakes
  an already unavailable display nor bypasses a lock. No OS power setting was changed.
- Fence completion is implemented and the successful run records actual helper
  `selectedCompletion: fence`; it reached helper/source/decode 107.01/105.02/102.52
  FPS, showing no improvement over the recorded query runs. This bounded experiment
  does not justify changing the default query barrier. CPU staging Map readiness
  remains independently enforced with a bounded wait. GPU completion, slot identity
  and cancellation stay enforced; wait durations are host wall time, not pure GPU
  execution. The later native-steady trace
  `1080-pooled-query-mapready-trace-awake-G9engI` passed native/pixel qualification
  but is `profilingOnly`; its throughput numbers are not benchmarks.

## Reproduction and logs

Use `node tooling/verify-screen-performance.cjs` with a unique `COVE_FPS_LABEL`
and `COVE_FPS_RUNTIME_NAME=fps-validation-throughput-20261028`. Explicit native
artifact variants fail if absent; the launcher never silently reuses an old
binary. It records hashes of source, helper, addon and effective writer.

`COVE_NATIVE_GPU_CAPTURE_TIMING=1` emits bounded fixed-field stage diagnostics.
`COVE_NATIVE_CAPTURE_STARTUP` and `COVE_NATIVE_CAPTURE_TIMING` are collected
separately. They contain counts and times, not handles, ICE credentials, source
images, user labels or full SDP. Trace exports are limited to owned processes,
remove arguments and delete raw exports after sanitization.

The bounded VP8/AV1 color qualification above is complete. The latest complete
CPU desktop regression is recorded below (830 tests); current repeated native
lifecycle/minimization, final same-code validation and the delivery decision
remain pending. No new portable candidate is frozen here.

## Full lease measurement and rejected transport alternatives

`1080-native-lease-residence-VrUo8A` uses the default query/timeout mode,
low-observer harness, actual native CPU capture and the existing AV1 publication.
It passed pixel, codec, native-upgrade and resource-cleanup checks. During the
12-second sampling window, helper unique updates were 113.69/s, renderer writes
113.93/s, media-source 112.00/s and decoded frames 109.49/s. Refresh frames and
writer drops were zero. This remains below the requested native 120/s.

The helper now observes imported/released commands using its own monotonic clock,
from each frame's original sentAt. Final whole-run distributions (including
startup) were:

| Same-clock residence | Count | Mean ms | Max ms | Strict period buckets |
| --- | ---: | ---: | ---: | --- |
| sent to imported | 1854 | 6.345 | 83.863 | 1435,319,63,14,10,13,0 |
| sent to released | 1851 | 14.288 | 93.158 | 498,822,406,66,30,29,0 |

Buckets are `<1T,<2T,<3T,<4T,<6T,<12T,remaining`, T=8333 microseconds. These
include helper stdout scheduling, the main copy/transport, renderer processing
and command return/pump as applicable. They are not one-way IPC latency. A main
`reference` measurement alone misses the helper-to-main and command-pump tails.
The next controlled change should target this tail while retaining three slots
and the original final ACK, rather than assuming average occupancy is the cap.

The CPU-only transport probe used an owner-bound native 120 Hz pacer and real
sandboxed Electron44 VideoFrame(transfer), with independent sequence/pixel checks:

- `runtime/cpu-frame-socket-probe/run-RvbTKN`: 57 independent 48 KiB chunks per
  frame; 119.62 validated frames/s, main send including chunk copies 4.325 ms,
  final ACK round trip 6.911 ms, app CPU 1.709 core equivalents.
- `run-fq6RIt`: same chunk envelope but one full-sized independent buffer;
  119.75/s, send 3.303 ms, ACK 8.686 ms, app CPU 1.252 cores.
- The earlier direct whole-frame IPC control `run-eF2I0e` was 119.99/s,
  1.938 ms send / 4.838 ms ACK. Loopback WebSocket alternatives also approached
  120/s but had no final-ACK advantage. None is desktop or codec qualification.

Chunking adds CPU and sends; it is not integrated. A utilityProcess/private-port
topology can move main JavaScript work, but Electron44's MessagePortMain also
clones ArrayBuffers and has additional wire copies. Moving a cost is not proof
of eliminating it; no utility broker is added without a measured benefit.

## Old path compatibility and validation status

Two AV1/BGRA GPU-sharing controls failed safely with receiver_failed after GPU
references remained outstanding: current helper `1080-bgra-baseline-av1-low-tSfywF`
(9 frames) and the preserved original helper `1080-old-helper-bgra-av1-zlmx8C`
(15 frames). Both cleaned resources to zero. This reproduces a limitation in the
previous GPU route; it is not evidence of a new CPU-route regression or a reason
to relax allReferencesReleased. That GPU/AV1 combination is not qualified.

The ordinary non-native Chromium path `1080-stock-av1-low-5p7eDF` passed with
44.66 source/decoded frames per second under the same controlled desktop workload
and sender parameters. This is one local baseline, not a promise about every
application, codec or computer.

At commit b0b9d13, the existing complete desktop test command passed **738 tests**,
zero failures/skips/cancellations. Both renderer and Electron noEmit typechecks
passed using the repository's existing root TypeScript. Native diagnostic
variants each passed 272 CPU self-tests and strict -Werror builds; the residence
collector passed 26 pure tests. New experimental scheduling must be independently
qualified after these checks and is not covered by that earlier full-suite run.

## Independent CPU-pool experiment: mechanism and current limits

The opt-in `cpuOwnership: copy-complete` route keeps three native source sections
and three separately indexed ordinary main ArrayBuffers. Native metadata keeps
its original helper slot/serial. A successful synchronous copy, or an explicit
never-to-be-read discard, returns that exact native credit. The final renderer
ACK returns only its main-buffer lease. At most one latest uncopied candidate
is retained, with a two-period arrival-age bound and the original 1500 ms total
deadline. The mode requires the existing cached read-into addon capability.
Default `final-ack` and GPU ownership remain unchanged. IPC/browser clones are
additional memory, not included in the shorthand three-plus-three pool count.

A final independent review found two deadline bypasses in pending discard and
supersession after a long event-loop stall. Both were corrected before the new
mode's first actual run; deterministic tests cover the exact 1500 ms boundary.
The final selected three CPU suites passed 165 tests, and the complete desktop
command after these changes passed **830 tests**, zero failures/skips. This is
correctness evidence, not a stable-120 or release-qualification claim.

`1080-owner-copy-complete-age-ADppFE` passed a short actual-desktop case: its
interior helper interval was 116.45 unique updates/s, main writes 113.25/s,
media-source 111.54/s and decode 110.05/s. Source-draw-to-receiver-snapshot
observations had sample median 65.8 ms (13 observations); the paired old-owner
case's median was 75.4 ms. These small samples do not establish tail latency.

Two consecutive `child.stdin.write` calls left about 2.54 ms between helper
import and release in that case. Combining the two valid newline commands into
one write removed that interval (`1080-copy-credit-batch-age-rHx5ob`: import
8.2010 ms vs release 8.2016 ms in an interior helper window). A batch remains a
byte stream, not an atomic OS transaction; partial delivery and later pipe error
retire the session safely. Despite the mechanism change, that short run's main
writes were only 106.80/s and source 105.29/s. It is not a demonstrated overall
throughput win.

Both longer 30-second ownership comparisons failed the encoded-dimension guard:

- `1080-copy-batch-30s-NHtVFw`: later encoded output became 1152x720 with
  qualityLimitationReason=cpu. Raw helper interval was 116.10/s, media-source
  110.56/s; these mixed-resolution codec numbers are not sustained 1080p results.
- `1080-final-ack-30s-8yhRox`: the original owner route also changed to 1152x720.
  Helper interval 115.16/s and source 113.68/s are separate capture observations;
  the case is still a qualification failure.

All resources returned to zero in both cases. Encoder adaptation was observed,
not disabled or hidden. The requested codec, bitrate and resolution policies
were not modified to make either result pass. Neither ownership mode is marked
as sustaining the requested 1080p120 output.

## Public GPU readback API investigation

A separate blank-page Electron44 check (`runtime/cpu-frame-platform-8urT8k/`)
found SharedArrayBuffer unavailable and crossOriginIsolated=false in both current
file:// and plain HTTP pages, including sandbox preload world 999. A correctly
COOP/COEP-isolated owned loopback page exposed SAB with COI=true. No exception
feature flags or product security changes were used.

Pinned Chromium CopyToAsync requires a pinnable shared destination; ordinary
ArrayBuffer falls back to synchronous readback. NV12 uses a single sequenced
background worker; RGB can enqueue asynchronous client queries, while the GPU
service still performs synchronous ReadPixels and then copies into SAB. Async
JS completion does not imply parallel GPU DMA or zero-copy. These facts justify
the isolated AB/SAB probe, not a product migration.

The first 64x64 probe `readback-BOcEUC` passed raw NV12 bytes and source sequence
but failed its later CPU-RGB reference check. That failure is preserved; the
pinned libyuv H709 integer reference is being verified before continuing. It
must not be fixed by changing shader pixels or loosening raw-plane tolerances.

A second public candidate is GPU drawImage into an opaque Canvas2D followed by
Canvas capture. On supported Windows paths this uses an upstream async staging
readback into mappable NV12, and may release the original native GPU input before
the full conversion finishes. It adds an RGBA copy, has no public pending-work
bound and has background/minimization and color constraints. Only a finite
synthetic qualification tool is being prepared; no product Canvas route is added.

### Existing output-adaptation policy explains the 720p observations

The two 30-second cases' actual sender parameters were `maintain-framerate`
throughout all 31 samples. The existing five-second screen ramp guard ends
before the first measured sample, then motion/game plus non-native-resolution
preset explicitly selects that preference in screenCapture.ts / useScreenAnalysis.ts.
Enabling a native capture backend is different from choosing the existing
retain-native-display-resolution option. No explicit maintain-resolution setting
was ignored in these cases.

The outbound ID, source SV3 and track token remained bound to the same 1728x1080
source. The CPU adapter's 3/5 pixel budget and 2/3 width/height step explain the
exact 1152x720 output. Copy-batch first changed at sample 28; final-ack at sample
19. Removing transition/mixed-size intervals gives copy-batch source/encode/decode
110.17/108.23/108.23 and final-ack 112.90/109.69/109.63. Whole-window codec FPS
therefore must not be represented as fixed-1080p throughput.

The explicit degradation preference takes precedence over Fluid content hint;
libaom REALTIME resize/superres defaults are off. The zero resolutionChanges
counter measures active spatial-layer-set changes and does not refute this
single-layer CPU downscale. Existing adaptation is intentionally preserved.
