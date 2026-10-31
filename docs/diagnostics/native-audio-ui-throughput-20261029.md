# Native capture: full-room audio/UI throughput qualification

This local investigation identified avoidable renderer work outside the screen
capture algorithm. Moving a frame writer to a Worker did not improve the measured
GPU path. Keeping high-frequency audio observations out of the room controller
and memoizing the mounted chat subtree produced the useful improvement.

These are measured local results, not a constant-120-fps or release-readiness
claim. No codec, bitrate, resolution-selection, capture-pool size or media-resource
ownership policy was changed for this improvement.

## Conditions and metric boundaries

The full-product harness renders the actual App, room controller, ChatRoomV2,
member controls and local screen preview. It loads 200 real SQLite chat rows into
both clients and leaves the hidden chat subtree mounted as the product does. Two
fresh isolated clients use the real loopback SFU. A finite, varying-gain synthetic
tone travels through the existing microphone/media hooks and produces changing
audio levels. It captures neither a physical microphone nor human speech, and
does not play through a speaker.

The Windows display was 2560x1600 at 240 Hz. Preserving its aspect ratio at a
1080-pixel height produces **1728x1080**, not 1920x1080. All five table rows used
the existing AV1/game/120-fps configuration, GPU BGRA native frames, the default
Generator writer, visible publisher, hidden viewer, a five-second warmup and no
DevTools. The fourth row intentionally enables the actual performance panel;
the fifth uses the final relocated tooling entry with the panel off.

Capture FPS uses the helper's unique-frame counter and helper-clock elapsed time.
The helper reports approximately once a second, so those endpoints are not
synchronized with the writer/encoder/decoder sampling interval. Writer FPS is
accepted writes; encoded and decoded FPS are differences in real WebRTC counters.
Source pixels, advancing/nonfuture sequence, dimensions, negotiated codec,
foreground geometry, cleanup and backend shutdown must all pass before a run is
accepted. Video-element counters are not physical monitor scan-out or measured
end-to-end latency.

## Active-audio comparison

| Stage | Sample seconds | Capture FPS | Writer FPS | Encoded FPS | Decoded FPS | Sender/controller commits | Chat function entries |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Exact-value no-op optimization only | 12.786 | 66.10 | 58.89 | 53.25 | 53.75 | 128 | 256 |
| Chat memo and stable callbacks | 12.393 | 114.11 | 106.92 | 104.20 | 104.47 | 125 | 0 |
| Leaf meter subscriptions | 12.527 | 118.43 | 116.95 | 115.14 | 115.25 | 0 | 0 |
| Leaf subscriptions, performance panel on | 30.994 | 119.10 | 116.09 | 114.36 | 114.36 | 31 | 0 |
| Final tooling qualification, panel off | 12.404 | 119.85 | 119.48 | 118.22 | 118.47 | 0 | 0 |

Counts are warmup-separated sample deltas, not initial StrictMode renders. The
viewer/controller deltas were respectively 128, 124, 0, 31 and 0; its chat entry
deltas were 256, 0, 0, 0 and 0. The fourth row's roughly one commit per second is the
enabled performance collector, not audio-level sampling.

The first stage avoids rendering only when the exact level values are unchanged.
During active speech they legitimately change every 100 ms, so that optimization
alone cannot remove the large-parent render. Chat memoization removes repeated
history parsing/rendering. The leaf store then updates only subscribed avatar and
meter bindings, retaining the original sampling frequency, RMS values, mute gates
and speaking threshold.

The leaf-store run observed 252/249 numeric meter changes and 126/125 store
notifications in the sender/viewer. The 30.994-second run observed 620 numeric
changes and 310 notifications per client. Actual DOM meter percentages changed,
and speaking classes remained observable. Zero room commits therefore does not
mean the test froze or disabled the live meters.

## Why UI work affected capture

The native pool has three bounded slots. A slot must remain unavailable until all
references to its shared GPU frame have been released. In these runs, a slow
renderer retains downstream frame references while the helper safely skips
capture when no slot is free. Thus a fast native acquisition API can coexist with
a much slower complete Cove pipeline.

The active-audio stages recorded these native diagnostics:

