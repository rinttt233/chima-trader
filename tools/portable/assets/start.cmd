@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "APP_PORT=8787"
if defined PORT set "APP_PORT=%PORT%"
set "APP_URL=http://127.0.0.1:%APP_PORT%"

echo ==================================================
echo  ChimaTrader [QianYiSuo] - portable edition
echo ==================================================
echo.

if not exist "runtime\node.exe" goto :no_runtime

netstat -ano | findstr /r /c:"LISTENING" | findstr ":%APP_PORT% " >nul 2>nul
if not errorlevel 1 goto :port_busy

echo Starting the server ...
start "ChimaTrader" /min "runtime\node.exe" app.mjs

echo Waiting for the server to start ...
timeout /t 4 /nobreak >nul 2>nul
if errorlevel 1 ping -n 5 127.0.0.1 >nul

netstat -ano | findstr /r /c:"LISTENING" | findstr ":%APP_PORT% " >nul 2>nul
if errorlevel 1 echo [WARNING] The server is not listening yet - check the ChimaTrader window for errors.

set "BROWSER="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles%\Mozilla Firefox\firefox.exe" set "BROWSER=%ProgramFiles%\Mozilla Firefox\firefox.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe" set "BROWSER=%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if defined BROWSER goto :open_known
goto :open_default

:open_known
echo Opening %APP_URL%
echo   %BROWSER%
start "" "%BROWSER%" "%APP_URL%"
goto :started

:open_default
echo Opening %APP_URL% with the default browser ...
echo Recommended browsers: Chrome 109 or Firefox 115 ESR.
echo Internet Explorer cannot run this app.
start "" "%APP_URL%"
goto :started

:started
echo.
echo The server runs in the minimized window titled "ChimaTrader".
echo Close that window, or press Ctrl+C in it, to stop the server.
echo Data is saved automatically in the "data" folder.
echo.
pause
exit /b 0

:port_busy
echo [ERROR] Port %APP_PORT% is already in use.
echo         Close the other ChimaTrader window, or change the port:
echo           set an environment variable first:  set PORT=8799
echo           or edit "server.port" in config.json
echo.
pause
exit /b 1

:no_runtime
echo [ERROR] runtime\node.exe is missing - the package is incomplete.
echo         Extract the zip again and keep the folder structure.
echo.
pause
exit /b 1
