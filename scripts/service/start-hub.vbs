' AgentsWorkflow hub service supervisor (ASCII only)
' wscript hides the console; the Do-loop restarts node whenever it dies
' with a non-zero exit code (crash). A clean exit (0) ends the supervisor.
' Stop with scripts\service\stop-all.cmd (it kills this wscript first).
Option Explicit
Dim sh, code, attempts, maxAttempts
Set sh = CreateObject("Wscript.Shell")
sh.CurrentDirectory = "D:\Agents Workflow\hub"
maxAttempts = 999
attempts = 0
Do
  code = sh.Run("""C:\Program Files\nodejs\node.exe"" ""src\index.mjs""", 0, True)
  If code = 0 Then WScript.Quit 0
  attempts = attempts + 1
  If attempts > maxAttempts Then WScript.Quit code
  WScript.Sleep 5000
Loop
