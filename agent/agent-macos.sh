#!/bin/bash
# Device Monitor agent for macOS (Apple Silicon and Intel). No sudo needed.
# Usage: agent-macos.sh <hub-url> <token>   (or HUB/TOKEN in a "config" file next to this script)
# Written for the bash 3.2 and BSD tools that ship with macOS.
DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$DIR/config" ] && . "$DIR/config"
HUB="${1:-$HUB}"; TOKEN="${2:-$TOKEN}"; INTERVAL="${INTERVAL:-2}"
if [ -z "$HUB" ] || [ -z "$TOKEN" ]; then echo "usage: $0 <hub> <token>"; exit 1; fi
HUB="${HUB%/}"
export LC_ALL=C
export PATH="$PATH:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"   # launchd gives a minimal PATH

esc() { printf '%s' "$1" | tr -d '"\\' | tr -d '[:cntrl:]'; }   # strip chars that would break JSON
num() { case "$1" in ''|*[!0-9.-]*) echo null ;; *) echo "$1" ;; esac; }
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time' 2>/dev/null || date +%s; }

ID="$(ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/ { print $4; exit }')"
[ -z "$ID" ] && ID="$(hostname)"
HOST="$(scutil --get ComputerName 2>/dev/null || hostname -s)"
MODEL="$(system_profiler SPHardwareDataType 2>/dev/null | awk -F': ' '/Model Name/ { print $2; exit }')"
OS="macOS $(sw_vers -productVersion 2>/dev/null)"
[ -n "$MODEL" ] && OS="$OS · $MODEL"
CPU_NAME="$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
THREADS="$(sysctl -n hw.logicalcpu 2>/dev/null)"
MEM_TOTAL="$(sysctl -n hw.memsize)"
BOOT="$(sysctl -n kern.boottime | awk -F'[ ,]+' '{ for (i = 1; i <= NF; i++) if ($i == "sec") { print $(i + 2); exit } }')"
# Optional temperature sensors: `brew install smctemp` (Apple Silicon + Intel).
SMCTEMP="$(command -v smctemp 2>/dev/null)"

