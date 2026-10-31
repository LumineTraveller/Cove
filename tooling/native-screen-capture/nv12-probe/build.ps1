param([string]$Compiler = '', [string]$OutputDirectory = '', [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'runtime'))
if (-not $Compiler) {
  $installed = Get-Command 'g++.exe' -ErrorAction SilentlyContinue
  $Compiler = if ($installed) { $installed.Source } else { 'C:\Strawberry\c\bin\g++.exe' }
}
if (-not (Test-Path -LiteralPath $Compiler -PathType Leaf)) { throw 'Existing x64 MinGW compiler required; nothing is installed.' }
$target = & $Compiler '-dumpmachine'
if ($LASTEXITCODE -ne 0 -or $target -ne 'x86_64-w64-mingw32') { throw 'Existing x64 MinGW compiler required.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $runtimeRoot 'nv12-probe' }
$outputDirectoryPath = [IO.Path]::GetFullPath($OutputDirectory)
$prefix = $runtimeRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if (-not $outputDirectoryPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Probe outputs must stay inside repository runtime.' }
New-Item -ItemType Directory -Path $outputDirectoryPath -Force | Out-Null
$output = Join-Path $outputDirectoryPath 'helper.exe'
& $Compiler '-std=c++17' '-O2' '-Wall' '-Wextra' '-Werror' '-static' `
  (Join-Path $PSScriptRoot 'helper.cpp') '-o' $output '-ld3d11' '-ldxgi' '-lkernel32'
if ($LASTEXITCODE -ne 0) { throw "NV12 feasibility helper compilation failed: $LASTEXITCODE" }
if ($SelfTest) {
  & $output '--self-test'
  if ($LASTEXITCODE -ne 0) { throw "CPU-only pattern self-test failed: $LASTEXITCODE" }
}
Get-FileHash -LiteralPath $output -Algorithm SHA256
# Build only by default. The --self-test mode is CPU-only. Actual conversion
# requires a separately coordinated main-process owner and explicit GPU run.
