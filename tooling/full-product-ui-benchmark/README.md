# Isolated full Cove App performance checks

This is a local measurement tool, not a product feature, automated user session or
release. It runs the actual App/HashRouter, room controller, ChatRoomV2, hidden
mounted chat, member meters, controls and LocalScreenVideo against a real owned
loopback SFU and fresh SQLite database. It seeds 200 deterministic chat messages
and loads them through the public history operation into 200 actual DOM rows.

The two peers have separate nonpersistent Electron partitions and fresh test
accounts. Formal client profiles and credentials are not read. Requests are
restricted to the exact loopback renderer/backend origins. Updates, password
storage, external links and remote OS input are unavailable. Ordinary empty
annotation mirroring uses the existing AnnotationOverlayController. These
unavailable integrations are outside this fixture's acceptance coverage.

Fixed Vite adapters instrument postcommit controller observations and ChatPanel
body entries. They fail closed when an original source anchor changes; no product
source is edited. source.json hashes original source and harness inputs. The
publisher preview is excluded from the fixture's extra per-frame observer.

## Prerequisites and CPU checks

Use a worktree with its normal dependencies, built workspace packages, compiled
server and Electron broker/preload, and a qualified native helper plus adjacent
native-screen-handles.node. tooling/screen-performance-native.cjs documents the
existing build artifact lookup. An explicit COVE_FPS_NATIVE_VARIANT must resolve
to its exact runtime/native-throughput-<variant>/ pair; it never silently selects
another binary. Do not install or alter global tools for this fixture.

From the repository root:

~~~powershell
node --test --test-isolation=none tooling/full-product-ui-benchmark/static.test.cjs tooling/full-product-ui-benchmark/development-heartbeat.test.cjs tooling/full-product-ui-benchmark/motion-scenario.test.cjs tests/screen-performance-native-delivery.test.cjs
node node_modules/typescript/bin/tsc -p tooling/full-product-ui-benchmark/tsconfig.json --noEmit
~~~

The static tests call prepare(), which generates the ignored observer.ts from the
existing media-integration fixture. A normal run also generates it before Vite
starts. To typecheck first without running static tests, call:

~~~powershell
node -e "require('./tooling/full-product-ui-benchmark/run.cjs').prepare()"
~~~

CPU checks do not establish real GPU/media performance or functional acceptance.

## Sustained motion, focus switches and publisher occlusion

The explicit `COVE_FULL_UI_MOTION_SWITCH=1` scenario keeps one native capture
producer and one real SFU publication for four phases. Each phase lasts at least
48 one-second sample periods: moving background with the publisher focused;
the same background while focus alternates between two small owned fixture
windows below the visible publisher; the same switches with opaque fixtures
covering the publisher surface; and the publisher focused and visible again.
Switches occur every three seconds and use only those fixture windows. A lost
owned focus aborts the run; the harness does not focus over a user application.
Each requested focus change has a bounded two-second acknowledgement window.

Use the same helper source revision, dimensions, codec and completion setting
for matched native variants, running one at a time:

~~~powershell
$env:COVE_FULL_UI_MOTION_SWITCH='1'
$env:COVE_FULL_UI_KEEP_CAPTURE_ACTIVE='0' # default baseline; 1 is the explicit capture-scoped activity candidate
$env:COVE_FULL_UI_STATS='1'
$env:COVE_FULL_UI_VOICE='muted'
$env:COVE_FPS_SAMPLE_SECONDS='192' # fixed only for this scenario
$env:COVE_NATIVE_GPU_CAPTURE_TIMING='1'
$env:COVE_FPS_NATIVE_VARIANT='pacing-timeout' # exact prebuilt matched variant
$env:COVE_FPS_NATIVE_COMPLETION='query'
$env:COVE_FPS_LABEL='motion-timeout-query'
node tooling/full-product-ui-benchmark/run.cjs
~~~

The scenario requires actual product stats and muted synthetic voice (the
separate varying-voice fixture has a 120-second curve). Publisher
`backgroundThrottling` starts true. The default-off
`COVE_FULL_UI_KEEP_CAPTURE_ACTIVE=1` control is allowed only in the motion
scenario and passes `keepRendererActive` to the native controller. The candidate
requires exactly one active renderer policy lease and actual publisher
`backgroundThrottling=false` during every measured sample. Qualification takes
an explicit expected policy without rewriting the actual state. Before capture,
and after normal product stop and safety reset, actual policy must be true again
with zero leases. Fixture windows retain their original true policy. Use the
same timeout/query helper and all other inputs to compare flag 0 and flag 1.

All existing real pixel/advancing
sequence/nonfuture sequence, actual 1728x1080 capture/encode/decode/render
dimensions, codec and media cleanup guards remain active. New fixtures stay
clear of source marker/sequence probes. Bounds and stacking request an opaque
publisher cover; they do not prove the OS occlusion decision. Actual native
window focus/visibility, document visibility, policy and CPU counters are
recorded independently at every sample. The physical desktop may not present
every source canvas rAF draw; helper source-present counters provide separate
evidence.