| Stage | Helper `noSlot` delta | Mean import ms | Mean transfer ms | Mean reference hold ms |
| --- | ---: | ---: | ---: | ---: |
| Before chat memo | 699 | 0.209 | 15.333 | 42.106 |
| After chat memo | 67 | 0.206 | 2.726 | 19.193 |
| Leaf subscriptions | 19 | 0.196 | 2.169 | 11.933 |
| Leaf subscriptions, panel on | 28 | 0.185 | 1.603 | 11.071 |

The timing means cover each complete native session, including startup/warmup;
they are not isolated converter CPU time or strictly sample-window means. Slot
counter endpoints use the helper clock. The paired rendering changes and timing
movement support renderer scheduling/reference retention as a major bottleneck;
they are not a per-frame Chromium trace proving every remaining stall's cause.
Import cost itself stayed small. This evidence contradicts a fixed native
acquisition ceiling near 80 fps on this workload.

No slot is returned early and the pool was not enlarged. Increasing buffering
could conceal pressure while increasing latency or risking resource ownership.
The opt-in Worker experiment remains disabled by default: its matched quiet AV1
run encoded about 112.31 fps versus about 117.90 fps with Generator, providing no
measured reason to make it the default. No product meter CSS was changed: a
same-session transition-disable/restore diagnostic remained fast after restore,
so it did not establish a reliable transition-paint regression.

Total app CPU is not claimed to be lower in absolute terms: the improved path
processes substantially more real frames. A fixed-output-rate or per-frame CPU
comparison would be needed to quantify that separate claim.

### Remaining writer backpressure

The panel-on sample received 3695 frames and completed 3598 writes over 30.994
seconds. Its 97 queue drops account for the observed 119.22 -> 116.09 fps gap:
93 pending frames were replaced by a newer frame, and only four expired. Mean
write wall time was about 5.40 ms, with 440 writes exceeding the 8.33 ms frame
period. Relaxing expiry alone could affect at most about 0.13 fps in that sample.

`nativeFrameWriteQueue.ts:57-70,100-113` and
`nativeScreenCapture.ts:286-289,386-400` retain one active write and one newest
pending frame, with a two-frame deadline. There is no second native renderer FPS
timer. The helper's single phase-preserving 8333-us tick
(`native-screen-capture-helper.cpp:175-184,1139-1156`) approximates 120.005 Hz;
rounding cannot account for a 114-fps output. Actual monotonic microsecond frame
timestamps reach VideoFrame without fabricated frames or rate retimestamping.
The RTP `maxFramerate=plan.fps` remains the requested user limit.

Adding a queue or returning GPU credits early would hide pressure or violate
ownership rather than establish lower latency. The further 116.09 writer ->
114.65 encoder-source -> 114.36 encoded gap is not fully explained by these
aggregates. No duplicate product FPS limiter was found, and the safety bounds
remain unchanged.

## Lifecycle and release of resources

Both full-room final runs passed actual room leave/unmount and backend shutdown.
The short run transferred/released 2083/2083 native frames; the panel-on run
transferred/released 4287/4287. Native sessions/helpers/imports/references/slots,
live tracks/transports/producers/consumers, synthetic audio contexts, owned
timers/listeners and total meter subscriptions were zero after cleanup. The
harness disposes only its explicitly identified Vite development heartbeat;
unknown resources are not cleared to make a check pass.

The separate existing native lifecycle fixture also passed. Its initial measured
sample was 4.058 seconds, followed by 8.903 seconds of bounded lifecycle steps:
late viewing of a static source, three 720p60 -> 540p120 changes, intentional exit
of its own native helper and manual stock republication afterward. Seven native
sessions started and seven stopped; 1395 frames were transferred and released.
Voice identity and synthetic audio progress were retained in every step. The
intentional helper failure disabled native reuse for that session as designed;
the manually requested stock fallback decoded advancing source pixels.

That fixture uses 864x540/1152x720, so it is lifecycle evidence, not another
1080-high performance result. It does not test repeated voice leave/rejoin. The
forced no-desktop-present idle-refresh branch was not exercised. A 31-second
sample is not a long-call or leak-soak qualification.

## Reproduce and inspect