read_net() { netstat -ibn | awk '$1 ~ /^en/ && $3 ~ /^<Link#/ { rx += $7; tx += $10 } END { printf "%.0f %.0f\n", rx, tx }'; }
read_disk() {
  ioreg -c IOBlockStorageDriver -r -w 0 | awk '
    /"Statistics"/ {
      s = $0
      if (match(s, /"Bytes \(Read\)"=[0-9]+/))  { t = substr(s, RSTART, RLENGTH); sub(/.*=/, "", t); r += t }
      if (match(s, /"Bytes \(Write\)"=[0-9]+/)) { t = substr(s, RSTART, RLENGTH); sub(/.*=/, "", t); w += t }
    }
    END { printf "%.0f %.0f\n", r, w }'
}
cpu_usage() {   # two samples 1s apart; the second one is the real reading
  top -l 2 -n 0 -s 1 | awk '/^CPU usage/ { idle = $7 } END { sub(/%/, "", idle); if (idle == "") print "null"; else printf "%.1f", 100 - idle }'
}
memory_used() {   # like Activity Monitor's "Memory Used": app (active) + wired + compressed
  vm_stat | awk '
    /page size of/ { for (i = 1; i <= NF; i++) if ($i == "of") page = $(i + 1) }
    /^Pages active/ { a = $3 + 0 } /^Pages wired down/ { w = $4 + 0 } /occupied by compressor/ { c = $5 + 0 }
    END { if (!page) page = 4096; printf "%.0f", (a + w + c) * page }'
}
gpus_json() {
  local gtemp="null"
  [ -n "$SMCTEMP" ] && gtemp="$(num "$("$SMCTEMP" -g 2>/dev/null | head -1)")"
  ioreg -r -d 1 -w 0 -c IOAccelerator | awk -v fallback="$(esc "$CPU_NAME") GPU" -v gtemp="$gtemp" '
    function val(s, key,   t) { if (match(s, "\"" key "\"=[0-9]+")) { t = substr(s, RSTART, RLENGTH); sub(/.*=/, "", t); return t } return "" }
    function flush() {
      if (!has) return
      if (name == "") name = fallback
      printf "%s{\"name\":\"%s\",\"vendor\":\"apple\",\"usage\":%s,\"temp\":%s,\"memUsed\":%s,\"memTotal\":null}", (n++ ? "," : ""), name, (util == "" ? "null" : util), gtemp, (mem == "" ? "null" : mem)
      name = ""; util = ""; mem = ""; has = 0
    }
    /\+-o/ { flush(); next }
    /"model" = "/ { s = $0; sub(/.*"model" = "/, "", s); sub(/".*/, "", s); gsub(/[\\"]/, "", s); name = s }
    /"PerformanceStatistics"/ {
      util = val($0, "Device Utilization %"); if (util == "") util = val($0, "GPU Activity\\(%\\)")
      mem = val($0, "In use system memory"); has = 1
    }
    END { flush() }'
}
disks_json() {   # APFS: report the container (total - available), like Finder does
  df -k -l | awk 'NR > 1 {
      mount = $9; for (i = 10; i <= NF; i++) mount = mount " " $i
      if (mount == "/System/Volumes/Data") name = "Macintosh HD"
      else if (mount ~ /^\/Volumes\//) { name = mount; sub(/^\/Volumes\//, "", name) }
      else next
      gsub(/["\\]/, "", name)
      printf "%s{\"name\":\"%s\",\"total\":%.0f,\"used\":%.0f}", (n++ ? "," : ""), name, $2 * 1024, ($2 - $4) * 1024
    }'
}

PREV_NET="$(read_net)"; PREV_DISK="$(read_disk)"; PREV_T="$(now)"
while true; do
  # Exit with the desktop app that started us (if any).
  if [ -n "$PARENT_PID" ] && ! kill -0 "$PARENT_PID" 2>/dev/null; then exit 0; fi
  CPU="$(cpu_usage)"   # takes ~1s
  T="$(now)"; CUR_NET="$(read_net)"; CUR_DISK="$(read_disk)"
  set -- $PREV_NET $CUR_NET $PREV_DISK $CUR_DISK
  RATES="$(awk -v s="$(awk -v a="$PREV_T" -v b="$T" 'BEGIN { d = b - a; print (d > 0 ? d : 1) }')" \
    -v a="$1" -v b="$3" -v c="$2" -v d="$4" -v e="$5" -v f="$7" -v g="$6" -v h="$8" \
    'function rate(x, y) { return (y - x) / s < 0 ? 0 : (y - x) / s }
     BEGIN { printf "\"net\":{\"rx\":%.0f,\"tx\":%.0f},\"diskIO\":{\"read\":%.0f,\"write\":%.0f}", rate(a, b), rate(c, d), rate(e, f), rate(g, h) }')"
  PREV_NET="$CUR_NET"; PREV_DISK="$CUR_DISK"; PREV_T="$T"

  CPU_TEMP="null"
  [ -n "$SMCTEMP" ] && CPU_TEMP="$(num "$("$SMCTEMP" -c 2>/dev/null | head -1)")"
  UPTIME=$(( $(date +%s) - ${BOOT:-$(date +%s)} ))

  BODY="{\"id\":\"$(esc "$ID")\",\"token\":\"$TOKEN\",\"hostname\":\"$(esc "$HOST")\",\"platform\":\"macos\",\"appVersion\":\"$(esc "${DM_APP_VERSION:-}")\",\"os\":\"$(esc "$OS")\",\"uptime\":$UPTIME,\"cpu\":{\"name\":\"$(esc "$CPU_NAME")\",\"threads\":$(num "$THREADS"),\"clockMHz\":null,\"temp\":$CPU_TEMP,\"usage\":$CPU,\"cores\":[]},\"memory\":{\"total\":$MEM_TOTAL,\"used\":$(memory_used)},\"gpus\":[$(gpus_json)],\"disks\":[$(disks_json)],$RATES}"
  curl -fsS -m 5 -X POST -H 'Content-Type: application/json' --data-binary "$BODY" "$HUB/api/report" >/dev/null 2>&1
  sleep $(( INTERVAL > 1 ? INTERVAL - 1 : 1 ))
done
