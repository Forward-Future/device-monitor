#!/usr/bin/env bash
if [ "$(uname -s)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.devicemonitor.agent.plist"
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null
  rm -f "$PLIST"; rm -rf "$HOME/Library/Application Support/DeviceMonitorAgent"
  echo "Device Monitor agent removed."; exit 0
fi
DIR="$HOME/.local/share/device-monitor"
systemctl --user disable --now device-monitor.service 2>/dev/null
rm -f "$HOME/.config/systemd/user/device-monitor.service"
(crontab -l 2>/dev/null | grep -v device-monitor) | crontab - 2>/dev/null
pkill -f "$DIR/agent.sh" 2>/dev/null
rm -rf "$DIR"
echo "Device Monitor agent removed."
