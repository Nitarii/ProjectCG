@echo off
setlocal
cd /d "%~dp0"
title ProjectPC - Point Control - Cloudflare Tunnel
set CF=cloudflared
if exist "%~dp0cloudflared.exe" set CF="%~dp0cloudflared.exe"
where cloudflared >nul 2>nul
if errorlevel 1 if not exist "%~dp0cloudflared.exe" (
  echo [ERREUR] cloudflared introuvable.
  echo Lance d'abord INSTALL_CLOUDFLARED.bat ou place cloudflared.exe dans ce dossier.
  pause
  exit /b 1
)
curl.exe -fsS http://127.0.0.1:8080/health >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] ProjectPC ne repond pas sur le port 8080.
  echo Lance START_SERVER.bat d'abord.
  pause
  exit /b 1
)
echo.
echo Tunnel gratuit vers http://localhost:8080
rem protocol=auto privilegie QUIC et retombe automatiquement en HTTP/2 si necessaire.
%CF% tunnel --protocol auto --loglevel warn --url http://localhost:8080
pause
