param(
    [switch]$Check,
    [switch]$ServerOnly,
    [switch]$ClientOnly,
    [ValidateRange(1024, 65535)][int]$HttpPort = 3313,
    [ValidateRange(1024, 65535)][int]$MediaPort = 41020,
    [ValidateRange(1024, 65535)][int]$RendererPort = 55193
)
$ErrorActionPreference = 'Stop'
if ($ServerOnly -and $ClientOnly) { throw 'Choose ServerOnly or ClientOnly, not both.' }
if (@($HttpPort, $MediaPort, $RendererPort | Select-Object -Unique).Count -ne 3) { throw 'Test ports must be distinct.' }
$coveTestRoot = Split-Path -Parent $PSScriptRoot
$coveTestNode = (Get-Command node -ErrorAction Stop).Source
$coveTestRuntime = Join-Path $coveTestRoot 'runtime'
$coveTestPlan = [ordered]@{
    root = $coveTestRoot
    node = $coveTestNode
    server = "http://127.0.0.1:$HttpPort"
    mediaPort = $MediaPort
    renderer = "http://127.0.0.1:$RendererPort"
    serverData = Join-Path $coveTestRuntime 'acceptance-server'
    desktopData = Join-Path $coveTestRuntime 'acceptance-desktop'
    downloads = Join-Path $coveTestRuntime 'acceptance-downloads'
    viteCache = Join-Path $coveTestRuntime 'acceptance-vite-cache'
    installsSoftware = $false
}
foreach ($coveTestDependency in @('node_modules/typescript/bin/tsc', 'node_modules/tsx/package.json', 'packages/client-core/dist/index.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $coveTestRoot $coveTestDependency))) {
        throw "Missing existing build dependency: $coveTestDependency. Build shared packages first; this launcher never installs dependencies."
    }
}
if ($Check) { $coveTestPlan | ConvertTo-Json; return }

$coveTestEnvironment = @{
    COVE_DATA_DIR = $coveTestPlan.serverData
    COVE_DOWNLOAD_DIR = $coveTestPlan.downloads
    COVE_DESKTOP_DATA_DIR = $coveTestPlan.desktopData
    COVE_SERVER_SECURITY_ENABLED = 'true'
    COVE_BOOTSTRAP_TOKEN = $null
    COVE_BOOTSTRAP_TOKEN_FILE = $null
    COVE_HTTP_PORT = [string]$HttpPort
    MEDIASOUP_PORT = [string]$MediaPort
    MEDIASOUP_IP = '127.0.0.1'
    COVE_DEV_RENDERER_PORT = [string]$RendererPort
    COVE_DEV_RENDERER_URL = $coveTestPlan.renderer
    COVE_VITE_CACHE_DIR = $coveTestPlan.viteCache
    VITE_SERVER_URL = $coveTestPlan.server
    VITE_COVE_DEFAULT_SERVER = $coveTestPlan.server
}
$coveTestSavedEnvironment = @{}
Push-Location -LiteralPath $coveTestRoot
try {
    foreach ($coveTestName in $coveTestEnvironment.Keys) {
        $coveTestSavedEnvironment[$coveTestName] = [Environment]::GetEnvironmentVariable($coveTestName, 'Process')
        [Environment]::SetEnvironmentVariable($coveTestName, $coveTestEnvironment[$coveTestName], 'Process')
    }
    $coveTestPlan | ConvertTo-Json | Write-Host
    $coveTestArguments = @('tooling/dev.cjs')
    if ($ServerOnly) { $coveTestArguments += '--server' }
    elseif ($ClientOnly) { $coveTestArguments += @('--client', '--electron') }
    else { $coveTestArguments += '--electron' }
    & $coveTestNode @coveTestArguments
    if ($LASTEXITCODE -ne 0) { throw "Local test launcher exited $LASTEXITCODE" }
} finally {
    foreach ($coveTestName in $coveTestSavedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($coveTestName, $coveTestSavedEnvironment[$coveTestName], 'Process')
    }
    Pop-Location
}
