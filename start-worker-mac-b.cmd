@echo off
chcp 65001 >nul
setlocal

rem ---------------------------------------------------------------
rem  Agents Workflow Worker - Mac laptop node (mac-b)
rem  This .cmd is for rehearsal on Windows. On the actual Mac use:
rem    node src/m3/worker.mjs --node mac-b --engines codex,mock \
rem         --hub http://<windows-host-ip>:8787
rem  ASCII-only on purpose (see start-worker-win-a.cmd).
rem ---------------------------------------------------------------

cd /d "%~dp0"

if "%HUB_URL%"=="" set HUB_URL=http://127.0.0.1:8787
if "%NODE_ID%"=="" set NODE_ID=mac-b
if "%NODE_ENGINES%"=="" set NODE_ENGINES=codex,mock

echo.
echo   Executor node %NODE_ID%  (human terminal)
echo   ---------------------------------------------
echo   hub     : %HUB_URL%
echo   engines : %NODE_ENGINES%
echo.

node src\m3\worker.mjs --node %NODE_ID% --engines %NODE_ENGINES% --hub %HUB_URL%
set RC=%ERRORLEVEL%

if not "%RC%"=="0" (
  echo.
  echo   [ERROR] worker exited with code %RC%
  pause
)

endlocal