Build the project's shared packages, server, Electron code and qualified native
helper/bridge using the existing project instructions. Run only one foreground
GPU experiment at a time. The controlled source occupies the foreground and the
test uses fresh owned profiles/backend data. Do not use a normal client profile
or connect this harness to a production service.

```powershell
node --test tooling/full-product-ui-benchmark/static.test.cjs
node node_modules/typescript/bin/tsc -p tooling/full-product-ui-benchmark/tsconfig.json --noEmit
npm --prefix apps/desktop run test:audio-devices
npm --prefix apps/desktop run typecheck

$env:COVE_FULL_UI_VOICE='synthetic-varying'
$env:COVE_FULL_UI_STATS='0'
$env:COVE_FULL_UI_FRAME_SINK='generator'
$env:COVE_FULL_UI_CODEC='av1'
$env:COVE_FPS_SAMPLE_SECONDS='12'
$env:COVE_FPS_LABEL='full-ui-active-store-local'
$env:COVE_FPS_NATIVE_COMPLETION='query'
$env:COVE_FPS_LIVE_GPU_INFO='0'
$env:COVE_FPS_PREVENT_DISPLAY_SLEEP='1'
$env:COVE_FPS_PATTERN_READBACK='full'
$env:COVE_FPS_LOW_OBSERVER='1'
$env:COVE_NATIVE_GPU_CAPTURE_TIMING='1'
$env:COVE_DISABLE_NATIVE_GPU_CAPTURE='0'
node tooling/full-product-ui-benchmark/run.cjs
```

For the separate panel-on control, set `COVE_FULL_UI_STATS=1`,
`COVE_FPS_SAMPLE_SECONDS=30` and a distinct label. Do not enable the CSS-transition
diagnostic for a product performance comparison. The tool's README describes its
guarded controls, prerequisites, cleanup and test-only observations.

Local evidence is under `runtime/` and is intentionally excluded from source
control. Keep profiles and SQLite files private; they contain disposable test
sessions. The accepted raw result files are:

- `runtime/fps-validation-full-ui-20261029/full-ui-active-voice-before-memo-v2-XtuyJP/result.json`
- `runtime/fps-validation-full-ui-20261029/full-ui-active-voice-after-memo-controlled-1dtDYc/result.json`
- `runtime/fps-validation-full-ui-20261029/full-ui-active-voice-leaf-store-vxvwIf/result.json`
- `runtime/fps-validation-full-ui-20261029/full-ui-active-store-stats-30s-M2og82/result.json`
- `runtime/fps-validation-store-lifecycle/store-repeated-native-lifecycle-5QZpld/result.json`
- `runtime/fps-validation-full-ui-20261029/full-ui-delivered-store-final-av1-yYzts4/result.json`

The first four result SHA-256 values, in that order, are:

```text
54331f4e833d70f1b2b56b0e9b3427b3d2d053094a7f47a19c12f62a740f653d
af2f09edf7855513e540563747b7ccfcc98d1c922795a7d1f1498c2d9ead4a52
877b410f9734da88f895e944b75d41e837ba27d61d0d5af4765139bd3c157a95
8665887c087d07cdfaecfe1f8ab915f1a440713b37916e4db568d824dd85eb7b
```

## Remaining boundaries and rollback

The measured capture rate is close to 120. Encoding/decoding was roughly
114-115 fps in the earlier full-room samples and 118.22/118.47 fps in the final
12.404-second panel-off qualification. The remaining gap must not be
hidden by duplicate frames, retimestamping, resolution reduction or relaxed
guards. This work does not establish exact 1920x1080 at constant 120 fps, physical
display presentation, real human microphone/system-audio behavior, Android
capture, every GPU/driver configuration or sustained multi-hour stability.

The first VP8 full-room attempt
`full-ui-active-store-vp8-TV7vvo` failed before measurement: its stock display
track emitted `ended` and correctly cancelled the native upgrade before its first
frame. The cause of that natural end was not established. It is not codec
incompatibility or performance evidence, and stop/cancel priority must not be
bypassed to obtain a passing run. Later attempts, if any, require their own
recorded outcome.

