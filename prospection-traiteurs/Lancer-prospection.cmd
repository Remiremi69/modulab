@echo off
rem Double-cliquez sur ce fichier pour lancer une prospection.
rem Reglages facultatifs : decommentez une ligne ci-dessous (retirez "rem ").
rem set MAX_ANALYSES=40
rem set RECHERCHES_WEB=10
rem set SANS_IA=1
rem set DEPARTEMENT=69

chcp 65001 >nul
cd /d "%~dp0.."
if not exist node_modules (
  echo Premiere utilisation : installation des dependances...
  call npm.cmd install || goto :erreur
)
call npx.cmd tsx prospection-traiteurs\prospecter.ts || goto :erreur
start "" "%~dp0resultats"
echo.
pause
exit /b 0

:erreur
echo.
echo La prospection s'est arretee sur une erreur (voir le message ci-dessus).
pause
exit /b 1
