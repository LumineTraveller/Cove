# Room share-entry and navigation rendering regression

`share-entry-navigation.cjs` drives the real `ChatRoomV2`, room CSS, and media
hook inside Electron. The fixture replaces only signaling, transport, capture,
and account data; it does not access a live server, account, or microphone.

## Offline Linux headless run

From the repository root, with dependencies and shared packages already built:

```sh
COVE_UI_QA_BUILD="$PWD/runtime/ui-validation/current" \
  node apps/desktop/tests/ui/build-share-entry-fixture.cjs

COVE_UI_QA_URL="file://$PWD/runtime/ui-validation/current/tests/ui/share-chat-qa.html?layout-animation" \
COVE_UI_QA_ARTIFACTS="$PWD/runtime/ui-validation/result" \
XDG_CACHE_HOME="$PWD/runtime/ui-validation/cache" \
  apps/desktop/node_modules/electron/dist/electron \
  --ozone-platform=headless --ozone-override-screen-size=1440,900 \
  apps/desktop/tests/ui/share-entry-navigation.cjs
```

This workflow uses Electron's software offscreen renderer. It does not require a
Vite server, X server, remote browser connection, or disabled browser sandbox.
`COVE_UI_QA_SOURCE` optionally selects another desktop source tree for an offline
build (for example, the pre-fix source snapshot). The builder retains relative
asset paths and copies the production logo into the nested fixture directory.
The installed, lockfile-pinned desktop Electron version is recorded in JSON.
Set `COVE_UI_QA_WIDTH=900` for the narrow-window variant (default: 1440).

Alternatively, set `COVE_UI_QA_URL` to the existing Vite fixture URL in an
authorized development environment. The default is port 55173.

## Checks and evidence

- Self-share and remote-watch use all available workspace from their first
  sampled sharing-layout frame; the ordinary layout is allowed to settle before
  remote-watch begins.
- Room labels, brand, and settings nodes remain mounted; label width stays fixed.
- Expansion defers labels until the panel is opening, and collapse hides labels
  immediately. Repeated and interrupted reversal flows are exercised.
- Shared video and its stream remain mounted and playing throughout navigation
  and intentional chat opening/closing.
- The closed chat is inert; opening restores composer focus, and closing a
  focused composer hands focus back to the edge toggle without horizontal scroll.
- Hidden navigation actions are disabled and removed from tab order; collapse
  restores focus to the visible expand control. Voice-count badges are not clipped.
- Reduced-motion preference produces direct endpoint widths.
- A real `MediaStreamTrackGenerator` withholds chunks before first-frame delivery;
  the full-size opaque loading surface covers the unready video. Cancelling that
  pending share and immediately starting another must recover cleanly.

The artifact directory contains `result.json`, settled screenshots, and a paint
sequence for each flow. Paint filenames include actual elapsed main-process
capture time. Renderer geometry samples have their own relative clock; do not
pretend those timestamps map exactly to a particular paint. The test records
actual pixels at the requested viewport size and fails if capture produces another size.

These checks validate geometry, node stability, first-frame behavior, and
interaction continuity. Software-renderer frame intervals on shared cloud CPU
are diagnostic only and are not a hardware smoothness/FPS benchmark. Native
screen/audio capture, hardware encoding, and production network behavior are
outside this synthetic rendering fixture.

## Sharing exit frame regression

Run the same built fixture with `share-exit-transitions.cjs` in place of
`share-entry-navigation.cjs`. Set `COVE_UI_QA_WIDTH=900` for the narrow variant.
The runner records source SHA-256 hashes, Chromium/Electron versions, geometry
samples on every renderer animation frame, and real offscreen paint PNGs.

It checks the **first ordinary frame**, rather than waiting for a settled result:

- The member column already has its ordinary width; the chat fills the remaining
  workspace, is on-screen, hit-testable, non-inert, and has readable history text.
- The chat/composer nodes remain mounted, the composer can receive focus without
  scrolling, and no shared video remains mounted after exit.
- The control dock is already centered below the ordinary member column.
- Local stop, OS-style track end, stop before the first video frame, viewer stop,
  remote producer closure, open/closed chat, interrupted chat animation, rapid
  toggles, interrupted channel expansion, and immediate stop/re-entry all run.
- Ordinary and sharing channel expand/collapse retain continuous rail motion,
  aligned dock movement, and stable chat/video nodes; reduced-motion exit runs.
  Intentional rail/dock movement keeps the existing 320ms/340ms easing, with a
  6px regression tolerance established from the delivered baseline (observed
  maximum about 5.3px). Share-exit dock centering uses a stricter 1px tolerance,
  including an interrupted channel expansion.

The fixture's test-only `endLocalShareTrack`, `endRemoteShare`, and
`restoreRemoteShare` methods emit deterministic capture/signaling events into the
real production media hook. They do not replace the room renderer or its CSS.
For pre-fix comparison, the source override can point at an isolated delivered
source snapshot with only the identical test-fixture methods added.

Paint elapsed times and renderer elapsed times use independent clocks. Paints
prove actual pixel states, but a paint timestamp must not be presented as an exact
mapping to a specific renderer sample. Shared cloud software-renderer timings
are not Windows native capture/encoding or hardware-FPS measurements.
