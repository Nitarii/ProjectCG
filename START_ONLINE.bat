@echo off
setlocal
cd /d "%~dp0"
title ProjectPC - Point Control - Lancement en ligne
where node >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Node.js n'est pas installe ou n'est pas dans le PATH.
  echo Installe Node.js LTS depuis https://nodejs.org puis relance ce fichier.
  pause
  exit /b 1
)
set CF=cloudflared
if exist "%~dp0cloudflared.exe" set CF="%~dp0cloudflared.exe"
where cloudflared >nul 2>nul
if errorlevel 1 if not exist "%~dp0cloudflared.exe" (
  echo [ERREUR] cloudflared introuvable.
  echo Lance INSTALL_CLOUDFLARED.bat une fois, puis relance START_ONLINE.bat.
  pause
  exit /b 1
)

rem Ne lance pas une seconde instance si le serveur repond deja.
curl.exe -fsS http://127.0.0.1:8080/health >nul 2>nul
if errorlevel 1 start "ProjectPC - Point Control - Serveur" cmd /k "cd /d ""%~dp0"" && node server.js"

echo Verification du serveur local...
for /l %%I in (1,1,20) do (
  curl.exe -fsS http://127.0.0.1:8080/health >nul 2>nul && goto :server_ready
  timeout /t 1 /nobreak >nul
)
echo [ERREUR] Le serveur n'a pas repondu sur http://127.0.0.1:8080/health
pause
exit /b 1

:server_ready
echo.
echo ============================================================
echo ProjectPC est pret. Cloudflare choisit QUIC automatiquement,
echo avec repli HTTP/2 si l'UDP n'est pas disponible.
echo Copie l'adresse https://....trycloudflare.com et envoie-la a tes amis.
echo Fermer cette fenetre coupe le tunnel public.
echo ============================================================
echo.
%CF% tunnel --protocol auto --loglevel warn --url http://localhost:8080
pause
