# Screen publication and watch intent

Mobile encoding fallback replaces RTP producers, not the user's OS capture.
`shareSessionId` is the native capture UUID and remains stable across codec
attempts; `publicationAttempt` increases within that capture. A new capture gets
a new UUID. Neither field grants room membership, remote-control permission or
authority over another peer's producers.

## Compatibility

The existing `ms:screen-sharing-capabilities` response gains the optional boolean
`publicationContinuity`. Mobile adds the publication fields only when that flag
is `true`. Existing servers continue to receive the old appData/close shape.
There is no protocol-version bump or assumption that the local server change is
already deployed. Automatic continuation requires updated publishing and viewing
clients plus the server capability; legacy or unmarked closes still end viewing.

During a known codec fallback the owner closes its exact producer IDs using the
optional `{ replacing: true, shareSessionId }` close fields. The server validates
that session against the producer's registered appData, then includes the same
metadata in producer and consumer close notices. The latter handles either
notification order. Wrong/missing session identity cannot opt an explicit close
into replacement continuation. Metadata lives in a WeakMap keyed by producer,
so it does not accumulate per-room or per-user state.

## Viewing lifecycle

`packages/client-core/src/screenWatchRecovery.ts` owns the bounded continuation
policy; platform viewing hooks own consumers and rendering. Initial viewing is
still an explicit action. A same-session, later-attempt announcement resumes only
the current viewer's intent. Duplicate/older attempts and old producer/consumer
close events cannot clear a replacement picture. The available-source list also
rejects older attempts so it cannot roll back behind the selected publication.
Known publication audio must match both the current capture UUID and attempt;
late audio announcements or closes from an older stream cannot attach to the new
picture. Peers with no publication metadata keep their legacy behavior.

A replacement window shares at most three consume attempts across all producer
announcements, with 250/750 ms retry delays,
and an absolute five-second window starting at the first replacement signal.
Later announcements do not extend that window. Each asynchronous continuation
has a generation guard. Cancel, leave, room/socket teardown, a new share session,
an explicit producer close, exhaustion or expiry invalidates it. A late consume
result uses the existing transport cleanup path to close its orphan consumer.
Native capture, microphone acquisition and remote-control authorization are never
started by this continuation policy.

If the publisher stops while a codec attempt is between producers, no new stream
may be committed by its cancelled operation. Viewers waiting for a replacement
expire within five seconds; the feature does not infer a new publication from a
later unrelated screen share. Server disconnect/remote-control revocation behavior
is unchanged; remote control must be approved again separately.

## Validation

Tests exercise close-first and announcement-first replacement, late old producer
and consumer closure, same-peer replacement rendering, stale attempt rejection,
cancel/leave while resuming, retry exhaustion and the absolute deadline. Mobile
publisher tests verify stable identity across H264→VP8 fallback and legacy payloads
when the capability is absent. Server handler tests verify validated close metadata
and consumer-close-before-producer-close ordering. Unsupported screen-codec errors
on mobile give an explicit VP8 compatibility action without changing voice errors.

These are local logical/component/handler checks. Android hardware fallback and
two installed clients over real weak networks still need acceptance testing; no
latency or reliability improvement is claimed from these tests alone.
