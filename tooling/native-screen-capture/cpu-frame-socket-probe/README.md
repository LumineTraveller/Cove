# Isolated pooled CPU-frame IPC / loopback WebSocket experiment

This probe compares only main-to-sandboxed-preload handoff and actual CPU
`VideoFrame` construction. It creates synthetic NV12 from three ordinary pooled
main-owned ArrayBuffers. It performs no desktop capture, WebRTC, encoding,
decoding, renderer presentation, or product integration. A successful 120 FPS
result is **not** a claim that Cove desktop sharing now reaches 1080p120.

No dependency, codec, image-detail policy, product source, install, release, OS
setting, firewall rule, or global timer resolution is changed. Both routes use
the same resolution, NV12/BT.709 limited-range pixels, 120 Hz phase-preserving
schedule, three-slot limit, per-frame validation, transfer constructor and close.

## Initial result and measurement repair

The first real run, `runtime/cpu-frame-socket-probe/run-zKLXPw/result.json`,
passed ownership/pixel/lifecycle checks but **did not meet the throughput goal**:
IPC delivered 66.44 FPS with 535 skipped timer phases; fragmented WS delivered
20.75 FPS with mean 61.92 ms send flush and 133.54 ms ACK round trip. The IPC
source was limited by Node's coarse `setTimeout` pacing on this Windows host.
WS additionally saturated all three slots. These are two separate findings.
No product path was changed or selected from that run.

The default now uses a dedicated owner-bound Windows high-resolution waitable
timer and stdout I/O callbacks. Node timers remain available as the explicit
`--pacer node` control. `passed` means validation/cleanup correctness only;
`pacer120Qualified` and `syntheticValidated120TargetReached` state the separate
scheduling and synthetic frame-rate outcomes. Neither proves desktop sharing.

## Existing runtime and bounded runs

Use the repo root. The launcher explicitly resolves
`apps/desktop/node_modules/electron`, requires **44.0.0 / Chromium 152 / win32
x64**, and refuses the unrelated root Electron 29.4.6. Existing `ws` resolves
through the repo's existing node_modules; the inspected version was **8.20.1**.
Nothing is installed. The actual version and source SHA-256 values are recorded.

Build the small CPU-only pacer with the already installed compiler. Building
does not run it:

```powershell
& .\tooling\native-screen-capture\cpu-frame-socket-probe\build-pacer.ps1
```

The executable is confined to `runtime/cpu-frame-socket-probe/pacer.exe`. The
source and executable hashes are recorded. `CreateWaitableTimerExW` with
`CREATE_WAITABLE_TIMER_HIGH_RESOLUTION` is mandatory; there is no ordinary-timer
fallback, busy wait, priority change, `timeBeginPeriod`, or global timer change.
Each one-shot relative wait is computed from an absolute QPC 120 Hz phase. The
pacer waits on its owner process and timer, accepts bounded `stop`/EOF on its
owned stdin pipe, and has one replaceable latest output tick. The writer uses
bounded synchronous-I/O cancellation so a blocked stdout cannot trap stop.
Old tick batches are coalesced in main rather than replayed as a burst.

The CPU-only Node I/O self-test is separate from Electron:

```powershell
node tooling/native-screen-capture/cpu-frame-socket-probe/pacer-test.cjs
```

The authoring run observed 360 source ticks and 360 Node I/O callbacks in three
seconds, 119.995 Hz source / 120.014 Hz I/O, no skipped or coalesced ticks, and
8.332 ms mean / 8.862 ms p99 I/O gaps. The host sandbox can deny Node child spawn
with EPERM; running this exact owned CPU test with tool approval verifies the
normal process path without installing anything or altering OS settings.

Only the parent benchmark coordinator should run Electron, after reserving an
exclusive measurement window. The commands below each launch real Electron and
create a hidden window:

```powershell
node tooling/native-screen-capture/cpu-frame-socket-probe/run.cjs --width 1728 --seconds 8 --warmup 2 --mode both
node tooling/native-screen-capture/cpu-frame-socket-probe/run.cjs --width 1728 --seconds 8 --warmup 2 --mode ws-first
node tooling/native-screen-capture/cpu-frame-socket-probe/run.cjs --width 1920 --seconds 8 --warmup 2 --mode both
```

