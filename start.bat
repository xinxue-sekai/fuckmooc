@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title fuckmooc

where node >nul 2>nul
if errorlevel 1 goto no_node

if not exist "data" mkdir "data"
where wscript >nul 2>nul
if errorlevel 1 goto run_console
wscript "%~dp0start.vbs"
exit /b 0

:run_console
start "fuckmooc" /MIN cmd /c "node gui.js > data\gui-stdout.log 2>&1"
exit /b 0

:no_node
echo ==============================================
echo  fuckmooc needs Node.js to run.
echo  Downloading and installing via winget,
echo  this takes about 1-2 minutes, please wait...
echo ==============================================
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto no_winget
echo Node.js installed. Close this window and double-click start.bat again.
pause
exit /b 0

:no_winget
echo winget is unavailable. Please install Node.js manually:
echo https://nodejs.org/zh-cn   (LTS, 22 or higher)
pause
exit /b 0
