@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title ProjectCG2 - Serveur local

if not exist "server.js" (
  echo [ERREUR] Le fichier server.js est introuvable.
  echo Place START_LOCAL.bat dans le dossier principal du jeu, a cote de server.js.
  pause
  exit /b 1
)

where node.exe >nul 2>&1
if errorlevel 1 (
  echo [ERREUR] Node.js est introuvable.
  echo Installe la version LTS depuis https://nodejs.org/
  echo Puis ferme et rouvre ce fichier.
  pause
  exit /b 1
)

rem Eviter de lancer une deuxieme instance si le serveur local tourne deja.
curl.exe --fail --silent --show-error --max-time 2 http://127.0.0.1:8080/health >nul 2>&1
if not errorlevel 1 (
  echo [INFO] Le serveur local fonctionne deja.
  start "" "http://127.0.0.1:8080/"
  exit /b 0
)

echo ============================================================
echo   PROJECTCG2 - POINT CONTROL - MODE LOCAL
echo ============================================================
echo.
echo Serveur : http://127.0.0.1:8080/
echo Le navigateur s'ouvrira des que le serveur sera pret.
echo Le code administrateur apparaitra ci-dessous.
echo Garde cette fenetre ouverte pendant la partie.
echo Aucun tunnel Cloudflare n'est necessaire.
echo.

rem Attendre que /health reponde avant d'ouvrir automatiquement le jeu.
start "" /min powershell.exe -NoProfile -Command "$url='http://127.0.0.1:8080/health'; for($i=0;$i -lt 60;$i++){try{$r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2;if($r.StatusCode -eq 200){Start-Process 'http://127.0.0.1:8080/';break}}catch{};Start-Sleep -Milliseconds 500}"

node server.js
echo.
echo [INFO] Le serveur s'est arrete.
pause
