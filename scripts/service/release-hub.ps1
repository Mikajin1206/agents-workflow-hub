param([switch]$Check)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $root

$NodePath = (Get-Command node.exe).Source
$headersJson = & $NodePath --input-type=module -e "import {loadConfig} from './src/lib/config.mjs'; console.log(JSON.stringify(loadConfig().hub))"
if ($LASTEXITCODE) { throw 'Cannot load the Hub configuration' }
$hub = $headersJson | ConvertFrom-Json
$url = "http://$($hub.host):$($hub.port)"
$headers = @{ 'x-hub-token' = $hub.secret }
foreach ($status in @('running','leased','executing')) {
    $tasks = Invoke-RestMethod "$url/api/tasks?status=$status&limit=1" -Headers $headers
    if (@($tasks.tasks).Count) { throw "Hub is busy: $status" }
}
$listener = Get-NetTCPConnection -LocalPort $hub.port -State Listen | Select-Object -First 1
$service = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
$parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($service.ParentProcessId)"
if ($service.CommandLine -notmatch 'src[\\/]index\.mjs' -or
    $parent.CommandLine -notlike "*$root\scripts\service\start-hub.vbs*") {
    throw 'The running Hub is not supervised by this checkout'
}
if (git status --porcelain) { throw 'Deployment checkout must be clean' }
if ($LASTEXITCODE) { throw 'Cannot inspect deployment checkout' }
if ($Check) { exit 0 }

$sha = $env:HUB_MERGED_SHA
if ($sha -notmatch '^[a-f0-9]{40}$') { throw 'Missing merge SHA' }
git fetch --no-tags origin $sha
if ($LASTEXITCODE) { throw 'Cannot fetch the merged commit' }
git switch --detach $sha
if ($LASTEXITCODE) { throw 'Cannot activate the merged commit' }
Stop-Process -Id $service.ProcessId -Force
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    try {
        $version = Invoke-RestMethod "$url/api/version" -Headers $headers -TimeoutSec 2
        if ($version.clean -and $version.commit -eq $sha) { exit 0 }
    } catch {
        # The supervisor needs time to bring up the new process.
    }
}
throw "Hub did not start on $sha"
