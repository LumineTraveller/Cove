# Pure fixture checks: parse the publisher and evaluate only its asset-selection,
# command-string construction and mocked HEAD blocks. Never run the publisher,
# HTTP helper, SSH, SCP, downloads, installation or cleanup commands.
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$publisher = Join-Path $repository 'scripts/publish-release-to-cloud.ps1'
$source = [IO.File]::ReadAllText($publisher)
$tokens = $null
$parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($publisher, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw "Publisher PowerShell parse errors: $($parseErrors -join '; ')" }

function Assert-Fixture([bool]$condition, [string]$message) {
    if (-not $condition) { throw $message }
}
function Read-FixtureBlock([string]$start, [string]$end, [bool]$lastStart = $false) {
    $startIndex = if ($lastStart) { $source.LastIndexOf($start, [StringComparison]::Ordinal) } else { $source.IndexOf($start, [StringComparison]::Ordinal) }
    Assert-Fixture ($startIndex -ge 0) "Fixture block start missing: $start"
    $endIndex = $source.IndexOf($end, $startIndex + $start.Length, [StringComparison]::Ordinal)
    Assert-Fixture ($endIndex -gt $startIndex) "Fixture block end missing: $end"
    return [scriptblock]::Create($source.Substring($startIndex, $endIndex - $startIndex))
}

$selectionBlock = Read-FixtureBlock '$assetsByName = @{}' '$assetHashes = @{}'
$remoteBlock = Read-FixtureBlock '    $remoteCommands = @(' "    Invoke-Checked 'ssh'"
$headBlock = Read-FixtureBlock '    foreach ($asset in $selectedAssets)' '    Write-Output ' $true
$version = '9.8.7'
$required = @('latest.yml', "Cove-Setup-$version.exe", "Cove-Setup-$version.exe.blockmap",
    "Cove-Server-Setup-$version.exe", "Cove-Server-Setup-$version.exe.blockmap")
$integrityName = "Cove-Integrity-$version-win32-x64.json"

function Select-Fixture([string[]]$names) {
    $release = [pscustomobject]@{ assets = @($names | ForEach-Object { [pscustomobject]@{ name = $_; size = 123 } }) }
    $expectedNames = @($required)
    $integrityManifestName = $integrityName
    . $selectionBlock
    return ,@($selectedAssets)
}

$cases = @(
    @{ name = 'historical five assets'; names = $required; count = 5; integrity = $false },
    @{ name = 'new six assets'; names = ($required + $integrityName); count = 6; integrity = $true },
    @{ name = 'another architecture ignored'; names = ($required + "Cove-Integrity-$version-win32-arm64.json"); count = 5; integrity = $false },
    @{ name = 'wrong manifest case ignored'; names = ($required + $integrityName.ToLowerInvariant()); count = 5; integrity = $false }
)
foreach ($case in $cases) {
    $selected = Select-Fixture $case.names
    Assert-Fixture ($selected.Count -eq $case.count) "$($case.name): wrong selected asset count"
    Assert-Fixture ((@($selected.name | Where-Object { $_ -ceq $integrityName }).Count -eq 1) -eq $case.integrity) "$($case.name): wrong optional manifest selection"
    foreach ($mandatory in $required) {
        Assert-Fixture (@($selected.name | Where-Object { $_ -ceq $mandatory }).Count -eq 1) "$($case.name): missing mandatory asset $mandatory"
    }

    $commands = & {
        param($selectedAssets)
        $staging = '/tmp/cove-fixture'
        $RemoteRoot = '/fixture'
        $releaseDir = '/fixture/releases/v9.8.7'
        . $remoteBlock
        return $remoteCommands -join "`n"
    } $selected
    foreach ($asset in $selected) {
        Assert-Fixture ($commands.Contains("sudo install -m 0644 '/tmp/cove-fixture/$($asset.name)' '/fixture/releases/v9.8.7/$($asset.name)'")) "$($case.name): selected asset has no remote install command"
    }
    Assert-Fixture ($commands.Contains($integrityName) -eq $case.integrity) "$($case.name): wrong optional manifest in remote command strings"

    $heads = @(& {
        param($selectedAssets)
        $publicBase = 'https://fixture.invalid'
        $Tag = 'v9.8.7'
        function Assert-PublicHead([string]$url, [string]$expectedSize = '') {
            [pscustomobject]@{ url = $url; size = $expectedSize }
        }
        . $headBlock
    } $selected)
    Assert-Fixture ($heads.Count -eq $case.count) "$($case.name): selected assets do not all get HEAD verification"
    foreach ($asset in $selected) {
        $url = "https://fixture.invalid/releases/v9.8.7/$($asset.name)?check=v9.8.7"
        Assert-Fixture (@($heads | Where-Object { $_.url -ceq $url -and $_.size -eq '123' }).Count -eq 1) "$($case.name): wrong asset HEAD URL or size"
    }
    Write-Output "PASS: $($case.name)"
}

$rejectedMissing = $false
try { $null = Select-Fixture @($required | Where-Object { $_ -ne 'latest.yml' }) } catch { $rejectedMissing = $true }
Assert-Fixture $rejectedMissing 'Missing mandatory historical asset was accepted'
$rejectedDuplicate = $false
try { $null = Select-Fixture ($required + $integrityName + $integrityName) } catch { $rejectedDuplicate = $true }
Assert-Fixture $rejectedDuplicate 'Duplicate manifest asset was accepted'
Write-Output 'PASS: missing mandatory and duplicate assets rejected'
Write-Output 'PASS: PowerShell AST parses; no publisher/network/SSH/SCP commands executed'
