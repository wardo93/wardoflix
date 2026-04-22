@echo off
title WardoFlix
cd /d "%~dp0"

echo.
echo   WardoFlix - Starting...
echo.

:: Check if node_modules exists
if not exist "node_modules" (
    echo   Installing dependencies...
    call npm install
    echo.
)

:: Start the app (backend + frontend + opens browser)
call npm start

:: If it exits unexpectedly, keep the window open so user can see errors
echo.
echo   WardoFlix has stopped. Press any key to close.
pause >nul
