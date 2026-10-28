# Native capture algorithms and handle ownership validation

These tests create synthetic textures and owned event handles. They never
duplicate a desktop output, capture the screen, modify encoding, install
software, publish builds or run the formal Cove client.

From the repository root on Windows x64:

```powershell
& .\tooling\native-screen-capture\validation\run.ps1
```

The entry point uses an existing x64 MinGW compiler and Node, and the product
builder uses existing cached N-API headers. Nothing is downloaded. Set
`-Compiler PATH`, `-Node PATH`, or `COVE_NATIVE_CAPTURE_NODE_INCLUDE` when the
existing tools are elsewhere. The fallback compiler location is the existing
Strawberry distribution. Each run writes a fresh isolated directory under
`runtime/native-screen-capture-validation/`; compiled binaries, NDJSON results
and the binary hash manifest stay there and must not be committed.

Use `-SkipGpu` for CPU self-tests plus real handle lifecycle tests. Use
`-BuildOnly` to compile and run the CPU algorithm/HLSL compilation checks without
executing either test program. `-OutputDirectory PATH` must select a fresh
directory inside this repository's `runtime/` directory.

To test an already built addon and owned event child directly:

```powershell
node --expose-gc tooling/native-screen-capture/validation/handle-bridge-test.cjs `
  --addon runtime/native-screen-capture/native-screen-handles.node `
  --child runtime/native-screen-capture/handle-test-child.exe
```

`--addon` can also select `apps/desktop/build/native-screen-handles.node` or an
isolated build output. Without explicit paths, the runner searches that project
build path and the existing `runtime/native-screen-capture/` files. It only
spawns its dedicated event child; both processes exit after bounded checks.

## What is verified

`synthetic-pipeline-test.cpp` includes the actual helper source and exercises
its `Pipeline` with small known BGRA images. It checks every output channel
against CPU area/cursor references, covering identity, half and noninteger
scaling, odd source dimensions, nonopaque alpha, COLOR/MASKED_COLOR/MONOCHROME
cursors, negative positions and bottom/right clipping. The three NT texture
slots are filled before any read, opened on a second D3D device on the same
adapter, read and reused for three cycles. Acceptance allows at most 2 LSB per
channel, accounting for float/half-float and final UNORM rounding.

The test uses **small staging texture CPU readback only to verify synthetic
pixels**. The product helper has no staging texture, full-frame readback or
pixel pipe. This test is not a capture FPS or end-to-end Electron result.

`handle-bridge-test.cjs` loads the real N-API bridge and spawns the dedicated
`handle-test-child.cpp`. It verifies argument and owner checks, explicit close,
GC finalization, repeated close after the same main handle number has been
reused for another event, compatibility duplication, child exit, and closed
session rejection. It also checks that session `cpuSeconds()` returns a finite,
nonnegative, nondecreasing cumulative kernel+user CPU time, permits a final
reading after child exit, and rejects readings after session close. The CPU
query is for occasional snapshots and is absent from the frame duplicate path.
No global arbitrary-handle close API is added to the bridge.

## Existing local evidence

The already completed synthetic GPU run passed 16 cases, 144 frames, 46,404
pixels and 185,616 channel comparisons. Actual maximum error was 1 LSB; area
identity and MASKED/MONO identity cases had zero error. The final statically
linked bridge passed the owned-child lifecycle test, including reuse and GC,
and the helper CPU self-test passed 42 checks. The original evidence remains
under `runtime/native-screen-capture/` (`synthetic-pipeline-test.ndjson` and
`handle-bridge-test-result.json`). Moving these sources into the repository
does not represent another GPU run. Real desktop capture, encoder references,
Electron import and foreground acceptance belong to the separate coordinated
product validation.
