param([string]$Compiler = 'C:\Strawberry\c\bin\g++.exe')
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimeRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'runtime'))
$outputDirectory = [System.IO.Path]::GetFullPath((Join-Path $runtimeRoot 'cpu-frame-socket-probe'))
$source = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'pacer.cpp'))
$output = [System.IO.Path]::GetFullPath((Join-Path $outputDirectory 'pacer.exe'))
if (-not $outputDirectory.StartsWith($runtimeRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or
    [System.IO.Path]::GetDirectoryName($output) -ne $outputDirectory -or [System.IO.Path]::GetFileName($output) -ne 'pacer.exe') {
  throw 'Pacer output must remain inside this probe runtime directory.'
}
if (-not (Test-Path -LiteralPath $Compiler -PathType Leaf)) { throw 'Existing C++ compiler unavailable; no installation is performed.' }
$target = & $Compiler -dumpmachine
if ($LASTEXITCODE -ne 0 -or $target -ne 'x86_64-w64-mingw32') { throw 'Existing compiler must target x86_64-w64-mingw32.' }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
& $Compiler '-std=c++17' '-O2' '-Wall' '-Wextra' '-Werror' '-static' $source '-o' $output
if ($LASTEXITCODE -ne 0) { throw 'High-resolution pacer compilation failed.' }
[pscustomobject]@{
  executable = $output
  bytes = (Get-Item -LiteralPath $output).Length
  sourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  binarySha256 = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
} | ConvertTo-Json
# Build only: this script does not execute the pacer, Electron, or GPU work.
