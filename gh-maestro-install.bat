@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gh-maestro-install.ps1" %*
endlocal
