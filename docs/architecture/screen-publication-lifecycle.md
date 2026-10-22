# Desktop screen publication ownership

Screen capture/publish and native system-audio startup can finish after the user
has stopped sharing, left voice, switched rooms or started another share. These
results belong to the operation that requested them; they cannot claim the new
session's transport or clean up its resources.

`useScreenPublishing` captures the voice `mediaGeneration`, sending transport
identity, socket ID and a local publication generation. It checks ownership after
capture, warmup, produce and audio startup. Stop invalidates the local generation.
The pending-start guard suppresses a second picker for the same operation, while
an old voice generation cannot block a new share indefinitely. Late results
release only their own track/producer. Old `onended` and `replaceTrack` completions
must still own the current stream/producer before changing shared state.

`useScreenAudio` separately owns its native-audio attempt. It registers its
pipeline and subscription before awaiting native startup, so teardown can release
pending resources immediately. Starts for the same pending operation share one
request. Its guard includes the video's ownership predicate, voice generation,
transport and socket identity. A stale success or error closes its own producer/
pipeline/listener and cannot stop the global native bridge after a newer audio
attempt has started. Native IPC and Windows capture implementation are unchanged.

Screen publication now delegates both normal and error audio cleanup to
`closeScreenAudio`, instead of duplicating the producer/pipeline/native cleanup.
These cancellation fixes are separate from the explicit codec compatibility
policy. No capture, sharing or remote-control permission is automatically restored.

Tests use synthetic tracks, producers, AudioContexts and an IPC bridge. Eight
video cases first reproduced pending picker, voice/transport replacement, new
share, late producer, late replacement, queued-ended and duplicate-start races.
The first six audio cases reproduced late native success/error/producer and
duplicate allocation before the fix. Additional tests cover pending AudioContext
resume and invalidation by the video owner. Existing screen settings, selected
cadence and PCM pipeline regression tests are retained. Actual Windows source
pickers and native system-audio capture still require local device acceptance.
