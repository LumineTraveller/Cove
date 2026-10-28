# Synthetic CPU NV12 color contract

These programs use eight fixed synthetic colors. They never capture a display.
The helper and its production shader are unchanged by the diagnostic/oracle work.
Both matrices are checked at identity and 2x downscale.

`cpu-test.cpp` checks independent integer/rational color references against fixed
flat-color golden values. It also rejects wrong-matrix values and tests the exact
0.6 boundary, including rejection of 0.99 code-value error.

`gpu-test.cpp` remains the original strict nearest-byte test. Its first run's
BT601 green Y=144 versus mathematical nearest 145 failure is preserved in
`runtime/native-throughput-20261028-cpu-color/gpu-color-validation.log` and the
original executable/source snapshot. Do not reinterpret that old result as a pass.

`gpu-diagnostic.cpp` records all colors before returning the strict result. For
each channel it reports the exact rational reference, nearest integer golden,
NV12 byte range/error, production BGRA scratch, and the same production shader
rendered to a FLOAT target. Independent R8/RG8 targets distinguish generic UNORM
quantization from NV12 plane behavior. Output contains only the fixed synthetic
input values and their derived results. Its nonzero strict exit can coexist with
`standardOraclePassed:true`.

`gpu-standard-test.cpp` uses the same observations and accepts a case only when:

- The BGRA scratch exactly equals the supplied colors, including 255 alpha.
- FLOAT shader code values differ from the independent rational reference by at
  most 0.001 code value.
- Every NV12 byte differs from the unrounded rational reference by at most 0.6
  code value, evaluated by exact integer cross multiplication.

The last boundary follows [Direct3D 11.3 Functional Specification §3.2.3.6,
FLOAT to UNORM](https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm#FLOATCONVERSION).
The specification permits 0.6 ULP on the integer side. Thus 144 can represent
144.553, while a blanket nearest-integer tolerance of one would wrongly admit
errors as large as 1.499. This boundary does not absorb a wrong 601/709 matrix;
the CPU negative controls explicitly reject each colored patch under the other
matrix. No receiver RGBA threshold is changed.

Run either GPU executable only in an explicitly scheduled GPU validation window:

```powershell
.\runtime\native-throughput-20261028-cpu-color\color-contract-gpu-diagnostic.exe --color-space both
.\runtime\native-throughput-20261028-cpu-color\color-contract-gpu-standard.exe --color-space both
```

Compilation uses the existing MinGW compiler, C++17, `-O2 -Wall -Wextra -Werror
-static`, and the same D3D/Windows libraries as the helper. Compiling does not run
the GPU entry point.
