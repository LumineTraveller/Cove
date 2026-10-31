# Live frame pacing investigation, 2026-10-30

The two low-frame-rate rows now follow resolution in the detailed desktop
diagnostic overlay. The compact overlay retains its existing single relevant
low metric, also below resolution. The existing sanitized diagnostic exporter is
reachable from the header. These UI changes do not restart media or change
capture, encoding, bitrate, transport, or resource ownership.

## What was actually observed

The live client was sharing the primary desktop at 1728x1080, native GPU BGRA,
Generator, game mode and a requested 120 fps. Its preview included itself over
the mostly static desktop/chat window. That is a feedback scene, not an
independent uniform-rate input. This observation alone does not prove the cause
of every slow frame.

The first saved history contains 600 overlapping one-second snapshots from
05:38:03.418 to 05:48:02.420 UTC (13:38:03 to 13:48:02 China time). The history
also includes user/diagnostic actions and window-state changes; it is not an
unattended standardized performance benchmark. All 600 encoded/sent rates were
zero and the encoded-frame counter remained at four. There was no progressing
outbound video encoder workload in this interval.

| Whole 599.002-second history | Observed value |
| --- | ---: |
| Received / written frames | 70775 / 70760 |
| Received / written FPS | 118.155 / 118.130 |
| Busy queue drops / expired pending frames | 16 / 0 |
| Mean write / queue wait | 2.184 / 0.0125 ms |
| Writes longer than the 8.33 ms target period | 46 |

The last 300 seconds were 119.289 received / 119.279 written fps, with three
busy drops. In the worst two individual seconds, received/written were 17/17
and 14/14, without new writer drops or over-period writes. The initial shortage
was already present before this writer queue. This does not, by itself, exclude
indirect GPU resource feedback; helper-side evidence is required too.

Native delivery low values ranged from 12.30 to 106.90 fps. The P05/median/P95
over these **overlapping rolling-window values** were 20.63/89.78/106.22 fps;
these are not independent raw-frame percentiles. A rolling 30-second low can
remain depressed after ordinary throughput has recovered. Thirty-two low
snapshot seconds are not thirty-two independent stalls.

## The worst event aligned with helper counters

The archived helper/broker observation covers the same event. For report
endpoints 05:38:53.358 -> 05:38:58.358 UTC:

| Counter / stage | Delta / mean |
| --- | ---: |
| Helper elapsed time | 5.019638 s |
| New output frames / desktop source presents | 310 / 201 |
| No-present expired windows / no-slot windows | 188 / 0 |
| Missed scheduled ticks / slot-wait windows | 104 / 0 |
| DXGI timeout calls | 215 |
| Total / mean timeout wall time | 2452.959 / 11.4091 ms |
| Successful acquire mean wall time | 0.7576 ms |
| GPU-completion wait / tick lateness mean | 2.0180 / 3.4044 ms |
| Broker import / transfer / reference mean | 0.1218 / 0.6982 / 5.1705 ms |

The code requests at most one millisecond in `AcquireNextFrame`, but that
argument is not a preemption deadline for the actual synchronous wall time.
An 11 ms call can cross an 8.33 ms capture budget. The adjacent healthy window
had a 3.9061 ms mean timeout and 0.5946 ms mean tick lateness. This is concrete
evidence to investigate readiness waits and scheduling rather than enlarge the
texture pool or tune a non-progressing encoder.

The worst window had no slot-credit wait; imported residence had no observation
at or above 16.67 ms, and helper lease residence had none at or above 25 ms.
Three no-slot events and some writer drops appeared in the following recovery
window. Downstream feedback therefore existed during recovery, but the evidence
does not support it as the first trigger of this event.

Helper timing is approximately one-second cached data and broker reporting is
five-second data. Endpoint alignment can differ by a helper report interval.
These are time-window correlations, not an individual-frame causal trace. Do
not attribute lifetime maxima to this event when the maxima did not increase.

## What the metric includes

Native delivery uses the helper's actual post-GPU `sentAt` timestamp. It is not
raw DXGI acquisition, pure GPU execution, encode FPS or physical presentation.
The helper outputs only dirty desktop/cursor updates, plus a 250 ms idle
keepalive. Content that stops updating can therefore lower delivery low even
without a capture performance defect. Repeating old frames or regularizing
timestamps would conceal this and was not done.

