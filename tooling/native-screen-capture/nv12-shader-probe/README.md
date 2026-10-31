# Isolated NV12 pixel-shader probe

This is a separate 64x64 synthetic feasibility experiment. It does not modify
the BGRA capture provider or the failed VideoProcessorBlt experiment. It has no
desktop capture, encoder, network, installation or release action. A pass here
establishes only native shader output correctness on this device; it establishes
neither Electron interoperability nor 1080p120 throughput or CPU savings.

Build with the existing x64 MinGW toolchain:

```powershell
& .\tooling\native-screen-capture\nv12-shader-probe\build.ps1 -SelfTest
```

Compilation and `--self-test` do not create a D3D device or execute GPU work.
The self-test checks the CPU pattern/reference and compiles all three HLSL entry
points using the existing System32 `d3dcompiler_47.dll`; it installs nothing.
Binary output stays in `runtime/nv12-shader-probe/` by default. Alternate output
directories must stay inside this repository's `runtime/` directory.

## API boundary

The hardware device uses feature level 11_0 and requires the Windows 10+
`ID3D11Device3` interface. This does not require feature level 11_3. The output
is one DEFAULT NV12 64x64 texture, one mip, one array element, no MSAA, with
`RENDER_TARGET | SHADER_RESOURCE` and `SHARED_NTHANDLE | SHARED_KEYEDMUTEX`.
The exact descriptor and actual view creation decide support:

- `CreateRenderTargetView1`, `R8_UNORM`, `Texture2D.PlaneSlice = 0`;
- `CreateRenderTargetView1`, `R8G8_UNORM`, `Texture2D.PlaneSlice = 1`.

Y and UV are drawn in separate passes with 64x64 and 32x32 viewports. The input
is an independent BGRA SRV, so no plane is simultaneously read and written.
Format-support bits and Options4 `ExtendedNV12SharedTextureSupported` are
reported as capabilities; they do not substitute for exact creation/import
checks. Missing capabilities produce fixed failure codes without format or CPU
conversion fallback.

