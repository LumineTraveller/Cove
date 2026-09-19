<#
.SYNOPSIS
    把 GitHub Release 的 Windows 更新文件发布到 Cove 云服务器静态下载源。

.EXAMPLE
    .\scripts\publish-release-to-cloud.ps1 -Tag v1.3.0 -PublicBaseUrl https://your-server.example.com

    服务器需要能通过 ssh 别名 cove-cloud 连接，并允许当前用户写入
    /var/www/cove-download。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^v\d+\.\d+\.\d+$')]
    [string]$Tag,
    [string]$GitHubRepo = 'LumineTraveller/Cove',
    [ValidatePattern('^[A-Za-z0-9._@:-]+$')]
    [string]$SshTarget = 'cove-cloud',
    [ValidatePattern('^/[A-Za-z0-9._/-]+$')]
    [string]$RemoteRoot = '/var/www/cove-download',
    [Parameter(Mandatory = $true)]
    [uri]$PublicBaseUrl
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ($RemoteRoot -eq '/') { throw '拒绝使用根目录作为下载站目录。' }
if ($PublicBaseUrl.Scheme -ne 'https' -or -not $PublicBaseUrl.Host -or $PublicBaseUrl.UserInfo) {
    throw 'PublicBaseUrl 必须是没有账号信息的 HTTPS 服务器地址。'
}
$publicBase = $PublicBaseUrl.AbsoluteUri.TrimEnd('/')
$version = $Tag.Substring(1)
$expectedNames = @(
    'latest.yml',
    "Cove-Setup-$version.exe",
    "Cove-Setup-$version.exe.blockmap",
    "Cove-Server-Setup-$version.exe",
    "Cove-Server-Setup-$version.exe.blockmap"
)

function Invoke-Checked([string]$command, [string[]]$arguments) {
    & $command @arguments
    if ($LASTEXITCODE -ne 0) { throw "$command 执行失败（退出码 $LASTEXITCODE）。" }
}

function Get-GithubRelease([string]$repo, [string]$tag) {
    $uri = "https://api.github.com/repos/$repo/releases/tags/$tag"
    try {
        return Invoke-RestMethod -Uri $uri -Headers @{ 'User-Agent' = 'cove-cloud-publisher' } -UseBasicParsing
    } catch {
        throw "GitHub 上找不到 $repo 的 $tag Release（$($_.Exception.Message)）"
    }
}

$release = Get-GithubRelease $GitHubRepo $Tag
if ($release.draft -or $release.prerelease) {
    throw "GitHub Release $Tag 仍是草稿或预发布版本，不能发布到正式下载源。"
}

$assetsByName = @{}
foreach ($asset in @($release.assets)) { $assetsByName[$asset.name] = $asset }
$selectedAssets = @()
foreach ($name in $expectedNames) {
    if (-not $assetsByName.ContainsKey($name)) { throw "GitHub Release 缺少附件：$name" }
    $selectedAssets += $assetsByName[$name]
}

Write-Output "GitHub Release：$($release.name)（$Tag）"
$selectedAssets | ForEach-Object { "  {0}  {1:N1} MB" -f $_.name, ($_.size / 1MB) }

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "cove-cloud-publish-$version"
$staging = "/tmp/cove-cloud-publish-$version-$([guid]::NewGuid().ToString('N'))"
$completed = $false
try {
    if (-not (Test-Path -LiteralPath $tempDir)) {
        New-Item -ItemType Directory -Path $tempDir | Out-Null
    }

    foreach ($asset in $selectedAssets) {
        $destination = Join-Path $tempDir $asset.name
        if ((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination).Length -eq $asset.size)) {
            Write-Output "已存在，跳过下载：$($asset.name)"
            continue
        }
        Write-Output "下载 $($asset.name) ..."
        Invoke-WebRequest -Uri $asset.browser_download_url -Headers @{ 'User-Agent' = 'cove-cloud-publisher' } -OutFile $destination -UseBasicParsing
        $actualSize = (Get-Item -LiteralPath $destination).Length
        if ($actualSize -ne $asset.size) { throw "$($asset.name) 下载不完整（$actualSize / $($asset.size) 字节）。" }
    }

    $latestJson = Join-Path $tempDir 'latest.json'
    $metadata = @{ tag_name = $Tag; draft = $false; prerelease = $false } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($latestJson, $metadata, [System.Text.UTF8Encoding]::new($false))

    Write-Output "准备云服务器临时目录：$staging"
    Invoke-Checked 'ssh' @($SshTarget, "mkdir -p '$staging'")
    $localFiles = @($selectedAssets | ForEach-Object { Join-Path $tempDir $_.name }) + $latestJson
    Invoke-Checked 'scp' ($localFiles + "${SshTarget}:$staging/")

    $releaseDir = "$RemoteRoot/releases/$Tag"
    $remoteCommands = @(
        'set -eu',
        "sudo install -d -m 0755 '$releaseDir' '$RemoteRoot/downloads'",
        "sudo install -m 0644 '$staging/latest.yml' '$releaseDir/latest.yml'",
        "sudo install -m 0644 '$staging/Cove-Setup-$version.exe' '$releaseDir/Cove-Setup-$version.exe'",
        "sudo install -m 0644 '$staging/Cove-Setup-$version.exe.blockmap' '$releaseDir/Cove-Setup-$version.exe.blockmap'",
        "sudo install -m 0644 '$staging/Cove-Server-Setup-$version.exe' '$releaseDir/Cove-Server-Setup-$version.exe'",
        "sudo install -m 0644 '$staging/Cove-Server-Setup-$version.exe.blockmap' '$releaseDir/Cove-Server-Setup-$version.exe.blockmap'",
        "sudo install -m 0644 '$releaseDir/Cove-Setup-$version.exe' '$RemoteRoot/downloads/Cove-Setup.exe'",
        "sudo install -m 0644 '$releaseDir/Cove-Server-Setup-$version.exe' '$RemoteRoot/downloads/Cove-Server-Setup.exe'",
        "sudo install -m 0644 '$staging/latest.json' '$RemoteRoot/releases/latest.json'",
        "rm -rf -- '$staging'"
    )
    Invoke-Checked 'ssh' @($SshTarget, ($remoteCommands -join '; '))

    $publicMetadata = Invoke-RestMethod -Uri "$publicBase/releases/latest.json?check=$Tag" -UseBasicParsing
    if ($publicMetadata.tag_name -ne $Tag -or $publicMetadata.draft -or $publicMetadata.prerelease) {
        throw "公开 latest.json 未确认 $Tag。"
    }
    foreach ($name in @("releases/$Tag/latest.yml", 'downloads/Cove-Setup.exe', 'downloads/Cove-Server-Setup.exe')) {
        $response = Invoke-WebRequest -Uri "$publicBase/$name`?check=$Tag" -Method Head -MaximumRedirection 5 -UseBasicParsing
        if ($response.StatusCode -ne 200) { throw "公开文件不可访问：$name（HTTP $($response.StatusCode)）。" }
    }
    Write-Output "完成：$Tag 已发布到 $publicBase。"
    $completed = $true
} finally {
    if ($completed -and (Test-Path -LiteralPath $tempDir)) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force
        Write-Output '已清理本地下载临时目录。'
    } elseif (-not $completed) {
        Write-Output "发布未完成；本地临时文件保留在 $tempDir，远端暂存目录为 $staging（如已创建）。"
    }
}
