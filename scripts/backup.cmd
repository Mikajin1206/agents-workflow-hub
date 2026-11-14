@echo off
rem ----- Backup ledger and reports -----
rem Called by Windows Task Scheduler. Keep this file ASCII-only:
rem cmd.exe parses .cmd with the OEM code page (GBK on zh-CN), so non-ASCII
rem comments get executed as commands and the whole script fails.
rem
rem Register a daily task (run as your own user, not SYSTEM):
rem   schtasks /create /tn "AgentsWorkflow-Backup" /tr "\"%~dp0backup.cmd\"" /sc daily /st 03:30
rem
rem Manual run:  backup.cmd
rem              backup.cmd --keep 14

setlocal
chcp 65001 >nul
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found in PATH.
  echo         Install Node.js 22 or newer, then retry.
  pause
  exit /b 1
)

node scripts\backup.mjs %*
set RC=%ERRORLEVEL%

if not "%RC%"=="0" (
  echo.
  echo [ERROR] backup failed with exit code %RC%
  echo         Check that data\hub.db exists and is not locked by another process.
  pause
)
exit /b %RC%
