@echo off
setlocal
cd /d "%~dp0"
title ProjectPC - Point Control - Serveur
where node >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Node.js n'est pas installe ou n'est pas dans le PATH.
  echo Installe Node.js LTS depuis https://nodejs.org puis relance ce fichier.
  pause
  exit /b 1
)
echo.
echo Le serveur sera accessible localement sur http://localhost:8080
echo Laisse cette fenetre ouverte pendant que vous jouez.
echo.
node server.js
pause
