@echo off
setlocal
cd /d "%~dp0"
node tooling\start-client-settings-candidate.cjs
if errorlevel 1 pause
