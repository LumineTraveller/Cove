# ICE restart design and validation

Baseline: `d8eb548`. This is an incremental recovery strategy in the existing
media recovery layer. Registration, UI intent, capture and remote-control grants
remain separate owners. No automatic join, new capture or grant restoration.

## Library contract

Installed server mediasoup is 3.20.0; desktop/mobile mediasoup-client is 3.22.0,
and react-native-webrtc is 124.0.8. The installed ReactNative106 handler implements
both send and receive restart. The server must first call its public
`WebRtcTransport.restartIce()`, then signal the returned parameters to the client
public `Transport.restartIce({ iceParameters })`. No private PeerConnection API
is used. Client restart is serialized by the library await queue but application
requests still require deduplication, cancellation and a deadline.

Official contracts: [server restart](https://mediasoup.org/documentation/v3/mediasoup/api/#webRtcTransport-restartIce),
[client restart](https://mediasoup.org/documentation/v3/mediasoup-client/api/#transport-restartIce).
Server ICE `disconnected` after consent loss and DTLS `failed`/`closed` are not
assumed recoverable; the server rejects those cases for safe teardown.

## Protocol and authority

Only new transports created by a supporting server advertise optional
`iceRestart: { version: 1, sessionId }`. Absence means the existing platform
failure policy. No extra unknown-capability round trip to old servers is needed.
The server binds this opaque ID to the transport's creation-time peer, room and
media generation, including dedicated mobile screen transports.

`ms:restart-ice` takes `transportId`, `roomId`, `sessionId` and a monotonically
increasing positive `sequence`. The response is a versioned success with the
same identities/sequence and ICE parameters, or `{ ok: false, code }`. No ICE
password, bearer, SDP or candidate addresses are written to recovery logs.

The server checks connected socket/peer identity, current room/generation and
the exact owned send/receive/screen transport before and after its awaited worker
call. A repeated latest sequence reuses one promise/result, so ACK loss never
rotates credentials twice. Older sequences and overlapping newer sequences are
rejected. State is held per transport in a WeakMap, survives recovered Socket
instances and cannot grow an arbitrary request cache. At most three distinct
restarts per transport in a rolling 30-second window protect the worker.

## One recovery owner

The shared ICE strategy is composed into `createMediaConnectionRecovery` and the
platform's existing transport-state check. A supporting, previously connected,
still-owned transport can claim its failure deadline; the legacy timer is then
cancelled. Other transports retain the old platform policy. Only `failed` or
`disconnected` starts recovery; the latter waits 1.5 seconds for natural recovery.
Healthy media during signaling loss does not trigger restart.

An outage has one absolute 20-second deadline and at most three wire attempts,
with two-second settling/backoff periods. `connecting`, repeated failures and
new notifications cannot renew it. A rolling 30-second request budget prevents
flapping connected/failed events from creating unlimited new rounds. Retransmit
an unacknowledged sequence before issuing a new one; do not rotate a server-side
credential merely because an ACK was lost. SDP apply is never concurrent for the
same transport. Resolving restart is not proof of recovery: observe the current
transport as connected after the operation settles.

Signal loss suspends requests and invalidates in-flight response application.
Only the existing coordinator's confirmed recovered same-media session resumes
them; a fresh socket/server session resets media. A round waiting for signal
still expires at its original deadline. An already-started library operation
cannot be forcibly cancelled; generation/transport checks prevent its completion
from committing to a successor and transport close is the final cancellation.

Leave, room change, unmount, transport replacement and explicit stop cancel the
relevant operation/timers. A missing resource, stale server session, unsupported
native method, terminal response or exhausted budget invokes existing safe media
teardown/error UI. A dedicated mobile screen failure stops only that share,
preserving voice. Paused/muted producers and existing viewing selection are not
recreated or toggled by restart. Remote control keeps its disconnect revocation.

For media-only failures, the first accepted new server restart sequence also
revokes the participating socket's remote-control grants and pending requests
before rotating ICE. This reuses the existing control service and does not grant
control again. A duplicate ACK reads the cached result without revoking a grant
that the user manually approved afterwards. Invalid, stale, overlapping or
rate-limited requests have no revocation side effect. Revocation failure fails
closed without rotating, and synchronous leave/disconnect is checked again.
This protects entry into accepted ICE recovery, not the interval before the
server receives a recovery request.

## Planned evidence and rollout boundary

Deterministic tests cover signal-only loss, recovered/fresh sessions, event storms,
duplicate requests/ACK loss, serialized apply, stale response/generation/sequence,
bounded deadlines/attempts, cancellation, server birth-generation authority and
old/new combinations. Real dual Chromium/SFU validation must observe changed ICE
parameters, stable producer/consumer identity and resumed decoded media; synthetic
fault injection and real browser execution are recorded separately.

Android network switching/native encoder and Windows native capture, real weak
networks and long calls remain manual acceptance. No deployment is implied. The
rollback boundary is `d8eb548`; ICE work is kept in separate commits and adds no
database migration. Final commands, evidence and limitations are appended after
implementation.

## Local entry and observations

```powershell
npm run build:packages
npm run build -w cove-server
node tooling/verify-ice-restart.cjs
node tooling/verify-media-recovery.cjs --repeat 3 --output runtime/recovery-ice-final.json
```

The browser command starts its own Vite on loopback 55193, a temporary SFU backend
on media port 41020, hidden Chromium peers and a loopback TCP proxy. Occupied ports
fail; it never stops other applications by port/name. Existing dependencies are
required and no installation occurs. A 120-second external watchdog bounds the
run. It uses public mediasoup APIs and test-only candidate routing; no production
hook reaches private PeerConnection internals or test fault controls.

The proxy stalls actual RTP/STUN forwarding until the browser naturally reports
disconnected/failed and the recovery applies new credentials; this is a controlled
ICE/TCP path fault, not an OS network switch. UDP-only routing was not established
in the initial fixture and is not counted as validated. Chrome synthetic input
and muted windows isolate the test from hardware capture and audible output.
The fixture initially reported zero `totalAudioEnergy` even before fault injection.
Diagnosis with deterministic synthetic WAV input and independent capture/producer/
consumer PCM analyzers established nonzero decoded audio while that statistics
field remained zero. The revised test uses the real consumer track's nonzero PCM,
running analysis context and increasing received/non-concealed sample counters;
it preserves the raw zero statistic rather than interpreting it as silence.
Audio PCM recovery and video decoded-frame recovery are separate assertions.
`speakerAudibilityMeasured` remains false, and no acoustic/speaker claim or
end-to-end latency measurement follows.

`runtime/ice-restart-integration-result.json` starts with a fresh runId and
passed:false, and records completed/passed only after owned backend cleanup.
`runtime/ice-restart-browser.log` contains bounded decision event names. Existing
`[media-recovery]` logs identify `ice-restart-begin`, `request`, `retry`, `applied`,
`connected`, `failed`, `cancelled` and `signal-wait`; details are key/attempt/fixed
reason codes. An applied SDP promise alone is never called media recovery.

Mobile explicit viewer-only cancellation during recovery uses the resource
owner's teardown, preserving the room's available-share inventory. It invalidates
the generation and closes idle transports before a late ACK can apply credentials;
the next manual watch obtains fresh transports. Stopping a watch while in voice
and internal watch switching preserve their shared voice transport behavior.

Transport resource ownership uses mobile `transportGeneration`, independent from
the operation `mediaGeneration`. Explicitly joining voice after viewer-only setup
may reuse its send/receive transports; this must preserve the existing ICE owner
and monotonically increasing sequence. Teardown invalidates both lifetimes. The
regressions cover watch-to-voice reuse, a second pending recovery ended by a remote
share stop, and later manual watching with fresh transports and isolated old ACKs.

## Final local regression evidence

| Check | Result / local evidence |
| --- | --- |
| Desktop CI | 436 TS + 85 CJS tests, shared builds, renderer/Electron type checks passed; `runtime/ci-desktop-ice-final.log` |
| Mobile CI | 46 suites / 560 Jest tests and types passed; `runtime/ci-mobile-ice-final.log`; Android native boundaries mocked |
| Server CI | 185 TS, 8 shared-core, 29 root-tool, 5 native guard tests and real SQLite/SFU smoke passed; `runtime/ci-server-ice-final.log` |
| Production renderer build | Vite build passed, `runtime/desktop-build-ice-final.log`; bundle-size warning remains, no latency/size improvement claimed |
| Recovery repetition | Three complete rounds / nine suite-rounds passed, no timeout/cancellation; `runtime/recovery-ice-final.json` |
| Real browser media fault | Completed run `ad8eebbd-874e-4a9d-899c-026fcf896eb8`: new ICE credentials, same transport/producers/consumers, resumed video frames and real consumer PCM; `runtime/ice-restart-integration-result.json` and `runtime/ice-restart-browser.log` |

In that controlled browser run, audio RTP packets advanced 62 -> 100 after the
forwarding fault, non-concealed received samples 60,620 -> 93,885, and actual
consumer PCM RMS was 0.00816 before and 0.01326 / 0.00926 after recovery, with
running silent analysis contexts. The raw inbound energy statistic stayed zero.
These values establish this synthetic decode test's non-silent baseline/recovery;
they are not audio quality, latency or real-device performance measurements.
Both browser/backend exited successfully and owned test ports were released.

The media-only remote-control regression first reproduced eight failing checks;
the resulting helper/lifecycle/control slice passes 48 tests. It exercises the
real registry, control service and Socket handlers with synthetic input only:
controller/sharer restart, pending requests, rejected old input, later manual
grants, cached/invalid requests, callback failure/reentry and synchronous leave.
The repeated recovery tool includes this slice; no OS input injection occurs.

No Android device, Windows native screen/audio capture, Wi-Fi/cellular handoff,
real weak-network deployment or long-call acceptance is implied. Old clients keep
using normal transports on the new server; new clients see no optional capability
on an old server and retain the legacy failure deadline. New wire identities,
server birth-generation ownership, duplicate/late requests and fallback responses
are covered deterministically and with local native worker requests; installed
mixed-version device combinations still need acceptance.

For rollback, keep the existing isolated checkout/branch and switch a separate
clean test branch or copy to `d8eb548`, then rebuild shared packages and apps. The
ICE implementation and review fixes are separate commits; reverting those does
not require a database or credential migration. Do not hard-reset the user's
regular checkout or switch a running deployment as part of this local test task.
