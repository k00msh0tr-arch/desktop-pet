@echo off
rem The real work runs from a temporary copy in its own window, so this file and its folder can be deleted safely.
cd /d "%TEMP%"
copy /y "%~dp0setup\uninstall.ps1" "%TEMP%\claude-pet-uninstall.ps1" >nul
start "Claude Pet uninstaller" powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\claude-pet-uninstall.ps1"
exit /b
