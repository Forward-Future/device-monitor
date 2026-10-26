# Removes the Device Monitor agent from this Windows PC.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*DeviceMonitor\agent.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) 'DeviceMonitorAgent.vbs') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:LOCALAPPDATA 'DeviceMonitor') -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'Device Monitor agent removed. You can delete the device from the dashboard.' -ForegroundColor Green
