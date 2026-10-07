Start the existing desktop Vite server for this checkout on `127.0.0.1:55174`, then run from the repository root:

```powershell
node node_modules/electron/cli.js apps/desktop/tests/ui/fps120-qa.electron.cjs
```

The runner mounts the actual `ChatRoomV2`, `ScreenShareSettingsV2`, CSS and `useWebRTC` hook through the existing synthetic room fixture. It sends native Chromium mouse events and verifies controls are hittable. All media is generated in-page from canvas/oscillators, physical device enumeration is replaced with an empty list, native permissions are denied, and an isolated temporary Electron profile under `runtime/ui-validation/fps120` keeps personal settings untouched.

Checks cover normal/game120 selection; FPS, resolution and native-resolution preservation on mode toggles; actual hook persistence after confirming a synthetic share; fresh renderer restoration; old30/60 settings; cancellation; and actual capture requests using ideal/max120 with no hard minimum. JSON plus normal/game/reloaded screenshots are written to `runtime/ui-validation/fps120`. `COVE_FPS_QA_URL` and `COVE_FPS_QA_ARTIFACTS` can override the fixture URL and artifact directory.

This verifies the requested cadence and settings flow. The fixture deliberately produces30 FPS synthetic video; no conclusion about physical capture, encoder, network or decoder reaching120 FPS follows from this test.
