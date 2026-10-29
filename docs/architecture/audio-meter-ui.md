# Audio meter ownership and rendering

Audio levels are high-frequency observations, separate from room state and media
intent. `useAudioMeters` retains the existing 100 ms sampling, RMS calculation,
normalization and channel keys. It publishes both voice and shared-audio maps into
one store owned by the `useWebRTC` instance.

The store is allocated once per hook instance, not per render or room ID. Existing
stable meter callbacks retain that instance. The room/voice lifecycle still owns
starting and stopping the sampler; `stopMeters()` clears its timer reference and
the maps. No new timer, transport, capture, IPC, persistent preference or global
store is introduced.

`publish()` installs both immutable snapshots before notifying subscribers. Only
keys whose presence or exact value changed notify; no RMS quantization, smoothing
or rate reduction is used. `clear()` is reusable, retains active subscriptions and
can be followed by another publish. It is not an irreversible disposal operation,
which would break React StrictMode's cleanup/setup replay.

`AudioMeterBindings.tsx` subscribes the avatar and volume-control leaves through
`useSyncExternalStore`. A snapshot is a number, so unchanged reads satisfy
`Object.is`. Subscriptions use stable store/channel/key dependencies and clean up
their own registrations. A self-member's primary key uses nullish fallback:
primary `0` remains `0`; only a missing primary uses the fallback. The original
speaking threshold and voice/self mute conditions remain in the binding.

The generic avatar and volume controls keep their existing APIs. Chat remains
mounted while hidden; its memo boundary follows messages, input, profile, remarks,
appearance and history props. Only the four callbacks required for that boundary
are stabilized, with their original room/server/input closure semantics.

## Reading levels and extending the UI

`rtc.speakingLevels` and `rtc.sharedAudioLevels` remain current, on-demand getters.
They do not request a render of the component owning `useWebRTC`. New live meter
views should use a leaf subscription rather than read a level in a large parent
and expect unrelated room renders to refresh it. Infrequent controls, media
intent, connection recovery and resource ownership stay on their current paths.

`subscriptionCount()` exposes a numeric resource diagnostic without member keys.
The performance fixture owns its observer subscriptions separately from the UI,
unsubscribes before leaving and requires the total count to reach zero after room
unmount. Unknown subscriptions are not removed to make a test pass.

## Verification boundaries

Pure tests cover per-instance isolation, exact values and immutable snapshots,
atomic channel publication, changed-key notification, primary/fallback behavior,
reference-counted subscriptions, idempotent unsubscribe, clear and reuse. The
desktop audio suite exercises the public level getters rather than a mock React
state's position in a hook call list.

The full room performance fixture uses a finite varying-gain oscillator through
the real microphone/media hooks, two loopback SFU peers and 200 chat messages.
It requires changing actual level values and live store notifications even when
the room controller no longer commits. It uses no hardware microphone or speaker.
The fixture checks real dimensions, codec, source pixels/sequence and media/native
resource release; a failed or interrupted run is not a performance success.

The display used for the local qualification is 2560x1600. Its aspect-preserving
1080-high capture is 1728x1080, not 1920x1080. Helper capture, writer acceptance,
encoder input, encoding, decoding and video presentation remain distinct metrics.
These checks do not promise a constant frame rate on every workload or device.

The [full-room throughput qualification](../diagnostics/native-audio-ui-throughput-20261029.md)
records the active-audio before/memo/store comparison, distinct capture and
encoding rates, actual meter DOM checks, resource counts and reproducible commands.
It also records the unverified boundaries and failed startup evidence rather than
treating every attempted run as a success.

Rollback is local: revert the leaf-store commit to restore the preceding React
state publication. The separate chat memo and exact-value no-op optimization can
be retained. No server, client protocol, codec or persistent-data migration is
required.
