#!/usr/bin/env bash
# Device Monitor agent for Linux. Usage: agent.sh <hub-url> <token>  (or config in ~/.local/share/device-monitor/config)
DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$DIR/config" ] && . "$DIR/config"
HUB="${1:-$HUB}"; TOKEN="${2:-$TOKEN}"; INTERVAL="${INTERVAL:-2}"
[ -z "$HUB" ] || [ -z "$TOKEN" ] && { echo "usage: $0 <hub> <token>"; exit 1; }
HUB="${HUB%/}"

ID="$(cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || hostname)"
HOST="$(hostname)"
OS="$( . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-Linux}")"
CPU_NAME="$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ *//')"
[ -z "$CPU_NAME" ] && CPU_NAME="$(lscpu 2>/dev/null | awk -F: '/^Model name/ { sub(/^ +/, "", $2); print $2; exit }')"  # ARM
[ -z "$CPU_NAME" ] && CPU_NAME="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null)"
case "$CPU_NAME" in Neoverse-V2) CPU_NAME="NVIDIA Grace (Neoverse-V2)" ;; esac
MODEL="$(cat /sys/devices/virtual/dmi/id/product_name 2>/dev/null)"
case "$MODEL" in ""|*"To be filled"*|"System Product Name") ;; *) OS="$OS · $MODEL" ;; esac
THREADS="$(grep -c ^processor /proc/cpuinfo)"
esc() { printf '%s' "$1" | tr -d '"\\' | tr -d '[:cntrl:]'; }  # strip chars that would break JSON
num() { [[ "$1" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] && echo "$1" || echo null; }

read_cpu() { awk '/^cpu/ { idle=$5+$6; t=0; for(i=2;i<=NF;i++) t+=$i; print $1, idle, t }' /proc/stat; }
read_net() { awk -F'[: ]+' 'NR>2 && $2!="lo" { rx+=$3; tx+=$11 } END { print rx+0, tx+0 }' /proc/net/dev; }
read_disk() { awk '$3 ~ /^(sd[a-z]+|nvme[0-9]+n[0-9]+|vd[a-z]+|mmcblk[0-9]+)$/ { r+=$6; w+=$10 } END { print r*512, w*512 }' /proc/diskstats; }

cpu_temp() {
  for h in /sys/class/hwmon/hwmon*; do
    case "$(cat "$h/name" 2>/dev/null)" in coretemp|k10temp|zenpower|cpu_thermal|soc_thermal)
      [ -f "$h/temp1_input" ] && { awk '{ printf "%.1f", $1/1000 }' "$h/temp1_input"; return; } ;;
    esac
  done
  # Fall back to the hottest CPU/ACPI thermal zone.
  local max=""
  for z in /sys/class/thermal/thermal_zone*; do
    case "$(cat "$z/type" 2>/dev/null)" in x86_pkg_temp|cpu*|soc*|acpitz)
      t=$(cat "$z/temp" 2>/dev/null); [ -n "$t" ] && { [ -z "$max" ] || [ "$t" -gt "$max" ]; } && max=$t ;;
    esac
  done
  [ -n "$max" ] && awk -v t="$max" 'BEGIN { printf "%.1f", t/1000 }' || echo null
}

