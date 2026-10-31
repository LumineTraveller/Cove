# Isolated NV12 shared-texture feasibility probe

This is a one-frame synthetic API experiment. It does not change the validated
BGRA provider, capture a desktop, encode video, use a server or install software.
It cannot establish product FPS or total CPU savings.

Build with the existing compiler; compilation does not execute GPU work:

```powershell
& .\tooling\native-screen-capture\nv12-probe\build.ps1 -SelfTest
```

The output is `runtime/nv12-probe/helper.exe`. `-Compiler PATH` selects an
existing x64 MinGW compiler and `-OutputDirectory PATH` must stay under this
repository's runtime directory. `-SelfTest` only checks the CPU pattern. The
actual GPU run must be separately coordinated with the Electron owner; do not
run it during another capture benchmark.

For a coordinated capability-only run, using the existing handle bridge:

```powershell
node tooling/native-screen-capture/nv12-probe/capability.cjs
```

Optional `--helper PATH` and `--addon PATH` select existing isolated binaries.
This runner starts its own helper, duplicates and closes the immutable NT handle
using the N-API owner, then cancels before Electron import. It reports capability
and VP color state only, explicitly leaving RGB pixel validation and writer
timing unverified. It never fabricates import/reference-release acknowledgements.

## GPU path and supported configuration

The helper creates only a 64x64 opaque synthetic BGRA texture. A hardware
feature-level-11 device and `ID3D11VideoContext1` are required. Its video
processor enumerator must explicitly support BGRA input, NV12 output and this
exact color conversion:

- input `DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709`;
- output `DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709`.

The NV12 output uses DEFAULT storage, one array element, one mip, no MSAA,
`RENDER_TARGET | SHADER_RESOURCE`, and `SHARED_NTHANDLE | SHARED_KEYEDMUTEX`.
It uses a video-processor output view rather than a 3D NV12 render-target view.
Auto processing is disabled, the source/destination rectangles are exactly
64x64, shader usage is declared when that hint is supported, and the selected color spaces are read back
from the VP state. An event query must complete before key 0 is released and
the immutable texture is handed off. Unsupported calls produce fixed stage
codes and exit 2; there is no alternative format or CPU conversion fallback.

Options4 `ExtendedNV12SharedTextureSupported` is recorded as a diagnostic,
without treating false as proof that this exact basic RT/SRV sharing descriptor
cannot work. Actual CreateTexture/CreateSharedHandle and subsequent Electron
cross-process import decide support for this descriptor.
Likewise a missing `SHADER_USAGE` hint capability is recorded, without rejecting
the texture before testing its exact RT/SRV descriptor and VP calls. The helper
omits that optional hint when unsupported; it does not substitute color spaces.

Microsoft API references:

- [Video processor output resource restrictions](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11videodevice-createvideoprocessoroutputview)
- [Blt and event-query feature-level restriction](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11videocontext-videoprocessorblt)
- [Explicit output shader usage](https://learn.microsoft.com/en-us/windows/win32/api/d3d11_1/nf-d3d11_1-id3d11videocontext1-videoprocessorsetoutputshaderusage)

## Independent protocol

Spawn the helper with `--owner-pid <actual parent PID>`. It checks that parent
and keeps only a SYNCHRONIZE handle. It emits one ready object and one frame:

```json
{"type":"ready","probe":"nv12-video-processor","protocol":2,"width":64,"height":64,"sourceWidth":64,"sourceHeight":64,"poolSize":1,"pixelFormat":"nv12","pattern":"quadrants-gray-color-bars-v1","colorSpace":{"primaries":"bt709","transfer":"bt709","matrix":"bt709","range":"limited"},"options4Known":true,"extendedNv12Shared":true}
{"type":"frame","probe":"nv12-video-processor","slot":0,"serial":1,"handle":"0x...","timestamp":1000,"width":64,"height":64,"pixelFormat":"nv12","refresh":false,"producerGpuComplete":true}
```

The handle belongs to the helper's table. Use the existing main-process N-API
bridge's `openChild(helper.pid).duplicate(buffer8)` and synchronously import
the returned owned handle in Electron, closing that main temporary in `finally`.
Electron import must explicitly use `pixelFormat: 'nv12'` and the BT709 limited
color-space metadata above. Then send `imported 0 1`. Only after all Electron
references and frames are released, send `released 0 1`; the helper reports done
and exits 0. `stop` cancels without claiming all references were released. There
is one overall 20-second command deadline. EOF/owner exit/error release native
resources, and the helper never creates an unknown handle in the main table.

This protocol is intentionally separate from the product controller and its
three-slot BGRA protocol. Do not select this helper as a product capture helper.

## Synthetic reference and acceptance

All coordinates below are source pixels, all alpha values are 255. Untouched
quadrants are red top-left, green top-right, blue bottom-left, white bottom-right.
Sample corner centers at `(8,8), (56,8), (8,56), (56,56)`.

Rows 24 through 39 contain eight grayscale bars of width 8, with values
`0,32,64,96,128,160,192,255`. Sample each at `(8*i+4,32)`.
Rows 44 through 51 contain width-8 color bars, RGB order red, green, blue, white,
black, cyan, magenta, yellow. Sample each at `(8*i+4,48)`. All edges align to
2x2 chroma blocks. Compare flat interiors separately from chroma edges, where
4:2:0 sampling is inherently different from BGRA.

The expected limited BT709 equations for normalized gamma-encoded RGB are
`Y=16+219*(.2126R+.7152G+.0722B)`,
`Cb=128+224*(B-Yn)/(2*(1-.0722))` and
`Cr=128+224*(R-Yn)/(2*(1-.2126))`, with `Yn=.2126R+.7152G+.0722B`.
The renderer-side probe must validate imported format/dimensions/color metadata,
copy only this synthetic frame to RGB for color checks, and measure
`generator.write` wall time independently. There is no C++ staging readback.
A faster write of this tiny immutable texture does not establish faster
encoding, because downstream software paths may still read NV12 planes back.

Source preparation alone is not a GPU/import/color or performance pass. Keep
runtime results and failures separately; do not relabel unsupported capability
or failed color conversion as a successful NV12 path.

## Observed local stop point

The helper compiled with warnings as errors and its CPU pattern self-test passed.
The initial run stopped at an extra shader-usage-hint gate. After one documented
interface correction to omit that unsupported optional hint, the run passed the
format/color capability checks, exact shared NV12 texture creation, VP views,
color state checks, keyed acquisition and Blt submission. Its GPU completion
event did not finish within 3 seconds, producing `gpu_completion_timeout`.
The probe then stopped; it did not export an NT handle, perform Electron import,
validate output RGB pixels or measure generator writes. Submission is not GPU
completion. This is a failed feasibility experiment, not a supported NV12
provider or evidence of throughput/CPU improvement. The validated product BGRA
path is unchanged. The two local failure records remain under
`runtime/nv12-probe/`, outside source control.