The relocated tooling entry's VP8 attempt
`runtime/fps-validation-full-ui-20261029/full-ui-delivered-active-store-vp8-FhyvkT/result.json`
completed a 12.464-second sample but **failed** the encoded-dimension guard:
1152x720 did not match the required 1728x1080. Native capture reached 119.876 fps,
writer acceptance 119.62 fps and encoder-source input 118.35 fps, with only one
helper `noSlot` event. These are diagnostic stage counters, not an overall passing
1080-high performance result. The first two RTP samples were 1728x1080 at 20/21
fps; later samples reported `qualityLimitationReason=bandwidth`, first at
1152x720 and then 768x480. Target bitrate increased from 559745 to 2563497 bps,
while the selected pair's estimated available outgoing bitrate increased from
1244770 to 2819177 bps. The source/transport handoff was therefore near the capture
target while WebRTC's existing adaptation reduced output resolution. Whether
this was local bandwidth-estimator startup or another persistent constraint was
not established by that short run. No product codec/bitrate policy was changed;
a bounded longer-warmup control must be reported independently. Cleanup and
backend shutdown both passed. This does not explain or retroactively fix the
earlier stock-track natural-end failure.

The failed result's SHA-256 is
`305f048b12cbbe876e539d740ebd696ee1bf9ded82232e6d7f644e3001c13da2`.

One bounded 30-second warmup plus 30.485-second VP8 sample was then run:
`runtime/fps-validation-full-ui-20261029/full-ui-delivered-active-vp8-warm30-joPd3o/result.json`.
It still **failed** the strict dimension guard. Capture was 119.885 fps, writer
119.53 fps and encoder-source input 119.18 fps. Encoding/decoding reached
119.12/119.16 fps **at 1152x720**, not at the required 1728x1080. Both first and
last measured RTP reports indicated `qualityLimitationReason=cpu`, 1152x720 and
target bitrate 15518000 bps. The short run's bandwidth startup therefore does
not explain away the longer run: existing WebRTC CPU adaptation is a separate
remaining constraint in this VP8 workload. It is not evidence of a fixed native
80-fps acquisition limit, nor permission to alter the user's codec/bitrate or
disable protective adaptation. Cleanup and backend shutdown passed. No further
VP8 retries were made simply to seek a passing result. SHA-256:
`57f42060c68ff477faf7945b152e822e0e7d21aaed6b98372ccaa6913c5a5478`.

Earlier source manifests did not individually hash the new store, useWebRTC and
leaf-binding files; their raw results are retained as recorded. The final
tooling adds those three source hashes and a static provenance assertion. Later
qualification results identify that strengthened harness separately; earlier
manifests are not retroactively rewritten.

The final strengthened tooling entry passed all guards at
`runtime/fps-validation-full-ui-20261029/full-ui-delivered-store-final-av1-yYzts4/result.json`:
12.404 measured seconds, native capture 119.852 fps, writer 119.48 fps,
encoder-source input 118.30 fps and AV1 encoding/decoding 118.22/118.47 fps, all at
the required 1728x1080. The source manifest includes the three new meter modules.
Both controllers and chat subtrees recorded zero sample-window root commits
while actual meter DOM continued updating. All checked media/native resources,
timers/listeners and meter subscriptions were zero after cleanup; 2079 native
frames were transferred and 2079 released, and the backend stopped. SHA-256:
`65c0fcdff599fd4f881d9f185a75fa9233de3ff4f56a86654a5202d4109fe460`.

Final local source checks passed: desktop production build/typecheck, 79 audio
tests, 393 + 31 native-capture tests, 10 chat image/link tests, and 36 full-App
tooling/network-observation checks plus the tooling TypeScript check. Two
independent read-only reviews found no remaining product blocker; the provenance
gap noted by the final review was fixed and tested before the final real run.

Changes are independently reversible. `996efb7` provides exact-value no-op state
reuse; `1023690` adds the chat memo boundary and its four stable callbacks. Revert
the separate leaf-store commit `73d5094` to restore large-parent React level publication
while retaining either earlier optimization. `fa97166` is the separately
disabled-by-default Worker experiment. No server deployment, protocol migration,
account/data migration or persistent preference rollback is required.

See [audio meter ownership](../architecture/audio-meter-ui.md) for where new live
UI should subscribe and how resource ownership is preserved.
