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

## Ordered updates and capture candidates

An update requests capture immediately while the caller still has transient
user activation. Only its commit is queued, per publication session. At commit
time it reads the currently owned stream instead of retaining the stream that
was current before its picker finished. This prevents reversed picker/replace
completion from leaking an intermediate stream or restoring stale settings.

The session owns a set of acquired but uncommitted candidate streams. Stop,
leave and producer closure release that set immediately; a later picker result
checks its epoch and releases itself. A new publication has its own queue and
does not wait behind an unresolved operation from the old session. A candidate
is removed from the set when attached, before subsequent audio or parameter
work can fail. Committed-track ended handling is installed before awaiting
audio startup and also checks for a track that already ended.

## Capture size and the encoder boundary

Preset mode supplies only maximum width/height to the initial or replacement
`getDisplayMedia` request. The whole source keeps its aspect ratio and smaller
sources are not requested at an ideal/minimum larger size. Native-resolution
mode preserves the FPS-only capture request. The existing RTP plan remains the
output ceiling, so a platform ignoring capture-size constraints still uses the
normal sender limits. No repeated post-start `applyConstraints` is introduced.

This optimization cannot move the Windows desktop-duplication readback onto the
GPU or change Chromium's capture scheduler. The native probes and one-frame
shared-texture experiment are isolated tooling, not providers loaded by the
application. See [the measured capture architecture](../diagnostics/screen-capture-efficiency-20261028.md)
for those costs and the future `CaptureAdapter`/`CaptureSession` boundary.
