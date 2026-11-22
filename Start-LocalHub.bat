@echo off
title LocalHub
cd /d "%~dp0"

REM LocalHub one-click launcher (pure ASCII for maximum compatibility)
REM Browser auto-opens, closing this window stops the server

where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "require('node:sqlite')" >nul 2>nul
if errorlevel 1 goto badnode

REM Informational pre-check: another LocalHub may already be running.
REM Non-blocking: we always try to start, node itself reports if the port is busy.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5217 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }" >nul 2>nul
if not errorlevel 1 goto startnow
echo.
echo  [HINT] Port 5217 appears busy - another LocalHub may already be running.
echo  Trying to start anyway ... if it fails, stop the old instance first
echo  (Task Manager ^> node.exe). Starting in 2 seconds ...
timeout /t 2 /nobreak >nul
:startnow
echo.
echo  Starting LocalHub ... browser will open http://localhost:5217
echo  Phone: join the same WiFi, then scan the QR from the web UI.
echo  Close this window to stop the server.
echo  (First run: click Allow on the firewall popup, or run setup-firewall.bat)
echo.
start /min cmd /c "timeout /t 3 /nobreak >nul & start \"\" http://localhost:5217"
node server/index.js

echo.
echo  [LocalHub server stopped]
pause
exit /b 0

:nonode
echo  [ERROR] Node.js not found. Install Node.js 22.5+ from https://nodejs.org
pause
exit /b 1

:badnode
echo  [ERROR] Node.js too old (22.5+ required, 24 LTS recommended). Current:
node -v
echo  Please update Node.js and try again.
pause
exit /b 1
