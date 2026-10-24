@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo         Install Node.js 20 or newer: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

netstat -ano | findstr /r /c:"LISTENING.*:8787" >nul 2>nul
if not errorlevel 1 (
  echo [ERROR] Port 8787 is already in use.
  echo         Close the other ChimaTrader window, or change server.port in config.json
  echo.
  pause
  exit /b 1
)

echo Starting ChimaTrader (QianYiSuo) ...
echo Local URL: http://127.0.0.1:8787
echo Keep this window open while using the app. Ctrl+C stops the server.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 40;$i++){try{$null = Invoke-WebRequest 'http://127.0.0.1:8787/api/health' -UseBasicParsing -TimeoutSec 1; break}catch{Start-Sleep -Milliseconds 400}}; Start-Process 'http://127.0.0.1:8787'"

node server.mjs

echo.
echo Server stopped. If an error was printed above, copy it for troubleshooting.
pause
