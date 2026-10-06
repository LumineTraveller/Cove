# Cove 1.5.5 accepted snapshot integration

This local integration moves the accepted Media Fix 1.5.5 product snapshot into the formal Cove repository. It keeps the original main history and records the existing uncommitted work before relocating the application workspaces.

## Provenance and rollback

- Formal repository: `C:\Users\cyj06\Desktop\Projects\Cove`, branch `main`.
- Previous main: `3a5b12c53483f916561346b8c1cc72763f15acdc`.
- Original working files and index were saved without rewriting them in checkpoint `b25b7d471dad21b478f27a9c088f325637f47d00`, branch `checkpoint/pre-approved-1.5.5-20261006`.
- Accepted product fix: `98b24e3303b679272334f2b3f7b744f7e48e2092`, descended from the exact `6c767241aee1028940a6226ca143e2ab534e1eea` pre-stability snapshot. Source delivery notes are at `docs/annotation-media-fix-1.5.5.md`.
- Integration was prepared in `C:\Users\cyj06\Documents\Codex\2026-10-06\task\Cove-main-integration`, branch `integration/approved-1.5.5-20261006`.
- The failed stability research history, experimental native worker tree, node_modules, installers, runtime data, and media experiment output are excluded. Existing research and installed test copies are retained separately.

The 405 original source files matched the refactor baseline before integration, including the pending audio, avatar, soundpack, and mobile changes. The checkpoint preserves that work independently of this integration. Recover it into a separate checkout from the checkpoint branch if needed; do not erase newer working files to roll back.

## Product and configuration boundaries

Application sources now live in `apps/desktop`, `apps/server`, and `apps/mobile`; shared runtime code is in `packages`. `baseline/relocation-map.json` traces old paths, and `baseline/integration-contracts.json` records the preserved API surface, accepted native sources, dependency versions, and mobile release metadata. The root `mobile/update.json` remains compatible with the existing raw update URL.

The accepted automatic annotation permissions, source-screen native drawing input, transparent sharer mirror, container-wide control-ball positioning, bounded content coordinates, remote-control white dot, and 200 Mbps ceiling are preserved. No additional congestion, FPS, or quality changes are made during integration.

The formal desktop remains `Cove` / `com.cove.app`, with its existing updater and profile behavior. Lab packaging configurations and their forced port 3401 default are excluded. Local original `client/.env.local` and `client/.env.production` move to `apps/desktop` as ignored configuration; `VITE_SERVER_URL` remains a supported production default. The development launcher defaults to isolated loopback ports and compiles the annotation window helper along with the existing native helpers.

Windows screen mirroring requires Windows 10 2004 or newer. The existing share selector still prefers its first screen source; this integration adds no new source picker. In the window fallback, the read-only mirror follows the foreground shared window. The owner input overlay becomes mouse-transparent on exit, disable, source end, and window cleanup.

## Validation on the integration checkout

Passed:

- Shared package builds; desktop, server, and mobile type checks; server production build.
- Desktop production renderer build; desktop and server Electron compilation, including the annotation geometry helper.
- 8 structural and development-startup checks; 4 client-core tests; 82 server tests; 292 desktop tests; 163 mobile tests in 25 suites.
- 56 real Chromium annotation UI checks at a 1440 px viewport, using synthetic capture and sockets: black bars, drag boundaries, drawing, default permission, explicit disable, and session cleanup.
- 10 real Chromium remote cursor checks, including letterbox input rejection and cleanup.
- Actual main/preload/renderer startup in an isolated profile, visible window, and the original production default `http://idea.sakurafrp.com:12345`. No login was performed.

Outstanding validation result:

- The synthetic captioned-window native test at 150% DPI passed its first 18 checks, including WGC client geometry, capture exclusion, mouse pass-through, native pen/laser/eraser, IPC validation, Escape and exit-button cleanup. It then failed the mirror-visibility assertion after leaving drawing mode. Explicitly refocusing the synthetic source did not resolve the assertion. This is recorded as a failure, rather than a passed native acceptance run. The product overlay code remains the accepted snapshot; no speculative repair is included in this integration. The remaining checks in that run were not reached.
- A real second monitor was unavailable. Mixed-DPI multi-monitor interaction and Android APK/device execution were not tested in this integration.

The permission-test harness now provides the newly imported native-overlay and resize adapters, the native UI test explicitly refocuses its foreground source, and the structural tests use a standalone contract rather than requiring an unrelated historical Git tag. Two trailing blank lines were removed for diff hygiene. No product behavior was changed by these test adjustments.

## Release state

This is a local main integration only. No package was installed, no Git push or release tag was made, and no server was deployed or switched. The desktop is 1.5.5, server remains 1.5.4, and mobile remains 0.7.0. A future release still needs an explicit instruction, release notes/version review (the current desktop workflow requires matching server and client versions), and final packaging checks.
