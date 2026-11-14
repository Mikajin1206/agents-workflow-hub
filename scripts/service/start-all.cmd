@echo off
rem ----- start the AgentsWorkflow scheduled tasks immediately -----
rem (they also start automatically at logon)
schtasks /run /tn "AgentsWorkflow-Hub"
schtasks /run /tn "AgentsWorkflow-Worker-win-a"
