# Connection recovery diagnostics

The shared recovery layer records metadata in a bounded in-memory journal.
Desktop and Android include its snapshot in the existing manual media diagnostic
export. Recording does not depend on opening the statistics overlay, and creates
no timer, file, network request or automatic upload. Ordinary connection and
cleanup events without a recovery round are ignored.

## Recorded contract

Each entry contains a local anonymous `recoveryId` (`r1`, `r2`, ...), a fixed
channel (`signal`, `send`, `receive`, `screen`), stage, relative `atMs`, elapsed
time and, when applicable, bounded attempt number and an allowlisted reason.
The ID correlates one channel's recovery within this hook lifetime; it is not a
user, room, transport or server identifier and cannot identify another client.

Stages distinguish request/ACK waiting from validated ACK/native `applying`,
then `applied`, connected, retry, cancellation, failure and safe fallback.
`REQUEST_FAILED` and `APPLY_FAILED` identify different failure boundaries.
`SIGNAL_TIMEOUT` and `MEDIA_TIMEOUT` are separate causes. A retained healthy-media
signal outage stays associated with its eventual signal connection or leave.
Full owner teardown calls `cancelActive()` after ICE cancellation. This retires
remaining legacy-grace and signal rounds with `OWNER_TEARDOWN`, so a manual
leave or room change cannot attribute a later connection to the old recovery.
Repeated teardown and teardown without an active recovery produce no entries.
An applied native promise does not establish restored audio/video.

The journal retains at most 256 entries and reports the number dropped. Repeated
identical consecutive events are coalesced. Active/latest bookkeeping has only
the four fixed channels. Snapshot objects are copies and the mobile export
revalidates the schema; arbitrary event names, keys, strings and extra fields are
discarded. Clock reversal cannot produce negative elapsed time.

ICE passwords, tokens, SDP, candidates/addresses, socket/room/transport IDs,
user names, messages and captured content never enter this journal. Desktop
media exports also omit raw device IDs, group IDs, RTCP CNAME, RID, transaction
IDs and unbounded RTP parameter strings. Existing numeric capture/encode/RTP
metrics remain available; track/sender metadata uses explicit allowlists.

## Ownership and checks

`packages/client-core/src/recoveryDiagnostics.ts` owns retention, correlation and
normalization. `transportIceRecovery.ts` emits observation events at existing
request/apply/teardown boundaries; it does not change retry timing or media
ownership. Platform hooks retain the journal and pass it to their current export.
There is no new UI or persistent logging path.

The deterministic checks are `packages/client-core/tests/recoveryDiagnostics.test.ts`,
desktop `mediaDiagnostics.test.ts`, and mobile `mobileDiagnostics.test.ts`.
The integration/acceptance record separately states which commands actually ran;
source tests and a type check alone are not a successful runtime validation.

Recovery failures should be investigated from the last stage and reason in a
single anonymous round, followed by its cancellation/fallback outcome. These
relative timings describe recovery decisions, not end-to-end media latency.
