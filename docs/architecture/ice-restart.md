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