`cases[].motionScenario` retains timestamped phase markers and focus requests,
per-phase `includingTransition` throughput and rolling LOW snapshots, and a
separate `phasePure` result. The latter uses only the last 15 snapshots taken at
least 32 seconds after a phase transition completed. A numeric LOW is included
only when its observed interval span plus last-frame age fits within the phase
age with a two-millisecond clock margin; per-metric `phaseHistory` counts
verified, unknown and crossing histories. `phasePureComplete` means that 15
candidate snapshots were retained, not that every preview LOW was available or
verified. Switches within a phase remain included. No LOW history
is reset or transition gap removed. A numeric native observer supplies an exact
sample-time snapshot; the existing product preview reader is reused without a
second presentation binding. Actual cached product
`nativeDeliveryStability`/`presentationStability` snapshots are retained too.
Unavailable or incomplete preview LOW remains unavailable or incomplete,
including when document visibility resets its observation.

Helper timing collection has a scenario-only bound of 360 reports; ordinary
runs retain their existing 120-report and 30-second limits. The existing
330-second Electron watchdog and 360-second launcher watchdog remain unchanged.
Motion samples remain in a bounded in-memory list during measurement; the
growing full result is serialized and written only after measurement or on
failure. Per-sample `mainStages.save.performed` therefore remains false in this
scenario, including when the ordinary low-overhead observer flag is off. Earlier
motion trials that serialized the entire growing JSON on every sample are
observer-interference trials and cannot establish a product tail regression.
All focus timers, fixture windows and the additional native numeric observer
are released on normal completion and failure. Failed runs retain raw
observations and are not performance successes.

## Real local run

Run serially, with no competing GPU/foreground experiment. It temporarily displays
a controlled synthetic source and one owned publisher window. Its existing focus,
geometry and exposed-pixel guards abort if that controlled layout is lost. It does
not reacquire foreground during measurement. Input blocking is scoped to the two
disposable peers; Escape requests cancellation, and no typed content or coordinates
are retained. Other apps and OS input/settings are unchanged.

~~~powershell
$env:COVE_FULL_UI_STATS='0'             # exact 0/1
$env:COVE_FULL_UI_FRAME_SINK='generator' # exact generator/worker; generator is the product default
$env:COVE_FULL_UI_CODEC='av1'           # exact av1/vp8, existing product modes
$env:COVE_FULL_UI_VOICE='synthetic-varying' # exact muted/synthetic-varying
$env:COVE_FPS_LABEL='full-ui-active'
$env:COVE_FPS_SAMPLE_SECONDS='12'       # integer 1..30
$env:COVE_NATIVE_GPU_CAPTURE_TIMING='1'
$env:COVE_FPS_NATIVE_COMPLETION='query'
$env:COVE_FPS_PATTERN_READBACK='full'
$env:COVE_FPS_LOW_OBSERVER='1'
$env:COVE_FPS_LIVE_GPU_INFO='0'
$env:COVE_FPS_PREVENT_DISPLAY_SLEEP='1'
node tooling/full-product-ui-benchmark/run.cjs
~~~

Keep any separately qualified helper-variant configuration explicit. Clear
conflicting COVE_FPS_* experiment flags rather than combining unrelated probes.
The run rejects baseline-frame-writer, minimized publisher, native lifecycle,
recovery/republish/demand checks, content trace, generated NV12 and disabled
renderer-backgrounding controls. The native lifecycle fixture remains a separate
entry under tooling/verify-screen-performance.cjs.

Output is runtime/fps-validation-full-ui-20261029/<label>-*/ with source.json,
result.json and owned logs/profile/backend-data. Account sessions remain only in
the owned process/profile. Share selected anonymous results, not the test profile
or SQLite directory. Failed or interrupted runs are retained and are not counted
as performance successes. SIGINT/SIGTERM and the launcher watchdog stop only
children owned by that launcher.

## Matched controls and measurement meaning

The fixed case is native screen, 1080-high/120/game-mode, native GPU BGRA,
ZeroCopyDesktopCapture plus existing AllowWgc, product publisher background
throttling, centered visible 75% frameless publisher and a hidden full-App viewer.
No DevTools/HMR is used. Default warmup is 5 seconds and default sampling is 12
seconds. A stats-panel run is an explicit separate matched control and changes
both the actual collector and actual diagnostics DOM.

The current geometry qualification is **one 2560x1600 display** (allowing only
small DIP-rounding error). Aspect-preserving output is **1728x1080, not
1920x1080**. av1 requires compatibility=false and actual video/AV1. vp8 requires
the existing compatibility=true path and actual video/VP8 at the same dimensions.
Before initial sharing, the fixture commits this preference through the public
setter and waits at most 3 seconds for the public controller to reflect it, as
the normal capture-settings UI does. This ordering does not override natural
stock-track ending or cancellation; the earlier VP8 pre-first-frame failure's
cause remains unknown until an actual rerun establishes more evidence.

