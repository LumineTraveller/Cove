$root = $PSScriptRoot
$electron = "$root\node_modules\electron\dist\electron.exe"
$main = "$root\client\dist-electron\main.js"

# Kill any leftover processes on 3001 / 5173
Get-NetTCPConnection -LocalPort 3001,5173 -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

# Compile electron main process
Write-Host "[1/3] Compiling electron main..." -ForegroundColor Cyan
Set-Location "$root\client"
npx tsc -p electron/tsconfig.json | Out-Null

# Start server in background
Write-Host "[2/3] Starting server..." -ForegroundColor Cyan
$server = Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\server'; npm run dev" -PassThru

# Start Vite in background
Write-Host "[3/3] Starting Vite..." -ForegroundColor Cyan
$vite = Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\client'; npm run dev" -PassThru

# Wait for Vite to be ready
Write-Host "Waiting for Vite on http://localhost:5173 ..." -ForegroundColor Yellow
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:5173" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
}

if (-not $ready) {
  Write-Host "Vite did not start in time." -ForegroundColor Red
  exit 1
}

# Launch Electron
Write-Host "Launching Electron..." -ForegroundColor Green
& $electron $main
