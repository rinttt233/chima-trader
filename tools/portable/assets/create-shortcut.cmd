@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if not exist "chima-trader.ico" (
  echo [ERROR] chima-trader.ico not found in this folder.
  pause
  exit /b 1
)
echo Creating a desktop shortcut with the ChimaTrader icon...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $desktop = [Environment]::GetFolderPath('Desktop'); $sc = $ws.CreateShortcut((Join-Path $desktop 'ChimaTrader.lnk')); $sc.TargetPath = (Join-Path (Get-Location) 'start.cmd'); $sc.WorkingDirectory = (Get-Location).Path; $sc.IconLocation = (Join-Path (Get-Location) 'chima-trader.ico'); $sc.Save()"
if errorlevel 1 (
  echo [WARN] Could not create the shortcut. You can create it manually and pick chima-trader.ico as the icon.
) else (
  echo Done. A "ChimaTrader" shortcut with the new icon is on your Desktop.
)
pause