Presentation uses the existing video's compositor submission timestamps. The
API can miss callbacks, especially under main-thread load; it does not establish
physical monitor scan-out. See the [video frame callback specification](https://wicg.github.io/video-rvfc/).

In the 600-snapshot history, presentation was ready 240 times, incomplete 354,
unavailable five and sampling only once. There is no evidence of continuous
reset. Per-window missed-callback coverage had a median of 0.0562% and a maximum
of 0.8439%. The 354 incomplete windows do **not** mean 59% of video frames were
lost; any missing callback conservatively suppresses the value for that rolling
window. Among complete presentation windows, native low had a median of 103.67
fps versus 85.39 fps for presentation, so the video/compositor stage adds a
separate tail and must not be conflated with native delivery.

## Evidence and remaining work

### Same-session independent-motion control

A separate, non-focusable, always-on-top approximately 160x96 DIP window showed
only a 128x64 CSS-pixel animated region. It neither captured media nor connected
to Cove. The existing capture/voice session continued: dynamic from
06:00:04.475 to 06:00:49.507 UTC, then the same window stationary until
06:01:34.524. Its dynamic rAF after 15 seconds was 239.9986 fps; stationary
rAF count increment was zero. rAF is not proof of physical scan-out. This
introduces a small additional compositor workload, so it is a limited control,
not a claim of identical GPU conditions.

Each LOW comparison uses only the last 15 one-second snapshots of a 45-second
phase: their entire preceding 30-second measurement window lies within that
phase. Taking all of a phase's last 30 snapshots would mix the preceding phase
into the first 15 and is invalid for this rolling metric.

| Phase | Native low median (range), fps | Received/written in final approximately 30 s |
| --- | --- | ---: |
| Before probe | 104.25 (102.72-106.40) | 3600 / 3600 |
| Independent dynamic source | 104.10 (103.87-104.87) | 3600 / 3600 |
| Same source stationary | 106.01 (105.37-106.25) | 3600 / 3600 |

All three throughput intervals were approximately 120 fps, with zero busy or
expired drops. Mean write times were 2.094/2.079/2.241 ms. Neither encoded nor
sent cumulative counts increased. Track geometry/type and native attempt fields
remained consistent and counters did not reset. All 15 presentation snapshots
in each pure phase were incomplete, so no valid presentation LOW comparison is
claimed; median missed callback counts per rolling window were 4/5/9.

The independent dynamic source **did not materially improve** steady native
delivery LOW. The recursive preview observation cannot therefore be used as the
explanation for the remaining approximately 104-fps LOW. That value corresponds
to roughly 9.6 ms for the slowest one percent of delivery intervals, while total
throughput remained 120 fps and this writer completed every frame. The
remaining timing variation could be acquisition readiness, tick/wakeup timing,
GPU completion or their relative phases. Current aggregate counters cannot
allocate that approximately 1.3 ms tail to an individual stage.

The successful probe recorded `duration_complete`, destroyed its window and
cleared its sampling/deadline timers. Its `watchdogCleared:false` flag is
preserved rather than rewritten; the process exited with code zero and a
separate process check found no remaining probe PID. An earlier probe failed
at the dynamic/static transition with an EPIPE logging error. That incomplete
run is retained separately and is not counted as this completed control.

The second history's per-snapshot `encodingPlan` is null despite a correct
top-level plan. The collector callback retains the initial dependency object,
so render-state getters such as the plan can be stale. This is a separate
diagnostic-context defect; the low calculation reads live per-track observers
and is unaffected. Do not claim that this history independently proves every
second's complete encoding configuration. Fix that closure with a dedicated
regression check in an isolated change, rather than hot-reload the active media
hook during this investigation.

### Local provenance

Local raw observations remain ignored under `runtime/`:

- `live-media-diagnostics-20261030-before.json`, SHA256
  `2d262a73c0979651b29fa16b13012db542c4f22d016e151129676a5329d60bf0`.
- `live-pacing-observation-1793338763363.json`, archived bounded helper/broker
  records. The logger stops after 120 records or ten minutes; old records must
  not be described as current live telemetry.
- `live-low-summary-20261030-before.json` and `live-pacing-analysis-latest.json`.
- `live-media-diagnostics-20261030-after-cadence.json`, SHA256
  `9cc7a4537b807941fa51f4c7dc1ea53585c3b9ac042ad894a04c6e8bc9dd87f9`.
- `live-source-cadence-fixed-20261030T060003/source-result.json` and
  `live-source-cadence-comparison-20261030.json`. The source script SHA256 is
  `a2cb7074978f5c5aac7a4b1f58880c6e4ca861a921e32d9aaec42489091c87f6`.

The unresolved individual-frame attribution is source readiness versus DXGI
internal wait/thread scheduling versus GPU completion. The query completion
path also polls with a one-millisecond wait, whose wall time includes wakeup
and scheduling, not just GPU work. A future bounded tail trace should correlate
each long delivery interval with those stages and no-present/no-slot counters.
Only then should same-source timeout versus bounded nonblocking acquisition,
or supported event/fence completion, be compared. Older binaries from another
source revision are not a valid replacement/control.

No safety queue, GPU release barrier, codec, bitrate, OS timer policy or process
priority was changed in this investigation. The UI-only change passed desktop
typecheck and was verified live below resolution without interrupting sharing.
