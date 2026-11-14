# stop-all.ps1 - stop AgentsWorkflow supervisors (wscript) and node workers
$supervisors = Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" |
  Where-Object { $_.CommandLine -match 'service[/\\]+start-' }
foreach ($p in $supervisors) {
  Write-Output ("stopped wscript " + $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force
}
$nodes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'src[/\\]+index\.mjs' -or $_.CommandLine -match 'src[/\\]+m3[/\\]+worker\.mjs' }
foreach ($p in $nodes) {
  Write-Output ("stopped node " + $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force
}
Write-Output ("stopped supervisors=" + $supervisors.Count + " nodes=" + $nodes.Count)
