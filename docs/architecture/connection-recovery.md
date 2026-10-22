# Connection and media lifecycle

Connection registration, recovery policy, media resource ownership and UI intent
have different lifetimes. Keep these responsibilities separate:

| Layer | Owner / extension point | Responsibility |
| --- | --- | --- |
| Registration | `packages/client-core/src/sessionRegistration.ts` | One current ACK/retry sequence; platform adapters interpret authentication errors |
| Signal recovery | `packages/client-core/src/mediaRecovery.ts` | Re-read live state on timeout / CONNECT; qualify recovered socket ownership |
| Platform recovery | Desktop `voiceConnectionRecovery.ts`, mobile `useMediaConnectionRecovery.ts` | Adapt refs, errors and existing platform deadlines; choose timeout policy |
| Media resources | Desktop `useVoiceSession`, mobile `useVoiceTeardown` / `useMediaTransports` / `useVoiceJoin` | Invalidate async generations before closing native/RTP resources |
| UI intent | Room controller / session hooks | Explicit room leave/switch, mute and watch selection; recovery never initiates capture or remote control |

Socket.IO's transport connection does not itself prove account registration,
room readiness or media recovery. A fresh server session must discard the old
media resources. A recovered session may retain them; explicit leave wins over
a late CONNECT and cleans up the retained server voice session.

The first refactor preserves the existing platform policy: desktop retains
recoverable established media on a signal timeout; mobile has a 7.5 second signal
timeout. Desktop starts a media failure deadline only for `failed`; mobile uses
`failed` or `disconnected`. These differences are deliberate compatibility
boundaries, not a reason to combine the transport timers with the signal timer.

The shared recovery controller owns only its signal deadline. Disposing it
cancels that deadline. Resource teardown owns generation invalidation and all
transport timers. New recovery strategies belong in the shared policy with
explicit platform opt-in; native setup/cleanup belongs in resource hooks. Avoid
adding more signal listeners to the large producer/consumer event hook.

No server protocol, grace period, `voice:join` acknowledgement requirement, screen
capture or remote-control authorization changes are part of the refactor.

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
