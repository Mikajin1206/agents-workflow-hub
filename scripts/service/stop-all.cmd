@echo off
rem ----- stop the AgentsWorkflow hub and worker (service mode) -----
rem kills the supervisor wscript launchers first, then any surviving node
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-all.ps1"
echo done.
