@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\gh-maestro-install.ps1" %*
endlocal
