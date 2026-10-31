# Electron shared-texture interoperability probe

This is an isolated one-frame experiment, not a product capture provider or
throughput test. It creates a known 64x64 BGRA texture with four colored
quadrants and a right-pointing arrow. It never acquires the desktop, microphone
or any user image.

Build using the already installed compiler, then run using the desktop's actual
Electron 44 dependency:

```powershell
& .\tooling\shared-texture-probe\build.ps1
node tooling/shared-texture-probe/run.cjs
```

Build writes only `runtime/shared-texture-probe/helper.exe`; it installs nothing.
The run has independent Electron user/session data, no remote navigation,
sandbox enabled, context isolation enabled, and renderer Node disabled. IPC
accepts only its own main frame and a per-run correlation value. It uses the
official `sharedTexture` API in the preload.

The helper accepts only its own parent's PID. It duplicates the NT handle into
that process, waits for main to import it, then closes that original main-table
handle once with `DuplicateHandle(DUPLICATE_CLOSE_SOURCE)`. It keeps the texture
alive until Electron reports `allReferencesReleased`. The renderer creates one
VideoFrame, classifies every output pixel, zeros its temporary CPU copy, closes
the frame and releases its import. No image data, raw handles or correlation
values are retained in result.json.

`runtime/shared-texture-probe/interop-EQIONY/result.json` passed: 4096 pixels,
zero mismatches, expected orientation/alpha/timestamp, main temporary handle
closed, all references released and helper exit 0. This proves this machine's
interop for one immutable frame. It does **not** validate a streaming buffer
pool, encoder retention, a desktop source, GPU restart or sustained 120 FPS.

A production path would still need bounded credits, per-frame epochs and
timestamps, all-reference release before slot reuse, native cursor composition,
display/adapter changes, explicit capture ownership/stop and tested fallback.
The existing product capture, audio and codec paths do not load this probe.