PREV_CPU="$(read_cpu)"; PREV_NET="$(read_net)"; PREV_DISK="$(read_disk)"; PREV_T=$(date +%s.%N)
sleep "$INTERVAL"
while true; do
  # Exit with the desktop app that started us (if any).
  if [ -n "$PARENT_PID" ] && ! kill -0 "$PARENT_PID" 2>/dev/null; then exit 0; fi
  T=$(date +%s.%N); CUR_CPU="$(read_cpu)"; CUR_NET="$(read_net)"; CUR_DISK="$(read_disk)"
  CPU_JSON="$(paste -d' ' <(echo "$PREV_CPU") <(echo "$CUR_CPU") | awk '
    { d=$6-$3; u=(d>0)?100*(1-($5-$2)/d):0; if(u<0)u=0; v=sprintf("%.1f",u)
      if($1=="cpu") total=v; else cores=cores (cores==""?"":",") v }
    END { printf "\"usage\":%s,\"cores\":[%s]", total, cores }')"
  SEC=$(awk -v a="$PREV_T" -v b="$T" 'BEGIN{ print b-a }')
  read PRX PTX <<< "$PREV_NET"; read RX TX <<< "$CUR_NET"
  read PRD PWR <<< "$PREV_DISK"; read RD WR <<< "$CUR_DISK"
  RATES="$(awk -v s="$SEC" -v a="$PRX" -v b="$RX" -v c="$PTX" -v d="$TX" -v e="$PRD" -v f="$RD" -v g="$PWR" -v h="$WR" \
    'BEGIN{ printf "\"net\":{\"rx\":%.0f,\"tx\":%.0f},\"diskIO\":{\"read\":%.0f,\"write\":%.0f}", (b-a)/s, (d-c)/s, (f-e)/s, (h-g)/s }')"
  PREV_CPU="$CUR_CPU"; PREV_NET="$CUR_NET"; PREV_DISK="$CUR_DISK"; PREV_T="$T"

  MEM="$(awk '/^MemTotal/ {t=$2} /^MemAvailable/ {a=$2} END { printf "\"total\":%.0f,\"used\":%.0f", t*1024, (t-a)*1024 }' /proc/meminfo)"
  MHZ="$(awk -F: '/cpu MHz/ { s+=$2; n++ } END { if(n) printf "%.0f", s/n; else print "null" }' /proc/cpuinfo)"
  [ "$MHZ" = "null" ] && [ -f /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq ] && MHZ=$(( $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq) / 1000 ))
  UPTIME="$(cut -d. -f1 /proc/uptime)"
  DISKS="$(df -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs -x 9p -x drvfs 2>/dev/null | awk 'NR>1 && $6 !~ /^\/(boot|snap|init$|usr\/lib\/wsl|mnt\/wsl)/ { gsub(/"/,"",$6); printf "%s{\"name\":\"%s\",\"total\":%s,\"used\":%s}", (n++?",":""), $6, $2, $3 }')"

  GPUS=""
  if command -v nvidia-smi >/dev/null 2>&1; then
    while IFS=, read -r name util temp mu mt pw pl fan clk; do
      GPUS="$GPUS${GPUS:+,}{\"name\":\"$(esc "$(echo $name)")\",\"vendor\":\"nvidia\",\"usage\":$(num $(echo $util)),\"temp\":$(num $(echo $temp)),\"memUsed\":$(awk -v v="$mu" 'BEGIN{ if(v+0>0) printf "%.0f", v*1048576; else print "null" }'),\"memTotal\":$(awk -v v="$mt" 'BEGIN{ if(v+0>0) printf "%.0f", v*1048576; else print "null" }'),\"power\":$(num $(echo $pw)),\"powerLimit\":$(num $(echo $pl)),\"fan\":$(num $(echo $fan)),\"clockMHz\":$(num $(echo $clk))}"
    done < <(nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw,power.limit,fan.speed,clocks.gr --format=csv,noheader,nounits 2>/dev/null)
  fi
  for card in /sys/class/drm/card[0-9]; do  # AMD GPUs
    [ -f "$card/device/gpu_busy_percent" ] || continue
    U=$(cat "$card/device/gpu_busy_percent"); MU=$(cat "$card/device/mem_info_vram_used" 2>/dev/null || echo null); MT=$(cat "$card/device/mem_info_vram_total" 2>/dev/null || echo null)
    GT=null; for h in "$card"/device/hwmon/hwmon*/temp1_input; do [ -f "$h" ] && GT=$(awk '{ printf "%.1f", $1/1000 }' "$h"); done
    GPUS="$GPUS${GPUS:+,}{\"name\":\"AMD GPU\",\"vendor\":\"amd\",\"usage\":$U,\"temp\":$GT,\"memUsed\":$MU,\"memTotal\":$MT}"
  done

  BODY="{\"id\":\"$ID\",\"token\":\"$TOKEN\",\"hostname\":\"$(esc "$HOST")\",\"platform\":\"linux\",\"appVersion\":\"$(esc "${DM_APP_VERSION:-}")\",\"os\":\"$(esc "$OS")\",\"uptime\":$UPTIME,\"cpu\":{\"name\":\"$(esc "$CPU_NAME")\",\"threads\":$THREADS,\"clockMHz\":$MHZ,\"temp\":$(cpu_temp),$CPU_JSON},\"memory\":{$MEM},\"gpus\":[$GPUS],\"disks\":[$DISKS],$RATES}"
  curl -fsS -m 5 -X POST -H 'Content-Type: application/json' --data-binary "$BODY" "$HUB/api/report" >/dev/null 2>&1
  sleep "$INTERVAL"
done
