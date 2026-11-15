@echo off
chcp 65001 >nul
setlocal

rem ---------------------------------------------------------------
rem  Agents Workflow Hub - launcher (Windows)
rem  Keep this file ASCII-only: cmd.exe reads .cmd bytes with the
rem  console code page, non-ASCII comments break parsing on GBK.
rem ---------------------------------------------------------------

cd /d "%~dp0"

if "%HUB_PORT%"=="" set HUB_PORT=8787
if "%HUB_HOST%"=="" set HUB_HOST=127.0.0.1

echo.
echo   Agents Workflow Hub
echo   ---------------------------------------------
echo   panel : http://%HUB_HOST%:%HUB_PORT%
echo   logs  : data\logs\
echo   ledger: data\hub.db
echo.
echo   Press Ctrl+C to stop.
echo.

node src\index.mjs
set RC=%ERRORLEVEL%

if not "%RC%"=="0" (
  echo.
  echo   [ERROR] hub exited with code %RC%
  echo   Common cause: port %HUB_PORT% already in use. Try:
  echo     set HUB_PORT=8899 ^&^& start-hub.cmd
  echo.
  pause
)

endlocal
