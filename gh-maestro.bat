@echo off
setlocal
set CLAUDE_CODE_USE_POWERSHELL_TOOL=1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gh-maestro.ps1" %*
endlocal
