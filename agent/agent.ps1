# Device Monitor agent for Windows. Collects metrics and posts them to the hub.
# Usage: agent.ps1 -Hub http://192.168.1.10:7777 -Token <token>
#        (or put hub/token in config.json next to this script)
param(
  [string]$Hub,
  [string]$Token,
  [int]$Interval = 2,
  [int]$ParentPid = 0   # set by the desktop app: exit when the app goes away
)
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$cfgPath = Join-Path $PSScriptRoot 'config.json'
if (-not $Token -and $env:DM_TOKEN) { $Token = $env:DM_TOKEN }   # set by the desktop app
if ((-not $Hub -or -not $Token) -and (Test-Path $cfgPath)) {
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  if (-not $Hub) { $Hub = $cfg.hub }
  if (-not $Token) { $Token = $cfg.token }
}
if (-not $Hub -or -not $Token) { Write-Error 'Hub and Token are required'; exit 1 }
$Hub = $Hub.TrimEnd('/')

$deviceId = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography').MachineGuid
if (-not $deviceId) { $deviceId = $env:COMPUTERNAME }

$osInfo = Get-CimInstance Win32_OperatingSystem
$cpuInfo = Get-CimInstance Win32_Processor | Select-Object -First 1
$osName = "$($osInfo.Caption)".Replace('Microsoft ', '')
$nvsmi = (Get-Command nvidia-smi -ErrorAction SilentlyContinue).Source
if (-not $nvsmi -and (Test-Path "$env:SystemRoot\System32\nvidia-smi.exe")) { $nvsmi = "$env:SystemRoot\System32\nvidia-smi.exe" }
# Laptops/tablets (chassis types: portable, laptop, notebook, sub-notebook, tablet, convertible, detachable...)
$chassis = @((Get-CimInstance Win32_SystemEnclosure).ChassisTypes)
$formFactor = if ($chassis | Where-Object { $_ -in 8, 9, 10, 11, 12, 14, 18, 21, 30, 31, 32 }) { 'laptop' } else { 'desktop' }
$videoControllers = @(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Basic|Virtual|Remote|Mirage|Parsec' })

function Num($v) { if ($null -eq $v -or "$v" -match 'N/A|Not Supported|\[') { return $null }; try { return [double]$v } catch { return $null } }

$prevCpu = $null; $prevNet = $null; $prevDisk = $null; $prevTime = $null

# Temperatures/fans from LibreHardwareMonitor or OpenHardwareMonitor (if running).
function Get-HwSensors {
  foreach ($ns in 'root/LibreHardwareMonitor', 'root/OpenHardwareMonitor') {
    $s = Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction SilentlyContinue
    if ($s) { return $s }
  }
  return $null
}

# AI models loaded in Ollama, LM Studio or ComfyUI (checked every 5th report).
function Get-GpuProcessMemory([int[]]$ids) {
  $total = 0.0
  foreach ($c in Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory) {
    if ($c.Name -match '^pid_(\d+)_' -and [int]$Matches[1] -in $ids) { $total += [double]$c.DedicatedUsage }
  }
  if ($total -gt 0) { return $total } else { return $null }
}
function Get-AiModels {
  $groups = @()
  # Only ask apps that are listening (a refused connection to localhost takes ~1 s on Windows).
  $ports = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port })
  if ($ports -contains 11434) { try {
    $j = Invoke-RestMethod 'http://127.0.0.1:11434/api/ps' -TimeoutSec 1
    if ($j.models) {
      $vram = 0.0; foreach ($m in $j.models) { $vram += [double]$m.size_vram }
      $groups += [ordered]@{ app = 'Ollama'; mem = $(if ($vram) { $vram } else { $null })
        models = @($j.models | ForEach-Object { [ordered]@{ name = $_.name; size = [double]$_.size } }) }
    }
  } catch { } }
  $lms = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
  $lmsProcs = @(Get-Process -Name 'LM Studio', 'llmster' -ErrorAction SilentlyContinue)
  if ((Test-Path $lms) -and $lmsProcs.Count) {
    $arr = @((& $lms ps --json 2>$null | Out-String | ConvertFrom-Json) | ForEach-Object { $_ })
    if ($arr.Count) {
      $groups += [ordered]@{ app = 'LM Studio'; mem = Get-GpuProcessMemory $lmsProcs.Id
        models = @($arr | ForEach-Object { [ordered]@{ name = $(if ($_.displayName) { $_.displayName } else { $_.identifier }); size = [double]$_.sizeBytes } }) }
    }
  }
  if ($ports -contains 8188) { try {
    # ComfyUI doesn't list what it holds in memory; use the loaders of the last workflow it ran.
    $h = Invoke-RestMethod 'http://127.0.0.1:8188/history?max_items=1' -TimeoutSec 1
    $owner = (Get-NetTCPConnection -LocalPort 8188 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    $roots = @(Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'ComfyUI\models')
    if ($owner) {
      $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$owner").CommandLine
      if ($cmd -match '"?([^"]*?)main\.py') { $roots = @((Join-Path $Matches[1] 'models')) + $roots }
    }
    $models = @(); $names = @{}
    foreach ($item in $h.PSObject.Properties.Value) {
      if ($item.prompt.Count -lt 3) { continue }
      foreach ($node in $item.prompt[2].PSObject.Properties.Value) {
        if ("$($node.class_type)" -notmatch 'Loader') { continue }
        foreach ($p in $node.inputs.PSObject.Properties) {
          if ($p.Name -notlike '*_name' -or $p.Value -isnot [string] -or $names[$p.Value]) { continue }
          $names[$p.Value] = 1; $size = $null
          foreach ($r in $roots) {
            $f = Get-ChildItem -Path $r -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName $p.Value } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
            if ($f) { $size = [double](Get-Item -LiteralPath $f).Length; break }
          }
          $models += [ordered]@{ name = $p.Value; size = $size; kind = $p.Name -replace '_name$', '' }
        }
      }
    }
    if ($models.Count) { $groups += [ordered]@{ app = 'ComfyUI'; mem = $(if ($owner) { Get-GpuProcessMemory $owner } else { $null }); models = $models } }
  } catch { } }
  return ,$groups
}
$ai = @(); $aiTick = 0

