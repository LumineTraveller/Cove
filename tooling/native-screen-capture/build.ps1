param([string]$Compiler = 'C:\Strawberry\c\bin\g++.exe')
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$outputDirectory = Join-Path $repoRoot 'runtime\native-screen-capture'
if (-not (Test-Path -LiteralPath $Compiler -PathType Leaf)) { throw "Existing compiler not found: $Compiler. No installation is performed." }
$target = & $Compiler -dumpmachine
if ($LASTEXITCODE -ne 0 -or $target -ne 'x86_64-w64-mingw32') { throw "Expected an existing x64 MinGW compiler, got: $target" }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$source = Join-Path $PSScriptRoot 'dxgi-microprofiler.cpp'
$output = Join-Path $outputDirectory 'dxgi-microprofiler-gpu-scale.exe'
& $Compiler '-std=c++17' '-O2' '-Wall' '-Wextra' '-Werror' '-static' $source '-o' $output '-ld3d11' '-ld3dcompiler' '-ldxgi' '-lole32' '-luser32'
if ($LASTEXITCODE -ne 0) { throw "Native profiler compilation failed with exit code $LASTEXITCODE" }
Get-Item -LiteralPath $output | Select-Object FullName, Length
Get-FileHash -LiteralPath $output -Algorithm SHA256
# Compilation only. GPU self-test and desktop capture require separate scheduling.