Microsoft explicitly documents NV12 RTV views, R8 Y, R8G8 UV and even geometry:
[DXGI_FORMAT](https://learn.microsoft.com/en-us/windows/win32/api/dxgiformat/ne-dxgiformat-dxgi_format).
Plane selection is defined by
[D3D11_TEX2D_RTV1](https://learn.microsoft.com/en-us/windows/win32/api/d3d11_3/ns-d3d11_3-d3d11_tex2d_rtv1),
and the Windows 10 minimum by
[CreateRenderTargetView1](https://learn.microsoft.com/en-us/windows/win32/api/d3d11_3/nf-d3d11_3-id3d11device3-createrendertargetview1).

## Explicit GPU execution

The caller must spawn the helper directly and pass its own actual PID. The
helper verifies the parent and holds only a SYNCHRONIZE process handle. These
are child-process argument arrays, not commands to run in an unrelated shell:

```text
--owner-pid <parent PID> --producer-only --sync-mode released-query
--owner-pid <parent PID> --producer-only --sync-mode held-query
```

Do not run either while capture measurements are active. `--producer-only`
creates no NT handle and exports nothing. Stages stop at the first failure.
One shader submission and a tiny test-only staging copy occur while the keyed
mutex is held; all RTV/SRV bindings are then cleared. In `released-query`, the
helper releases key 0 before End(EVENT)/Flush/GetData. No handle or consumer
exists at that point, so another device cannot acquire and overwrite the
resource. In `held-query`, the same completion query runs before release. These
are explicit controls, with no automatic retry or change of synchronization.
Both paths require query S_OK within three seconds before mapping the staging
texture, validating pixels or exporting a handle. Timeout diagnostics include
only numeric HRESULT / device-removed reason, never an adapter identifier.

The staging NV12 texture is exactly 64x64 (6144 meaningful bytes, plus row
padding). It exists only to compare every Y/UV byte to an independent CPU
reference, with maximum error one code value. It is not a capture path.
The pattern covers grayscale, flat color bars and a varying 2x2 checker block;
only sample counts and maximum errors are reported. Pixels are never logged.

## Color and Chromium alignment

For normalized gamma-encoded RGB, the matrix is Rec.709 limited:
`Yn=.2126R+.7152G+.0722B`, `Y=16+219Yn`,
`U=128+224(B-Yn)/(2(1-.0722))`,
`V=128+224(R-Yn)/(2(1-.2126))`.
Y uses an exact source pixel; UV averages the same 2x2 RGB block before applying
the matrix. The BGRA SRV is UNORM, not SRGB, so it does not linearize RGB.
The output is opaque, with no blending, scaling or cursor work in this probe.

Electron 44.0.0 pins Chromium 152.0.7977.54. The generator sink's RGB eager
conversion targets `gfx::ColorSpace::CreateREC709()` (BT709 primaries, transfer,
matrix, LIMITED). `CopySharedImageHelper` selects the destination YUV matrix;
`skia::BlitRGBAToYUVA` draws each plane with a linear sampler and source blend,
so exact half-size UV sampling averages 2x2 pixels. Chromium's BT709 rendering
transfer function deliberately maps to sRGB. This shader therefore applies the
matrix directly to the SDR sRGB code values. One-unit tolerance accounts for
UNORM quantization; this is not a claim of bitwise identity on every backend.

## Optional later Electron handoff

Only after a producer-only pass, the owner may separately schedule:

```text
--owner-pid <parent PID> --share --sync-mode held-query
```

After native GPU completion and pixel validation, this creates an unnamed,
non-inheritable NT handle and emits the independent protocol-2 `ready`/`frame`
messages. The `frame.handle` field is owner-only transport metadata and must
never be persisted in logs or diagnostic files. Use the existing N-API owner
to duplicate from the verified child; main imports synchronously and closes its
temporary duplicate in `finally`. Do not add Node access or weaken the sandbox.
Electron import must set `pixelFormat: 'nv12'` and explicitly set:

```js
colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited' }
```

The public v44 API accepts this metadata and propagates the SharedImage color
space to VideoFrame. Its default is sRGB, which is unsuitable for these planes.
See the locked
[import structure](https://github.com/electron/electron/blob/v44.0.0/docs/api/structures/shared-texture-import-texture-info.md)
and [implementation](https://github.com/electron/electron/blob/v44.0.0/shell/common/api/electron_api_shared_texture.cc).
The public import creates a non-mappable SharedImage VideoFrame, so later
WebRTC processing may still perform a synchronous readback. NV12 import does
not establish zero-copy encoding.

Send `imported 0 1` only after successful import/transfer, and `released 0 1`
only after every Electron reference is released. `stop` cancels without claiming
reference release. The owner-command deadline is 20 seconds; owner exit, EOF
and invalid/late commands stop safely. The texture is immutable and never reused.
This helper is never selected by the product capture controller.

## Recorded status

On 2026-10-28, the root owner scheduled both producer-only controls on the local
hardware. `released-query` reached submission/release but its event did not
complete within three seconds: `gpu_completion_timeout`, device-removed reason
S_OK (0), no handle created/exported. It failed feasibility. `held-query`
completed every stage, validated all 4096 Y and 2048 UV byte samples with maximum
error 0, and exited 0 with no exported handle. The successful control keeps the
mutex held through the complete GPU query, then releases it. This experiment
does not establish why the released control timed out, and does not justify
changing production synchronization.

The independent, real Electron interop run is explicitly scheduled with:

```powershell
node tooling/native-screen-capture/nv12-shader-probe/interop.cjs
node tooling/native-screen-capture/nv12-shader-probe/interop.cjs --cpu-frame
```

This entry point executes GPU work. It requires the existing Electron 44.0.0,
compiled product `dist-electron/preload.js`, shader helper and N-API handle
bridge. Optional `--helper PATH` stays inside the shader probe runtime directory;
`--addon PATH` selects an existing runtime/build handle bridge. The interop runner
always uses `held-query`. It creates an independent profile below
`runtime/nv12-shader-probe/interop-*`, a hidden window, denied permissions and
blocked network requests. It checks actual NV12 VideoFrame metadata, a few RGB
markers, a real generator write and settled track dimensions, and, when exposed,
one real processor frame. All imported/frame/track references are released before
the helper receives a release acknowledgement. No raw handle or pixel is saved.
Only sanitized phase/result JSON is persisted; Chromium/helper stderr is drained.

The default retains the direct imported NV12 frame as its control. The optional
`--cpu-frame` first uses the real imported frame's `allocationSize()` and
asynchronous `copyTo(ArrayBuffer, { format: 'NV12' })`, validates the returned two
plane layouts within a 16384-byte limit, and constructs a new CPU VideoFrame with
those layouts and the same BT709 limited metadata. It then performs the same
RGB-marker, generator and optional processor checks using that CPU frame.
The original GPU frame closes after the copy/construction, and cancellation
closes both GPU/CPU frames. No RGBA/Rec.601 fallback or codec change is involved.

Results report allocation/limit, actual CPU frame metadata, GPU-to-CPU copy wall
time, construction wall time, and `constructTransferDetached`. The constructor
tries `transfer: [buffer]`; only an actual zero byteLength is recorded as a
detachment. A rejected or ignored transfer option uses ordinary buffer copying
and is reported accordingly. This does not claim zero-copy capture or encoding.
The 350 ms promise timeout bounds the probe's wait; JavaScript cannot cancel
an underlying copy already submitted, so a late copied buffer is cleared after
retirement. This control tests explicit asynchronous readback instead of an
encoder's internal synchronous mapping; it is not presumed faster or accepted
as an end-to-end fix without further measurement.

Interop source preparation or JavaScript syntax checks are not an Electron pass.
Successful native color validation does not establish zero-copy, throughput,
encoding or CPU savings. Runtime records stay outside source control. Do not
rerun the failed VP probe as a side effect of this experiment.

## Owned HTTP ArrayBuffer / SharedArrayBuffer readback control

`readback.cjs` is an independent synthetic API experiment. It does not change
the product, its CSP, codec, capture controller or default isolation policy.
The runner creates a hidden window with the actual compiled sandboxed product
preload (`sandbox`, `contextIsolation`, `webSecurity` true; `nodeIntegration`
false), denies permissions and allows only its exact owned `127.0.0.1` URL.
The ephemeral local HTTP page sends `COOP: same-origin` and
`COEP: require-corp`; it must report actual `crossOriginIsolated === true` and
an available SAB constructor. No web-security or SharedArrayBuffer exception
switch is used. The local server is closed during cleanup.

CPU-only preparation (no D3D device, Electron or GPU execution):

```powershell
& .\tooling\native-screen-capture\nv12-shader-probe\build.ps1 -Readback -SelfTest
node --test --test-isolation=none tooling/native-screen-capture/nv12-shader-probe/readback.test.cjs
```

The independent native executable includes the existing shader helper's HLSL,
completion-query, checked-parent PID and owner-death primitives. It adds only a
fixed one/three-slot synthetic producer, even geometry, serial markers and
strict `imported slot serial` / `released slot serial` lease commands. The slots
are DEFAULT shared NT-handle/keyed-mutex textures. Each conversion/copy and GPU
completion query runs while its key is held. A slot is never overwritten until
the prior texture's actual `allReferencesReleased` callback, successful transfer,
main release and renderer permit have all occurred. `stop`, EOF, owner death,
invalid/stale ACK or a 20-second owner deadline retires the helper. This is not a
new desktop capture engine; it never reads the user's desktop.

The new `-Readback` build writes `readback-helper-hires.exe`; the readback runner
uses that filename by default. The prior `readback-helper.exe` (SHA256
`469771bef7959337a44348810509c76213bdfc2b63014bec8883be61f1f9b317`) is not
overwritten. Its executable, source, included immutable helper and original
build script are preserved under
`runtime/nv12-shader-probe/legacy-469771bef7959337/` with a hash manifest.
Use `--helper runtime/nv12-shader-probe/readback-helper.exe` for that old control.

Only the new stream uses its own reusable D3D EVENT query and private
`CreateWaitableTimerEx` high-resolution one-shot timer for 250 us polling.
It still calls `End`/`Flush`, requires real `GetData == S_OK` while the keyed
mutex is held, checks owner exit before the timer and after wake, and enforces
one absolute three-second QPC deadline. Missing high-resolution timer support
fails explicitly; there is no coarse-sleep fallback or global timer-resolution
change. The old immutable helper and interop CLI are unchanged.
CPU `--self-test` now also exercises the real timer and a simulated owner-event
exit/priority and expired deadline without creating D3D or executing GPU work.
Each new native frame reports anonymous GPU wait/query-poll/timer-wait and
source-issue timing values; the runner retains those numeric diagnostics.

The stream command reader also uses the same private 250 us timer, with an
absolute 20-second QPC deadline for each command. It checks owner exit before
the deadline and after each wake/read, accumulates fragmented commands, accepts
CRLF and a burst of newline-separated commands, and fails on EOF or oversized
input. `stop` retains its cancellation behavior. The inherited `command()` used
`Sleep(2)` and was still selected by the completion-only binary SHA256
`42d51895f877961e9265fc741ed373db1848a2846a665c14d0b18d1cd8b051fb`;
that binary cannot qualify the revised command wait. The new CPU self-test
uses anonymous pipes and a delayed second fragment to cover fragments, burst
commands, `stop`, idle/expired deadlines, owner priority and EOF without D3D.
The ready message reports both wait modes so result files identify this change.

After CPU validation, the owner may explicitly schedule this small GPU/API
qualification matrix. It is one reproducible CLI invocation:

```powershell
node tooling/native-screen-capture/nv12-shader-probe/readback.cjs --sizes 64 --formats nv12 --buffers ab,sab --inflight 1,3 --frames 6
```

Then use `--sizes 64,1728` (1728x1080), optionally `--sizes 1920`
(1920x1080). Defaults are 64x64 and 1728x1080, `--formats nv12,bgra`,
`--buffers ab,sab`, `--inflight 1,3`, `--frames 24` (maximum 250). The runner
stops the matrix after a failed cell. `--helper` selects an existing executable
inside this probe's runtime directory; `--addon` selects the existing verified
child-handle bridge. It installs nothing. Profiles/results stay below
`runtime/nv12-shader-probe/readback-*`; raw handles, desktop pixels, full pixel
buffers, helper stderr and Chromium stderr are never persisted. Fixed synthetic
palette scalar diagnostics are explicitly labeled in the result.

Both `allocationSize()` and timed GPU `copyTo(buffer)` omit `format`. Chromium
152's explicit non-RGB `format: 'NV12'` is unsupported, and even explicit RGB
formats enter a separate synchronous conversion branch. The native plane path
can try `CopyToAsync` only when the destination can pin SAB storage; AB is a
synchronous control. A returned Promise alone does not prove asynchronous GPU
work. NV12's background path uses one worker and synchronous plane reads; BGRA's
ARGB asynchronous client path can queue work, but the GPU service still performs
synchronous readback. Three JS promises do not prove concurrent GPU DMA. These
boundaries are from the locked
[VideoFrame implementation](https://chromium.googlesource.com/chromium/src/+/152.0.7977.54/third_party/blink/renderer/modules/webcodecs/video_frame.cc)
and [background readback implementation](https://chromium.googlesource.com/chromium/src/+/152.0.7977.54/third_party/blink/renderer/modules/webcodecs/background_readback.cc).

Every frame has a globally unique serial and eight independent 2x2 grayscale
bits, checked in the actual copied pixels along with the scaled original color,
gray and checker golden samples. NV12 uses BT709 limited metadata; BGRA uses
RGB/sRGB full metadata. The first frame of each matrix cell also constructs a
CPU VideoFrame from the returned native planes and checks RGB markers, transfer
detachment and close. SAB-to-AB construction copies are explicit and separately
timed. A renderer cleanup waits for the real pending copies; a timeout never
fakes a successful release ACK. No buffer is erased or reused before its actual
copy operation settles, including a rejected copy.

The CPU NV12-to-RGBA golden uses a separate pinned libyuv H709 integer reference,
not the original RGB source values. Chromium 152's
[DEPS](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.54/DEPS)
locks libyuv to `b56492e2dfc064f65ef27fed9c45d9bbfc2e2ad2`. Its
[row_common.cc](https://chromium.googlesource.com/libyuv/libyuv/+/b56492e2dfc064f65ef27fed9c45d9bbfc2e2ad2/source/row_common.cc)
H709 defaults are `UB=128, UG=14, VG=34, VR=115, YG=18997, YB=-1160`.
The x86 C reference forms `Y*257`, takes the integer high 16 bits after `*YG`,
adds `YB`, applies centered U/V integer coefficients, then arithmetic-shifts by
six and clamps. These approximations predict RGB `[255,1,3]`, `[0,255,11]` and
`[1,0,243]` for the shader's red, green and blue NV12 samples. A rational BT709
inverse differs even when every raw YUV byte is correct.
The raw Gitiles base64-decoded source bytes (LF) have SHA256
`6fdd463fd0d944e29df7f439b92376ab143e168e4a328d13758495a895f05cfd`.
The separately labeled local Windows CRLF snapshot hashes to
`59da5636043ccfa4a77324d95f75b7ca6e8fb52ad3a3579fe9ae0c986cba55e7`;
these hashes describe different byte sequences, not different equations.

`readback-color-oracle.cjs` predicts YUV independently from the owned synthetic
pattern, then applies this pinned decoder reference. The original-source RGB
comparison and its unchanged tolerance four are still reported, including its
failure. The corrected H709 comparison also retains tolerance four; the raw
NV12 tolerance remains one. Fixed palette RGB/YUV scalar samples are safe to
report here because this helper never captures user pixels. CPU tests anchor
literal integer vectors and reject BT601, a rational-709 substitute and a
five-code-value corruption. Both comparisons remain diagnostic evidence.

The first actual matrix attempt, `readback-BOcEUC`, is preserved unchanged. Its
64x64 AB/NV12 native-plane copy and sequence passed, but the old original-RGB
CPU golden failed before SAB or further cells ran; cleanup passed. That failure
does not establish an NV12 shader or SAB API failure. The fixture correction is
CPU-validated separately and still requires a new owner-scheduled GPU run.
`BOcEUC` did not preserve the actual CPU RGB scalar samples, so it cannot prove
that run's per-channel residuals. The 3/11/12 blue residuals are predictions of
the pinned integer reference and match the earlier `interop-DA8gh1` evidence.

Results include binary/source/preload/addon hashes and actual Electron/Chrome
versions. Per frame they record allocation wall, synchronous `copyTo` call wall,
Promise settle wall, post-call wait and validation wall. Summary reports actual
completed copies and observed unsettled JS promises/callbacks separately from
native leases. Completion throughput includes synthetic production/query,
IPC/import/release, allocation, validation and one CPU golden construction in
the inter-frame cadence. It is a unique synthetic sequence experiment, **not a
desktop capture, encoder or Cove 1080p120 result**, and not zero-copy evidence.

Source preparation, the CPU contract suite and native HLSL self-test do not
establish GPU readback correctness or performance. The new HTTP/SAB matrix has
not been executed merely because the build or tests pass; the owner schedules
actual GPU runs serially with other measurements.

### Actual high-resolution-wait matrix, 2026-10-28

`readback-p4qtSE` passed all four 64x64 NV12 AB/SAB and one/three-inflight
cells. `readback-K0b6pU` subsequently passed all sixteen 1728x1080 and
1920x1080 NV12/BGRA AB/SAB cells, with 24 distinct synthetic frames per cell.
Both used frozen helper SHA256
`2f1b5e4dd6c76632b58bfcb84a97162399d435e85ba16fd89975f69dad522e24`.
All source references, imports, transfers and owned processes drained in every
cell. Raw NV12 and sequence checks passed; CPU RGB checks matched the pinned
H709 integer oracle. The original RGB-source comparison still reports its
unchanged failure rather than silently broadening its tolerance.

These small throughput windows are diagnostic, not steady Cove measurements.
At 1728x1080, NV12 AB `copyTo` occupied about 37 ms per call. SAB reduced the
synchronous call to about 0.04 ms, but completion still took about 38 ms with
one inflight frame and 80 ms with three. At 1920x1080 the corresponding NV12
completion times were about 41 and 89 ms. SAB moved the wait off the caller;
it did not create a 120 fps readback path. BGRA three-inflight synthetic
completion rates were about 98--104 fps across these cells, also short of the
target. All recorded timings include the documented fixture work and are not
encoder, desktop or network results.

The high-resolution helper fixed a fixture limit, not product frame pacing.
Do not use the old coarse-sleep helper's approximately 64 fps input as a Canvas
or Chromium output limit. The separate Canvas route probe qualifies a different
handoff and must retain its own input/output/ownership evidence.
