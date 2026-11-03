@echo off
setlocal
cd /d "%~dp0"
title ProjectPC - Point Control - Installation Cloudflared
echo Telechargement officiel de cloudflared Windows 64 bits...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%~dp0cloudflared.exe'"
if errorlevel 1 (
  echo Echec du telechargement.
  pause
  exit /b 1
)
"%~dp0cloudflared.exe" --version
echo.
echo Termine. Tu peux maintenant lancer START_TUNNEL.bat.
pause
