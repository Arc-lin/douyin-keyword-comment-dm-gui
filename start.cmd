@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\playwright\package.json" (
  echo [Setup] Installing Node dependencies...
  set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
  call npm install
  if errorlevel 1 (
    echo [Error] npm install failed.
    pause
    exit /b 1
  )
)

set OPEN_BROWSER=1
node server.mjs

if errorlevel 1 (
  echo.
  echo [Error] Server stopped unexpectedly.
  pause
)
