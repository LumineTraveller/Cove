<#
.SYNOPSIS
    将已公开的 GitHub 手机版 Release 镜像到 Cove 服务器。

.EXAMPLE
    .\scripts\publish-mobile-release-to-cloud.ps1 -FeedPath mobile\update.json

    也可传入 mobile\build\updates\mobile-vX.Y.Z\update.json，在公开
    GitHub APK 后、推送仓库更新清单前先完成服务器镜像。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$FeedPath,
    [string]$GitHubRepo = 'LumineTraveller/Cove',
    [ValidatePattern('^[A-Za-z0-9._@:-]+$')]
    [string]$SshTarget = 'Cove_server',
    [ValidatePattern('^/[A-Za-z0-9._/-]+$')]
    [string]$RemoteRoot = '/var/www/cove-download',
    [uri]$PublicBaseUrl = 'https://cove-cove.space'
)

$ErrorActionPreference = 'Stop'
if ($RemoteRoot -eq '/' -or $PublicBaseUrl.Scheme -ne 'https' -or $PublicBaseUrl.UserInfo) {
    throw '需要安全的服务器目录和无账号信息的 HTTPS 下载地址。'
}
$feedFile = (Resolve-Path -LiteralPath $FeedPath).Path
$feed = Get-Content -LiteralPath $feedFile -Raw -Encoding UTF8 | ConvertFrom-Json
$item = $feed.release
if ($feed.schemaVersion -ne 1 -or $feed.platform -ne 'android' -or
    $item.packageName -ne 'com.cove.mobile' -or
    $item.versionName -notmatch '^\d+\.\d+\.\d+$' -or
    $item.tag -notmatch '^mobile-v\d+\.\d+\.\d+$' -or
    $item.tag -ne "mobile-v$($item.versionName)" -or
    $item.filename -ne "Cove-Mobile-$($item.versionName).apk" -or
    $item.size -le 0 -or $item.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
    throw '手机更新清单无效，不能发布到服务器。'
}
$tag = [string]$item.tag
$fileName = [string]$item.filename
$publicBase = $PublicBaseUrl.AbsoluteUri.TrimEnd('/')

function Invoke-Checked([string]$command, [string[]]$arguments) {
    & $command @arguments
    if ($LASTEXITCODE -ne 0) { throw "$command 执行失败（退出码 $LASTEXITCODE）。" }
}

function Assert-PublicApk([string]$url, [long]$expectedSize) {
    $nodeCode = @'
const [url, expectedSize] = process.argv.slice(1);
fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) })
  .then(response => {
    const actualSize = response.headers.get('content-length');
    if (response.status !== 200 || actualSize !== expectedSize) {
      throw new Error(`APK 回查失败：HTTP ${response.status}，大小 ${actualSize}，预期 ${expectedSize}`);
    }
    console.log(`HTTP 200，${actualSize} 字节：${url}`);
  })
  .catch(error => { console.error(error); process.exitCode = 1; });
'@
    Invoke-Checked 'node' @('-e', $nodeCode, $url, [string]$expectedSize)
}

$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$GitHubRepo/releases/tags/$tag" `
    -Headers @{ 'User-Agent' = 'cove-mobile-cloud-publisher' } -UseBasicParsing -NoProxy
if ($release.draft -or $release.prerelease -or $release.tag_name -ne $tag) {
    throw "GitHub $tag 不是已公开的正式 Release。"
}
$asset = @($release.assets | Where-Object { $_.name -eq $fileName })
if ($asset.Count -ne 1 -or $asset[0].size -ne $item.size) {
    throw "GitHub $tag 的 APK 不存在或大小与清单不符。"
}

$tempRoot = [System.IO.Path]::GetTempPath().TrimEnd('\', '/')
$tempDir = Join-Path $tempRoot "cove-mobile-cloud-$tag-$([guid]::NewGuid().ToString('N'))"
$apkPath = Join-Path $tempDir $fileName
$staging = "/tmp/cove-mobile-cloud-$tag-$([guid]::NewGuid().ToString('N'))"
$completed = $false
try {
    New-Item -ItemType Directory -Path $tempDir | Out-Null
    Invoke-Checked 'curl.exe' @(
        '--noproxy', '*', '--fail', '--location', '--retry', '3',
        '--connect-timeout', '10', '--max-time', '300',
        '--output', $apkPath, [string]$asset[0].browser_download_url
    )
    if ((Get-Item -LiteralPath $apkPath).Length -ne $item.size -or
        (Get-FileHash -LiteralPath $apkPath -Algorithm SHA256).Hash -ne $item.sha256) {
        throw '下载的 GitHub APK 与更新清单的大小或 SHA-256 不一致。'
    }

    Invoke-Checked 'ssh' @($SshTarget, "mkdir -m 0700 '$staging'")
    Invoke-Checked 'scp' @($apkPath, "${SshTarget}:$staging/$fileName")
    Invoke-Checked 'scp' @($feedFile, "${SshTarget}:$staging/update.json")
    $releaseDir = "$RemoteRoot/releases/$tag"
    $installApkCommands = @(
        'set -eu',
        "test `"`$(sha256sum '$staging/$fileName' | cut -d' ' -f1)`" = '$($item.sha256.ToLowerInvariant())'",
        "sudo install -d -m 0755 '$releaseDir' '$RemoteRoot/releases/mobile' '$RemoteRoot/downloads'",
        "sudo install -m 0644 '$staging/$fileName' '$releaseDir/$fileName'",
        "sudo install -m 0644 '$releaseDir/$fileName' '$RemoteRoot/downloads/Cove-Mobile.apk'"
    )
    Invoke-Checked 'ssh' @($SshTarget, ($installApkCommands -join '; '))
    Assert-PublicApk "$publicBase/releases/$tag/$fileName`?check=$tag" $item.size
    $publishFeedCommands = @(
        'set -eu',
        "sudo install -m 0644 '$staging/update.json' '$RemoteRoot/releases/mobile/update.json'",
        "rm -f -- '$staging/$fileName' '$staging/update.json'",
        "rmdir -- '$staging'"
    )
    Invoke-Checked 'ssh' @($SshTarget, ($publishFeedCommands -join '; '))
    $published = Invoke-RestMethod -Uri "$publicBase/releases/mobile/update.json?check=$tag" -UseBasicParsing -NoProxy
    if ($published.release.tag -ne $tag -or $published.release.sha256 -ne $item.sha256) {
        throw '公开的手机更新清单与待发布版本不一致。'
    }
    Write-Output "完成：$tag 已镜像到 $publicBase/releases/$tag/$fileName"
    $completed = $true
} finally {
    $resolvedTemp = [System.IO.Path]::GetFullPath($tempDir)
    if ($completed -and $resolvedTemp.StartsWith("$tempRoot\", [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    } elseif (-not $completed) {
        Write-Output "镜像未完成；本地临时文件保留在 $tempDir，远端暂存目录为 $staging（如已创建）。"
    }
}
