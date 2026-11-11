@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo Checking for an existing server on port 5173...

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":5173" ^| findstr "LISTENING"') do (
    echo Found existing server on port 5173 ^(PID %%P^) - stopping it...
    taskkill /F /PID %%P >nul 2>&1
)

echo Starting SNS Reader...
start "" /min C:\Claude\open-url.bat http://127.0.0.1:5173
call npm start
