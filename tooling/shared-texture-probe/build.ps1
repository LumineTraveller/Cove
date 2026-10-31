param([string]$Compiler = 'C:\Strawberry\c\bin\g++.exe')
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$outputDirectory = Join-Path $repoRoot 'runtime\shared-texture-probe'
if (-not (Test-Path -LiteralPath $Compiler -PathType Leaf)) { throw "Existing compiler not found: $Compiler. No installation is performed." }
$target = & $Compiler -dumpmachine
if ($LASTEXITCODE -ne 0 -or $target -ne 'x86_64-w64-mingw32') { throw "Expected existing x64 MinGW compiler, got $target" }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$output = Join-Path $outputDirectory 'helper.exe'
& $Compiler '-std=c++17' '-O2' '-Wall' '-Wextra' '-Werror' '-static' (Join-Path $PSScriptRoot 'helper.cpp') '-o' $output '-ld3d11' '-ldxgi' '-lkernel32'
if ($LASTEXITCODE -ne 0) { throw "Compilation failed: $LASTEXITCODE" }
Get-Item -LiteralPath $output | Select-Object FullName,Length
Get-FileHash -LiteralPath $output -Algorithm SHA256
# Compilation only. Running this executable or run.cjs starts a GPU experiment.
