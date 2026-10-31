@echo off
setlocal
cd /d "%~dp0"
node tooling\start-last-round-candidate.cjs
if errorlevel 1 pause
