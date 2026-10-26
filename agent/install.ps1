# Device Monitor installer (Windows). Served by the hub with __HUB__ / __TOKEN__ filled in.
# Run:  irm "__HUB__/install.ps1?token=__TOKEN__" | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$hub = '__HUB__'; $token = '__TOKEN__'
$dir = Join-Path $env:LOCALAPPDATA 'DeviceMonitor'
New-Item -ItemType Directory -Force $dir | Out-Null

# Stop a previously installed agent, if any.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*DeviceMonitor\agent.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Invoke-WebRequest "$hub/agent.ps1" -UseBasicParsing -OutFile (Join-Path $dir 'agent.ps1')
@{ hub = $hub; token = $token } | ConvertTo-Json | Set-Content (Join-Path $dir 'config.json') -Encoding ASCII

# Hidden launcher, started at every logon from the Startup folder (no admin needed).
$vbs = Join-Path $dir 'start-agent.vbs'
@"
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$dir\agent.ps1""", 0, False
"@ | Set-Content $vbs -Encoding ASCII
$startup = [Environment]::GetFolderPath('Startup')
Copy-Item $vbs (Join-Path $startup 'DeviceMonitorAgent.vbs') -Force

Start-Process wscript.exe -ArgumentList "`"$vbs`""
Write-Host "Device Monitor agent installed for $env:COMPUTERNAME -> $hub" -ForegroundColor Green
Write-Host "It will start automatically when you sign in. Uninstall: irm $hub/uninstall.ps1 | iex"