`--mode ipc` and `--mode ws` isolate one transport. `both` runs IPC then WS;
`ws-first` reverses the order. Width is restricted to 1728 or 1920 and height to
1080. Measured duration is 2–30 seconds; warmup is 1–5 seconds. There is no
implicit codec test or fallback to another format/version. The node launcher
has an overall watchdog and kills only its exact owned Electron process tree if
the normal stop path does not finish.

## Optional IPC inline-chunk diagnostic

The original `ipc`, `ws`, `both`, and `ws-first` controls retain their behavior.
The additional `ipc-inline-chunks` mode uses the same synthetic NV12 bytes,
native 120 Hz pacer, three main-owned slots, source markers, sandbox settings,
actual VideoFrame transfer/detachment, readback, close, and final frame ACK. It
does not add network permissions or use SharedArrayBuffer/native shared memory.
Only the parent coordinator should run these real Electron comparisons in an
exclusive measurement window:

```powershell
node tooling/native-screen-capture/cpu-frame-socket-probe/run.cjs --width 1728 --seconds 8 --warmup 2 --mode ipc
node tooling/native-screen-capture/cpu-frame-socket-probe/run.cjs --width 1728 --seconds 8 --warmup 2 --mode ipc-inline-chunks --chunk-bytes 49152
node tooling/native-screen-capture/cpu-frame-socket-probe/run.cjs --width 1728 --seconds 8 --warmup 2 --mode ipc-inline-chunks --chunk-bytes frame
```

`--chunk-bytes` defaults to 49152 (48 KiB). The only accepted alternatives are
`frame` or the exact full frame byte count. The default 1728x1080 frame remains
2,799,360 bytes: 57 parts, with 46,848 bytes in its last part. The 1920 control
has 64 parts, with 13,824 bytes in its last part. Each IPC argument is an
independent exact-sized ordinary `ArrayBuffer.slice()` result, never a typed
view over the original multi-megabyte backing store. The `frame` chunk-envelope
control follows the same copying/reassembly path with one large message; the
original `ipc` control still sends its original pooled whole-frame buffer.

The 48 KiB payload leaves space for the fixed metadata below Electron's 64 KiB
serialized-value inline threshold. This is the intended cause under test, not a
measurement of Chromium's internal serialized size or mapping operations.
Chunk splitting, all allocations/copies, metadata creation, and every synchronous
send are included in the existing `timingsMs.sendCall`. Its measured total is
also `measuredMainSendCallTotalMs`. The existing ACK round-trip distributions
and measured-window main/all-Electron CPU snapshots remain available. `ipcChunks`
counts parts and explicit main copied bytes, and the renderer report records
completed reassemblies, reassembly timing, and actual cleanup state. Chunking
deliberately adds one full-frame main copy and one renderer reassembly copy per
frame; any throughput/CPU comparison must include those costs.

The actual sandbox preload bounds incomplete plus processing ownership to three
slots. It validates slot/serial/dimensions/timestamp, exact configured part count,
index, offset, part length, total frame size, and exact ArrayBuffer length. Each
slot accepts strictly increasing, contiguous parts for one serial, rejects
duplicates/replays/interleaving another frame into that slot, and stays occupied
through final frame processing/ACK. A missing part expires 1500 ms after the
first part, without extending the deadline on progress. Any chunk error faults
and stops the run. Stop detaches partial buffers and clears their timers;
remaining partials, processing slots, timers, or retained bytes prevent a pass.

These are synthetic transport diagnostics. Neither pure protocol tests nor a
successful chunk-mode 120 FPS result establishes actual Cove capture, source,
decode, or presentation throughput. No Electron/GPU benchmark was run while
authoring this mode.

To isolate the poor WS result, run these full-size controls with the same native
pacer. They retain all auth, three-slot, flush/ACK and real VideoFrame checks:

```powershell
node tooling/native-screen-capture/cpu-frame-socket-probe/run.cjs --mode ws --ws-framing fragmented
node tooling/native-screen-capture/cpu-frame-socket-probe/run.cjs --mode ws --ws-framing fragmented-cork
node tooling/native-screen-capture/cpu-frame-socket-probe/run.cjs --mode ws --ws-framing single-copy
```

