' AgentsWorkflow worker (win-a) service supervisor (ASCII only)
' Same restart-on-crash loop as the hub supervisor.
Option Explicit
Dim sh, code, attempts, maxAttempts
Set sh = CreateObject("Wscript.Shell")
sh.CurrentDirectory = "D:\Agents Workflow\hub"
maxAttempts = 999
attempts = 0
Do
  code = sh.Run("""C:\Program Files\nodejs\node.exe"" ""src\m3\worker.mjs"" --node win-a --engines claude-code,codex,mock --hub http://127.0.0.1:8787", 0, True)
  If code = 0 Then WScript.Quit 0
  attempts = attempts + 1
  If attempts > maxAttempts Then WScript.Quit code
  WScript.Sleep 5000
Loop
