@echo off
chcp 65001 >nul
title 兽药台账 · 多端同步服务
cd /d "%~dp0"

REM ========= 配置区（按需修改）=========
set NODE_EXE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe
set PORT=3000
REM ====================================

echo.
echo  [1/3] 检查后端是否已运行...
curl -s -o nul http://localhost:%PORT%/api/state
if %ERRORLEVEL%==0 (
  echo        后端已在运行，跳过启动。
  goto :start_tunnel
)

echo  [2/3] 启动本地后端 server.js ...
start "" "%NODE_EXE%" server.js
echo        等待后端启动...
timeout /t 3 >nul

:start_tunnel
echo  [3/3] 建立公网隧道（ssh + pinggy，免费60分钟，关闭此窗口即断开）...
echo.
echo  >>> 下方会显示一个 https 链接，手机浏览器打开即可用（与电脑共用同一账本）<<<
echo.
ssh -p 443 -R 0:localhost:%PORT% -o StrictHostKeyChecking=no -o ServerAliveInterval=30 a.pinggy.io
echo.
echo  隧道已断开。如需重新连接，关闭本窗口后再次双击本脚本即可。
pause