worker is explicit opt-in and requires this worktree's existing fixture whitelist;
there is no silent generator fallback. Changing that control measures the writer
experiment, not a new encoding policy. Adaptive resolution reduction or codec
fallback invalidates a matched run. Source/write/encoder-input/encode/decode and
video-element counters describe distinct stages. They do not measure physical
monitor scan-out, end-to-end latency or long-call stability.

The harness derives its repository root from its tooling/ location. Keeping the
same relative directory in another worktree uses that worktree's source, backend
and compiled artifacts. full-product.html directly imports its sibling renderer
with location.href, independent of query parameters and the product asset base;
it does not depend on Vite's HTML-placeholder transformation. Startup errors use
fixed stage codes without account/token/URL payloads.

## Synthetic voice and real meter DOM

No physical microphone, human voice or speaker output is used. Before App import,
the existing screen-performance fixture supplies its oscillator/gain through the
real getUserMedia/media hooks and actual loopback audio transport. AudioContext
uses sinkId:{type:'none'}; the main process also mutes WebContents. Only audio-only
fixture requests are accepted; real getDisplayMedia remains unchanged.

muted (default) retains constant gain 0.03 and actual product self-mute. Explicit
synthetic-varying keeps both peers unmuted and applies one finite 120-second
AudioParam curve between 0.005 and 0.05 to the existing gain. It adds no JS timer,
track, oscillator, context or analyser. The guard requires exactly one live,
enabled source with a running context and unexpired curve. Ended historical
replacement records are allowed, with total requests/records bounded to four.
All such records remain visible to final resource checks.

Anonymous observations distinguish exact numerical changes from key changes. The
old react-state implementation is observed on controller commits. external-store
mode subscribes both channels to known room/voice-member/local keys before first
RMS publication and then reads current public level getters on store callbacks.
Stable keys/store retain subscriptions; root commits may legitimately remain zero.
Active mode requires actual positive/changing levels and store notifications.

Each existing 1 Hz sample reads at most 16 actual .vertical-volume inline
--volume-level percentages without layout/computed-style reads. Active store mode
requires nonzero values and at least two distinct DOM snapshots over the measured
window; equal first/last snapshots alone do not fail. Speaking-avatar class count
is reference data because the threshold may legitimately remain unchanged. This
checks leaf DOM updates, not physical presentation or voice recovery.

Cleanup first stops only harness subscriptions, leaves the actual room while the
App socket is connected, and waits at most 2 seconds for room passive cleanup.
Then it unmounts App and disconnects. Fixture cleanup stops synthetic tracks and
oscillators and closes contexts. Total store subscriptions, including UI leaves,
media/native/SFU/timer/listener resources must reach zero. Unknown subscriptions
or timers are not removed to make the check pass. One precisely identified
loopback Vite 30-second heartbeat may be disposed after product teardown; more
than one is a guard failure, and unknown handles remain counted.

## Optional same-session CSS diagnostic

Set COVE_FULL_UI_METER_TRANSITION_DIAGNOSTIC=1 and exactly 24 sample seconds.

Samples 0..7 retain normal CSS, 8..15 inject only transition:none!important on
.cove-shell .volume-live-level and .cove-shell .vertical-live-level, and 16..24
remove the owned style. No RMS, React, popover, geometry, blur or encoding setting
changes. Phase/style presence, mounted/CSS-visible meters and hover counts are
recorded; all original source/media guards remain. The style must be removed on
normal cleanup and cancellation.

This marks the result diagnosticOnly. **The mixed overall 24-second summary is
not a product performance improvement.** Compare separate phase deltas excluding
switch boundaries and inspect the final restored phase for time trends. This
probe does not justify changing product CSS without supporting evidence.

For a fixed full-motion backdrop-filter control, set `COVE_FULL_UI_MOTION_SWITCH=1`
and `COVE_FULL_UI_FLAT_DIAGNOSTICS=1` (default `0`). This requires stats enabled,
muted synthetic voice and the meter transition diagnostic disabled. The original
four 48-second phases, producer, preview, background, layout, counters and LOW
history remain unchanged. The fixture only injects scoped `backdrop-filter:none`
and `-webkit-backdrop-filter:none`; each sample checks the explicit switch,
actual filter and single mounted diagnostics overlay. Cleanup removes the owned
style. Compare separate otherwise identical runs; no mixed-mode total is a
product performance result. Product styles are unchanged by this control.

Set `COVE_FULL_UI_FOREGROUND_GATE=1` (default `0`) to pause after visible startup
and the owned-pattern reader self-test, before initial screen sharing. The current
run directory receives `foreground-ready.json` with fixed non-secret metadata.
Prepare the owned source/publisher foreground order, then create an empty
`foreground-continue` file in that same directory. The fixture waits asynchronously
at 50ms intervals for at most 60 seconds, immediately rechecks the original
foreground/display geometry contract and records the actual wait in
`result.foregroundGate`. It never changes focus during the gate or measurement;
the existing 330-second overall watchdog is unchanged. Default-off runs create
neither marker file.
