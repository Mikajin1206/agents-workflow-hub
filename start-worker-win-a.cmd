@echo off
chcp 65001 >nul
setlocal

rem ---------------------------------------------------------------
rem  Agents Workflow Worker - Windows host node (win-a)
rem  Long-polls the hub; keep this window open.
rem  ASCII-only on purpose: cmd.exe parses .cmd with the console
rem  code page and non-ASCII lines break on GBK systems.
rem ---------------------------------------------------------------

cd /d "%~dp0"

if "%HUB_URL%"=="" set HUB_URL=http://127.0.0.1:8787
if "%NODE_ID%"=="" set NODE_ID=win-a
rem claude-code must be listed explicitly: the worker only claims tasks whose
rem engine it advertises, so a node started with just "codex,mock" silently
rem starves any rule routed to claude-code.
if "%NODE_ENGINES%"=="" set NODE_ENGINES=claude-code,codex,mock

echo.
echo   Executor node %NODE_ID%
echo   ---------------------------------------------
echo   hub     : %HUB_URL%
echo   engines : %NODE_ENGINES%
echo.
echo   Keep this window open. Press Ctrl+C to stop.
echo.

node src\m3\worker.mjs --node %NODE_ID% --engines %NODE_ENGINES% --hub %HUB_URL%
set RC=%ERRORLEVEL%

if not "%RC%"=="0" (
  echo.
  echo   [ERROR] worker exited with code %RC%
  echo   Check the hub first:
  echo     curl %HUB_URL%/api/health
  echo.
  pause
)

endlocal
