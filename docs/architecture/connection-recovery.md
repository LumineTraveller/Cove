# Connection and media lifecycle

Connection registration, recovery policy, media resource ownership and UI intent
have different lifetimes. Keep these responsibilities separate:

| Layer | Owner / extension point | Responsibility |
| --- | --- | --- |
| Registration | `packages/client-core/src/sessionRegistration.ts` | One current ACK/retry sequence; platform adapters interpret authentication errors |
| Signal recovery | `packages/client-core/src/mediaRecovery.ts` | Re-read live state on timeout / CONNECT; qualify recovered socket ownership |
| ICE strategy | `packages/client-core/src/transportIceRecovery.ts` | Bounded, per-owned-transport SFU restart; composed into signal recovery, with one failure deadline |
| Platform recovery | Desktop `voiceConnectionRecovery.ts`, mobile `useMediaConnectionRecovery.ts` | Adapt refs, errors and existing platform deadlines; choose timeout policy |
| Media resources | Desktop `useVoiceSession`, mobile `useVoiceTeardown` / `useMediaTransports` / `useVoiceJoin` | Invalidate async generations before closing native/RTP resources |
| UI intent | Room controller / session hooks | Explicit room leave/switch, mute and watch selection; recovery never initiates capture or remote control |

Socket.IO's transport connection does not itself prove account registration,
room readiness or media recovery. A fresh server session must discard the old
media resources. A recovered session may retain them; explicit leave wins over
a late CONNECT and cleans up the retained server voice session.

The baseline refactor preserves the existing platform policy: desktop retains
recoverable established media on a signal timeout; mobile has a 7.5 second signal
timeout. Desktop starts a media failure deadline only for `failed`; mobile uses
`failed` or `disconnected`. These differences are deliberate compatibility
boundaries for legacy servers. Supporting server transports now opt into the
[bounded ICE restart strategy](ice-restart.md), which claims its own failure
deadline and cancels the corresponding legacy timer. A signal-only outage of
healthy media never starts ICE restart.

The shared recovery controller owns only its signal deadline. Disposing it
cancels that deadline and invalidates captured late socket callbacks. Resource teardown owns generation invalidation and all
transport timers. New recovery strategies belong in the shared policy with
explicit platform opt-in; native setup/cleanup belongs in resource hooks. Avoid
adding more signal listeners to the large producer/consumer event hook.

The original structural refactor changed no server protocol, grace period,
`voice:join` acknowledgement requirement, capture or remote-control authorization.
The subsequent optional ICE protocol and its separate bounded deadline are
specified in [ICE restart](ice-restart.md); existing deployments are not assumed
to provide it.

## Resource cancellation

Mobile teardown increments `mediaGeneration` before releasing resources and
cancels the pending watch UI operation. Device initialization caches a Promise
only within that generation; a new session cannot reuse cancelled work. The old
Promise's finalizer can clear only its own cache entry. Watch finalizers likewise
must own the current watch generation before changing busy state.

Native voice audio has an explicit ownership flag separate from `inVoice`.
Teardown can therefore stop an audio session while output routing is still
pending. Every awaited native route/status result is checked against the media
generation before committing UI/voice membership. The old operation cannot
rejoin, publish or stop a newer session after leave, room/socket change or unmount.

Receiver-only transports record the same socket owner as voice transports;
recovery does not imply microphone permission or screen-capture permission.

## Recovery policy changes (separate from the structural refactor)

Both registration adapters now use the shared ACK generation/retry controller.
Missing or malformed ACKs are transient errors, not successful registration or
authentication rejection. A connection gets at most six attempts with bounded
backoff (500, 1000, 2000, 2500, 2500 ms). Success/rejection/exhaustion ends the
round. Disconnect, effect cleanup or explicit manual retry invalidates callbacks
and timers; manual retry starts a fresh round on the same socket and retains
credentials. Authentication rejection retains each platform's existing behavior.

Desktop's existing **initial 30 second connection deadline takes precedence**
over that six-attempt budget. It is completed after first registration; subsequent
recovery registration gets the bounded ACK budget. Slow initial ACKs can therefore
stop before six attempts. The existing desktop `SESSION_IN_USE` backoff remains
separate; mobile's existing session replacement/login behavior is preserved.

Mobile now opts into the same established-media signal-timeout retention policy
as desktop. At 7.5 seconds it re-reads live voice/watch intent and transport state.
Established media with a non-failed/non-closed transport is retained; unfinished
operations or failed media are cleaned up. This neither extends the server's
5 second peer grace nor recreates lost server resources. A fresh socket/session
still resets the old resources immediately, including after a server restart.
Legacy media failure timers remain independent and retain each platform's original
policy. The subsequent ICE strategy repairs only an existing supported transport;
it never automatically rejoins or starts capture.

Mute/watch intent is preserved while existing media is retained. Once a fresh
session or media failure requires teardown, the user explicitly rejoins or watches
again; the patch does not silently reopen a microphone or screen share. Remote
control still revokes authorization on every disconnect and never auto-restores.

## Validation boundaries

Deterministic tests cover stale ACKs, retry exhaustion/manual retry, native route
cancellation, room/socket changes, viewer-only recovery, delayed CONNECT over
multiple outages, independent send/receive failure deadlines and old setup
Promises. Local Socket.IO recovery and native SFU tests use loopback synthetic
clients/media. Electron renderer checks use an isolated test profile and a fake
signaling fixture; they do not establish an end-to-end production connection.

The additional real Chromium/SFU ICE regression uses synthetic capture and a local
TCP forwarding proxy: the browser detects a real media-path stall, ICE credentials
change and decoded media must advance again. It does not simulate a state event
as a substitute for the packet-path interruption. See the ICE document for exact
audio/video evidence and limitations.

Real Android audio routing, Wi-Fi/cellular handoff, OS suspend/resume, long calls
and mixed installed client/server versions still require device/network acceptance
tests. Passing the logic, renderer and loopback tests is not a release-readiness
claim. The new server protocol is optional and has not been deployed, so no new
server feature is assumed available on an existing deployment.

## Locating recovery decisions

The shared adapter emits bounded event names through `onEvent`: signal connected/
disconnected, signal timeout with media retained, media reset (explicit disconnect,
signal timeout or fresh session), and cleanup of a recovered session after leave.
Desktop retains its existing sink; mobile uses `[media-recovery]` console events.
These events contain reason codes rather than account tokens, full socket payloads
or ICE addresses. They locate a lifecycle decision; they are not proof of network
quality or successful end-to-end media playback.
