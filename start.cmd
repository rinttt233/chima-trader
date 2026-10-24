@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 20 或更新的版本：https://nodejs.org/
  pause
  exit /b 1
)
echo 正在启动 千亦所 ChimaTrader 模拟交易台...
start "" http://127.0.0.1:8787
node server.mjs
pause
