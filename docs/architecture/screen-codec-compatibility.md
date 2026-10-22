# Screen codec compatibility

The desktop's negotiated codec set is the intersection of its sending capability
and the router's capability, not the intersection of every viewer in a room.
The server validates `router.canConsume` against each viewer's receiving
capabilities and forwards RTP without transcoding. A desktop AV1 publication can
therefore be unsupported by a phone even though publication succeeded.

The screen settings now expose an explicit **兼容观看（VP8）** option. Its default
is off, including for older saved settings. With the option off, the existing
AV1 → VP9 → browser-auto preference remains. With it on, publication selects VP8
from `Device.sendRtpCapabilities`; lack of negotiated VP8 fails before capture
with a specific error. An encoder failure never silently escapes compatibility
mode into AV1/VP9/auto. The known transient SSRC retry remains bounded as before.

The option does not alter resolution, requested FPS, bitrate limits, screen
capture or audio. VP8 may differ in encoding efficiency; enabling it is an
explicit user choice and does not guarantee every device can decode the selected
resolution/cadence. A phone still sends its actual receiving capabilities to the
server. No transcoding, room-wide quality downgrade or receiver polling is added.

An existing producer cannot change its codec using `replaceTrack`. The option is
read-only in the edit-sharing dialog; changing it requires stopping and starting
sharing explicitly. Runtime update calls requesting a different mode also return
a clear error without stopping or recapturing the existing share.

The policy lives in `screenCodecPolicy.ts`, preferences in `screenPreferences.ts`
and capture/publish adaptation in `useScreenPublishing.ts`. Add future codec
choices in the policy rather than in UI branches or receive hooks. Optional
`appData.compatibilityMode` records the selected mode without a protocol upgrade.

Regression tests cover asymmetric send/receive capabilities, absent VP8,
compatibility encoder failure, unchanged default preference, unchanged FPS/
resolution, persisted opt-in and blocked live-mode changes. Real desktop-to-phone
decoding still needs device acceptance testing; these tests do not prove hardware
codec availability or claim lower latency.

API references verified against the installed mediasoup-client declarations and
the official [Device capability API](https://mediasoup.org/documentation/v3/mediasoup-client/api/#device-sendRtpCapabilities)
and [router.canConsume API](https://mediasoup.org/documentation/v3/mediasoup/api/#router-canConsume).
In this installed client, deprecated `rtpCapabilities` aliases receiving
capabilities; publication now uses sending capabilities, with the old alias only
as a fallback for older adapters that do not expose `sendRtpCapabilities`.