`fragmented-cork` retains two WebSocket fragments but wraps the two sends in one
outer owned `socket.cork()/uncork()` batch. `single-copy` deliberately uses a
full-size `Buffer.concat([header,payload])` and one final WebSocket frame per
message. Its copied bytes/copies and copy time are explicit. It is a causal
control, not a zero-copy optimization. `--window shown` is an explicit small
visible-window scheduling control; the default remains `--window hidden` with
background throttling disabled. No global Chromium flags are added.

Each run creates its own ignored `runtime/cpu-frame-socket-probe/run-*/`
directory. The launcher prints that relative path and the sanitized
`result.json`. The Chromium profile is confined to that directory and deleted
after Electron exits. Result files contain format, versions, source hashes,
fixed error codes, timing summaries and counters. Pixels, tokens, server proof,
ports, native handles, stdout/stderr, and arbitrary exception text are not saved.

## Actual ownership and framing

The window has `sandbox: true`, `contextIsolation: true`, `nodeIntegration:
false`, `webSecurity: true`, `backgroundThrottling: false`. Its self-contained
preload uses only the sandbox's permitted `require('electron')`; it imports no
relative modules and exposes no page bridge. The empty data-URL page has no
scripts, denies permissions, windows and navigation, and can connect only to the
exact session endpoint. IPC credentials go only from main to this preload.

IPC uses real `webContents.mainFrame.send(channel, metadata, slot.buffer)`.
There is no transfer list or invented zero-copy claim: Electron structured
clones the full ordinary ArrayBuffer. ACKs return through `ipcRenderer.send`.
Main verifies sender webContents and frame before accepting any IPC message.

WS listens only on `127.0.0.1:0` and fixed `/cpu-frame-probe`. HTTP headers are
limited to 4096 bytes; Origin must be exactly `null`, Host must match the chosen
loopback endpoint and method/path must match. At most two accepted TCP sockets
and one reserved WebSocket upgrade exist. Unauthenticated sockets time out in
1500 ms. Authentication's first 33-byte binary message is type byte 1 plus a
fresh 256-bit token. The server uses a timing-safe comparison, consumes that
token once, and replies with type byte 2 plus an **independent** 256-bit server
proof that the client already obtained over trusted IPC. The client never sends
the proof. No frame is sent until preload validates the server proof and reports
connected through IPC. The server then has no listening handle and terminates
any other accepted sockets.

`perMessageDeflate: false` prevents compression even when a browser advertises
the extension. `maxPayload: 128` bounds client messages. Each frame is one
fragmented binary message: `ws.send(header, {fin:false})`, followed by
`ws.send(Buffer.from(slot.buffer), {fin:true})`. The latter is an existing
zero-copy Buffer view over the main pool; there is no `Buffer.concat` or full
main-frame transport copy. Chromium still materializes a received ArrayBuffer;
this is not interprocess zero-copy. The fixed 32-byte little-endian header is
magic/version/slot/serial/width/height/payload length/timestamp and 8 zero bytes.

For either route, the received actual ArrayBuffer goes into
`new VideoFrame(buffer, {format:'NV12', layout, transfer:[buffer], ...})`.
WS uses plane offsets 32 and `32 + width*height` directly in its message buffer;
it never extracts/copies the frame payload. IPC offsets start at 0. A missing
detachment or non-NV12 actual frame is a failure, with no copying fallback.

Four independent fixed Y/U/V quadrant checks and duplicated sequence stamps
validate incoming content. An actual `VideoFrame.copyTo()` of a 4×2 NV12
rectangle then checks the transferred frame's sequence and pixels. Both routes
pay that same readback cost for every frame. Every input must detach, every
constructed frame must close, and every successful frame must validate and ACK.

The main slot is reusable only after matching serial/slot ACK **and** send-flush
completion. IPC's synchronous structured-clone call supplies its completed-send
barrier; WS uses its final-fragment flush callback. An old/duplicate ACK or
callback cannot release a new serial. No historical queue is created. At a late
scheduling tick, missed phases are counted and skipped; the schedule does not
drift by adding one period to the last callback time.

