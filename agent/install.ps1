# Device Monitor installer (Windows). Served by the hub with __HUB__ / __TOKEN__ filled in.
# Use the one-time HTTPS enrollment command from the dashboard.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$hub = '__HUB__'; $token = '__TOKEN__'; $wantHash = '__SHA_AGENT_PS1__'
$dir = Join-Path $env:LOCALAPPDATA 'DeviceMonitor'
New-Item -ItemType Directory -Force $dir | Out-Null

# Stop a previously installed agent, if any.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*DeviceMonitor\agent.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$agentFile = Join-Path $dir 'agent.ps1'
if (([uri]$hub).Scheme -ne 'https') { throw 'An HTTPS hub is required' }
$stage = Join-Path $dir ([guid]::NewGuid().ToString() + '.tmp')
try {
Invoke-WebRequest "$hub/agent.ps1" -UseBasicParsing -MaximumRedirection 0 -OutFile $stage
# The hub pinned this hash when it issued the installer — a tampered agent script never runs.
if ((Get-FileHash $stage -Algorithm SHA256).Hash.ToLower() -ne $wantHash) {
  throw 'The agent download failed its integrity check — refusing to install.'
}
Move-Item -LiteralPath $stage -Destination $agentFile -Force
} finally { Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue }
@{ hub = $hub; token = $token; id = '__DEVICE_ID__' } | ConvertTo-Json | Set-Content (Join-Path $dir 'config.json') -Encoding ASCII

# Hidden launcher, started at every logon from the Startup folder (no admin needed).
$vbs = Join-Path $dir 'start-agent.vbs'
@"
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$dir\agent.ps1""", 0, False
"@ | Set-Content $vbs -Encoding ASCII
$startup = [Environment]::GetFolderPath('Startup')
Copy-Item $vbs (Join-Path $startup 'DeviceMonitorAgent.vbs') -Force

Start-Process wscript.exe -ArgumentList "`"$vbs`""
Write-Host "Device Monitor agent installed for $env:COMPUTERNAME -> $hub" -ForegroundColor Green
Write-Host "It will start automatically when you sign in. Uninstall: irm -MaximumRedirection 0 $hub/uninstall.ps1 | iex"
