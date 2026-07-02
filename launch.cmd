@echo off
cd /d "%~dp0"
title Roku Unchained

echo Roku Unchained — hardware freedom suite
echo =======================================
echo.

:: Kill zombies on our ports
powershell -Command "$p=@(4700..4710)+@(9090..9099);Get-NetTCPConnection -LocalPort $p -EA 0|%%{Stop-Process -Id $_.OwningProcess -Force -EA 0};exit 0" 2>nul

:: Make sure deps are installed
if not exist "node_modules\.package-lock.json" (
    echo Installing dependencies...
    call npm install --no-fund --no-audit
)

:: Start server in background
echo Starting server...
start /B node server.js

:: Wait for server
:wait
timeout /t 1 /nobreak >nul
netstat -ano 2>nul | find ":4700 " | find "LISTENING" >nul || goto :wait

echo.
echo  =======================================
echo    Roku Unchained is running!
echo    http://localhost:4700
echo  =======================================
echo.
echo Opening browser...
start http://localhost:4700
echo.
echo Close this window to keep the server running.
echo To stop it: taskkill /f /im node.exe 2>nul