Stop removes IPC listeners, retires slots, closes frames, detaches unused input,
closes the socket and listener, consumes/clears auth timers and mutable secrets,
and bounds async cleanup. Failures retain fixed error codes. Cleanup reports
actual remaining socket/client counts; incomplete disposal prevents a pass.

## Reading results

`acknowledgedMeasuredFramesPerSecond` is validated synthetic frames divided by
the measured window. The last matching ACKs can drain for up to 1500 ms; drain
time is excluded from that window and does not imply a shorter delivery latency.
Full distribution summaries are supplied for synchronous main send-call time,
WS flush time, main ACK round trip, actual renderer VideoFrame constructor, and
scheduler lateness. ACK round trip includes renderer sample validation/readback.
All transport latency uses the **main process's monotonic clock**. Renderer
construction duration uses only its own clock. There is no cross-process
one-way latency estimate.

The source pacer's actual tick rate, skipped native phases, main I/O callback
rate, coalesced tick batches and interval distribution are independent of sent
frames and no-slot drops. Native wake lateness uses native QPC; the Node timer
control's lateness uses main's clock. These are explicitly labeled. Native pacer
CPU user/kernel counters cover its complete warmup+measurement lifetime and are
reported separately from Electron's measured-window CPU snapshots.

`socketDiagnostics` records actual flush/drain/write-buffer observations and
full-copy control cost over the complete session, including warmup. Existing
ws 8.20.1 `websocket.js:242` already calls `socket.setNoDelay()`. The probe also
calls `setNoDelay(true)` on its owned socket and records the native UV
`setNoDelay(true)` operation's return value (0 on the CPU tests). Node exposes no
public TCP_NODELAY getsockopt getter, so this is a successful setting operation,
not a claimed native getter reading. No socket handle is serialized. Existing
`sender.js` already corks each individual frame's header+payload; the outer-cork
control additionally combines both fragments' write batches.

Renderer diagnostics record actual visibility/focus, local message-arrival
intervals, per-frame processing/readback durations, and ACK `bufferedAmount`.
These can separate slow local CPU frame work from delayed network-service/data
delivery. They do not directly expose Chromium's internal flow-control window,
and no Chrome flow-control cause is claimed without the new control results.

Paired `app.getAppMetrics().cpu.cumulativeCPUUsage` snapshots cover all Electron
processes at the measurement boundaries; main `process.cpuUsage()` is also
reported. CPU deltas are withheld if the process set changes or counters are
missing. They are not capture-thread, encoder, GPU execution, or remote-network
measurements. The startup allocations and frame-pattern initialization are
outside the measured window. Report both orderings before attributing a small
difference to transport.

## Checks that do not launch Electron

```powershell
Get-ChildItem tooling/native-screen-capture/cpu-frame-socket-probe -Filter '*.cjs' | ForEach-Object { node --check $_.FullName }
node --test --test-isolation=none tooling/native-screen-capture/cpu-frame-socket-probe/protocol.test.cjs
node --test --test-isolation=none tooling/native-screen-capture/cpu-frame-socket-probe/chunks.test.cjs
```

The no-isolation option is for this Windows sandbox, where Node's ordinary test
runner child spawn returns EPERM. Tests cover configuration bounds, the real
three-ArrayBuffer pool and Buffer views, exact ACK/flush ownership/replay,
independent source pixels, fixed header/ACK parsing, CPU/report sanitation, and
short actual Node loopback auth/proof/framing/rejection exchanges. They do not
construct a browser VideoFrame and cannot establish Electron or product
throughput. Twelve Node protocol tests pass, including cork and explicit-copy
controls with `uv_tcp_nodelay` status 0. No Electron/GPU benchmark was run while
authoring the new pacing/framing controls; the parent coordinator owns them.

Seven additional pure chunk tests pass without opening a socket or constructing
a VideoFrame. They evaluate the exact self-contained sandbox receiver in a Node
VM and cover independent chunk backing stores, both widths/full-frame envelope,
byte-for-byte reassembly and markers, three interleaved slots, ownership through
final release, duplicate/replay/order/size/metadata rejection, first-part deadline,
actual preload fault/stop disposal, and failed-send main credit retention.
