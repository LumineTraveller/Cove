param(
  [string]$Compiler = '',
  [string]$Node = 'node',
  [string]$OutputDirectory = '',
  [ValidateSet('bgra', 'nv12', 'both', 'cpu-nv12')][string]$PixelFormat = 'bgra',
  [switch]$SkipGpu,
  [switch]$BuildOnly
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'runtime'))
if (-not $Compiler) {
  $installed = Get-Command 'g++.exe' -ErrorAction SilentlyContinue
  $Compiler = if ($installed) { $installed.Source } else { 'C:\Strawberry\c\bin\g++.exe' }
}
if (-not (Test-Path -LiteralPath $Compiler -PathType Leaf)) {
  throw 'Existing x64 MinGW compiler required. This tool installs or downloads nothing.'
}
if (-not $OutputDirectory) {
  $runName = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
  $OutputDirectory = Join-Path $runtimeRoot (Join-Path 'native-screen-capture-validation' $runName)
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
$runtimePrefix = $runtimeRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if (-not $output.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputDirectory must be a fresh directory inside this repository runtime directory.'
}
if (Test-Path -LiteralPath $output) { throw 'OutputDirectory already exists; use a fresh isolated directory.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
$helper = Join-Path $output 'helper.exe'
$addon = Join-Path $output 'native-screen-handles.node'
$ownedChild = Join-Path $output 'handle-test-child.exe'
$synthetic = Join-Path $output 'synthetic-pipeline-test.exe'
$builder = Join-Path $repoRoot 'apps/desktop/electron/build-native-screen-capture.cjs'

# The product builder discovers only already cached N-API headers. Its outputs
# are explicitly redirected here; no formal build/runtime directory is changed.
$previousCompiler = $env:COVE_NATIVE_CAPTURE_CXX
try {
  $env:COVE_NATIVE_CAPTURE_CXX = $Compiler
  & $Node $builder '--output' $helper '--handles-output' $addon '--self-test'
  if ($LASTEXITCODE -ne 0) { throw "Native helper/addon build failed: $LASTEXITCODE" }
} finally {
  if ($null -eq $previousCompiler) { Remove-Item Env:COVE_NATIVE_CAPTURE_CXX -ErrorAction SilentlyContinue }
  else { $env:COVE_NATIVE_CAPTURE_CXX = $previousCompiler }
}
& $Compiler '-std=c++17' '-O2' '-Wall' '-Wextra' '-Werror' '-static' `
  (Join-Path $PSScriptRoot 'handle-test-child.cpp') '-o' $ownedChild '-lkernel32'
if ($LASTEXITCODE -ne 0) { throw "Owned event child build failed: $LASTEXITCODE" }
if (-not $SkipGpu) {
  & $Compiler '-std=c++17' '-O2' '-Wall' '-Wextra' '-Werror' '-static' `
    (Join-Path $PSScriptRoot 'synthetic-pipeline-test.cpp') '-o' $synthetic `
    '-ld3d11' '-ld3dcompiler' '-ldxgi' '-lkernel32' '-luser32' '-lgdi32'
  if ($LASTEXITCODE -ne 0) { throw "Synthetic GPU test build failed: $LASTEXITCODE" }
}
if (-not $BuildOnly) {
  & $Node '--expose-gc' (Join-Path $PSScriptRoot 'handle-bridge-test.cjs') '--addon' $addon '--child' $ownedChild |
    Tee-Object -FilePath (Join-Path $output 'handle-result.ndjson')
  if ($LASTEXITCODE -ne 0) { throw "Native handle lifecycle test failed: $LASTEXITCODE" }
  if (-not $SkipGpu) {
    # Synthetic texture inputs only. This executable never calls desktop APIs.
    & $synthetic '--pixel-format' $PixelFormat | Tee-Object -FilePath (Join-Path $output 'synthetic-result.ndjson')
    if ($LASTEXITCODE -ne 0) { throw "Synthetic GPU reference test failed: $LASTEXITCODE" }
  }
}
$files = @($helper, $addon, $ownedChild)
if (-not $SkipGpu) { $files += $synthetic }
$hashes = @($files | ForEach-Object {
  [ordered]@{ file = [IO.Path]::GetFileName($_); sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$manifest = [ordered]@{
  schemaVersion = 1
  desktopCapture = $false
  buildOnly = [bool]$BuildOnly
  syntheticGpu = -not [bool]$SkipGpu
  syntheticPixelFormat = if ($SkipGpu) { $null } else { $PixelFormat }
  outputDirectory = $output.Substring($runtimePrefix.Length).Replace('\', '/')
  binaries = $hashes
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'manifest.json') -Encoding UTF8
Write-Output ('Validation output: runtime/' + $manifest.outputDirectory)