while ($true) {
  if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
  $now = [DateTime]::UtcNow
  $payload = [ordered]@{
    id = $deviceId; token = $Token; hostname = $env:COMPUTERNAME; platform = 'windows'; os = $osName
    uptime = [int]((Get-Date) - $osInfo.LastBootUpTime).TotalSeconds; formFactor = $formFactor
  }
  if ($env:DM_APP_VERSION) { $payload.appVersion = $env:DM_APP_VERSION }   # set when run by the desktop app

  # ---- CPU (raw counters -> exact deltas) ----
  $raw = Get-CimInstance Win32_PerfRawData_PerfOS_Processor
  $cur = @{}; foreach ($r in $raw) { $cur[$r.Name] = @($r.PercentProcessorTime, $r.Timestamp_Sys100NS) }
  $usage = $null; $cores = @()
  if ($prevCpu) {
    $calc = { param($n) $a = $cur[$n]; $b = $prevCpu[$n]; if (-not $a -or -not $b) { return $null }
      $dt = [double]($a[1] - $b[1]); if ($dt -le 0) { return $null }
      [math]::Round([math]::Max(0, [math]::Min(100, 100 * (1 - ([double]($a[0] - $b[0]) / $dt)))), 1) }
    $usage = & $calc '_Total'
    $cores = @($cur.Keys | Where-Object { $_ -ne '_Total' } | Sort-Object { [int]$_ } | ForEach-Object { & $calc $_ })
  }
  $prevCpu = $cur
  $clock = (Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'")
  $mhz = $null
  if ($clock -and $clock.PercentProcessorPerformance) { $mhz = [math]::Round($cpuInfo.MaxClockSpeed * $clock.PercentProcessorPerformance / 100) }
  $cpu = [ordered]@{ name = "$($cpuInfo.Name)".Trim(); usage = $usage; cores = $cores; threads = $cpuInfo.NumberOfLogicalProcessors; clockMHz = $mhz; temp = $null }

  # ---- Memory ----
  $os = Get-CimInstance Win32_OperatingSystem
  $memTotal = [double]$os.TotalVisibleMemorySize * 1024
  $memory = [ordered]@{ total = $memTotal; used = $memTotal - [double]$os.FreePhysicalMemory * 1024 }

  # ---- GPUs ----
  $gpus = @()
  if ($nvsmi) {
    $lines = & $nvsmi --query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw,power.limit,fan.speed,clocks.gr --format=csv,noheader,nounits 2>$null
    foreach ($line in @($lines)) {
      $f = "$line".Split(',') | ForEach-Object { $_.Trim() }
      if ($f.Count -lt 9) { continue }
      $gpus += [ordered]@{ name = $f[0]; vendor = 'nvidia'; usage = Num $f[1]; temp = Num $f[2]
        memUsed = if (Num $f[3]) { (Num $f[3]) * 1MB } else { $null }; memTotal = if (Num $f[4]) { (Num $f[4]) * 1MB } else { $null }
        power = Num $f[5]; powerLimit = Num $f[6]; fan = Num $f[7]; clockMHz = Num $f[8] }
    }
  }
  if ($gpus.Count -eq 0) {
    # Generic fallback (AMD/Intel): Windows GPU engine counters.
    $eng = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object { $_.Name -match 'engtype_3D' }
    $mem = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory
    $byLuid = @{}
    foreach ($e in $eng) { if ($e.Name -match 'luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)') { $byLuid[$Matches[1]] += [double]$e.UtilizationPercentage } }
    $i = 0
    foreach ($luid in ($byLuid.Keys | Sort-Object)) {
      $m = $mem | Where-Object { $_.Name -match $luid } | Select-Object -First 1
      $vc = $videoControllers[[math]::Min($i, [math]::Max(0, $videoControllers.Count - 1))]
      if (-not $m -or ($byLuid[$luid] -eq 0 -and $m.DedicatedUsage -lt 1MB)) { continue }
      $gpus += [ordered]@{ name = if ($vc) { $vc.Name } else { 'GPU' }; vendor = 'generic'; usage = [math]::Min(100, [math]::Round($byLuid[$luid], 1)); temp = $null
        memUsed = [double]$m.DedicatedUsage; memTotal = if ($vc -and $vc.AdapterRAM -gt 0) { [double]$vc.AdapterRAM } else { $null } }
      $i++
    }
  }

  # ---- Temperatures from hardware monitor ----
  $temps = @(); $fans = @()
  $sensors = Get-HwSensors
  if ($sensors) {
    $cpuP = $sensors | Where-Object { $_.SensorType -eq 'Power' -and $_.Parent -match 'cpu' -and $_.Name -match 'Package' } | Select-Object -First 1
    if ($cpuP -and $cpuP.Value -gt 0) { $payload.power = [ordered]@{ cpu = [math]::Round($cpuP.Value, 1) } }
    foreach ($s in $sensors) {
      if ($s.SensorType -eq 'Temperature') { $temps += [ordered]@{ name = $s.Name; parent = $s.Parent; value = [math]::Round($s.Value, 1) } }
      elseif ($s.SensorType -eq 'Fan' -and $s.Value -gt 0) { $fans += [ordered]@{ name = $s.Name; rpm = [math]::Round($s.Value) } }
    }
    $cpuT = $sensors | Where-Object { $_.SensorType -eq 'Temperature' -and $_.Parent -match 'cpu' -and $_.Name -match 'Package|Tctl|Tdie|CPU Total|Core Average' } | Select-Object -First 1
    if ($cpuT) { $cpu.temp = [math]::Round($cpuT.Value, 1) }
    foreach ($g in $gpus) {
      if ($null -eq $g.temp) {
        $gt = $sensors | Where-Object { $_.SensorType -eq 'Temperature' -and $_.Parent -match 'gpu' -and $_.Name -match 'GPU Core|GPU Temperature' } | Select-Object -First 1
        if ($gt) { $g.temp = [math]::Round($gt.Value, 1) }
      }
    }
  }
  if ($null -eq $cpu.temp) {
    $tz = Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation | Where-Object { $_.HighPrecisionTemperature -gt 0 } | Select-Object -First 1
    if ($tz) { $cpu.temp = [math]::Round($tz.HighPrecisionTemperature / 10 - 273.15, 1); $cpu.tempSource = 'acpi' }
  }

  # ---- Disks ----
  $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
    [ordered]@{ name = $_.DeviceID; label = $_.VolumeName; total = [double]$_.Size; used = [double]$_.Size - [double]$_.FreeSpace } })

  # ---- Network / disk throughput (raw counters, delta per second) ----
  $netRaw = Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface
  $net = @{ rx = 0.0; tx = 0.0 }; foreach ($n in $netRaw) { $net.rx += [double]$n.BytesReceivedPersec; $net.tx += [double]$n.BytesSentPersec }
  $dRaw = Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
  $disk = @{ read = [double]$dRaw.DiskReadBytesPersec; write = [double]$dRaw.DiskWriteBytesPersec }
  $netRate = $null; $diskRate = $null
  if ($prevTime) {
    $sec = ($now - $prevTime).TotalSeconds
    if ($sec -gt 0) {
      $netRate = [ordered]@{ rx = [math]::Max(0, ($net.rx - $prevNet.rx) / $sec); tx = [math]::Max(0, ($net.tx - $prevNet.tx) / $sec) }
      $diskRate = [ordered]@{ read = [math]::Max(0, ($disk.read - $prevDisk.read) / $sec); write = [math]::Max(0, ($disk.write - $prevDisk.write) / $sec) }
    }
  }
  $prevNet = $net; $prevDisk = $disk; $prevTime = $now

  $payload.cpu = $cpu; $payload.memory = $memory; $payload.gpus = $gpus; $payload.disks = $disks
  $payload.net = $netRate; $payload.diskIO = $diskRate; $payload.temps = $temps; $payload.fans = $fans
  if ($aiTick++ % 5 -eq 0) { $ai = Get-AiModels }
  $payload.ai = $ai

  if ($null -ne $usage) {
    try {
      $json = $payload | ConvertTo-Json -Depth 6 -Compress
      Invoke-RestMethod -Uri "$Hub/api/report" -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($json)) -ContentType 'application/json' -TimeoutSec 5 | Out-Null
    } catch { }
  }
  $elapsed = ([DateTime]::UtcNow - $now).TotalMilliseconds
  Start-Sleep -Milliseconds ([math]::Max(200, $Interval * 1000 - $elapsed))
}
