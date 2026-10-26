#!/usr/bin/env bash
# Device Monitor installer (Linux and macOS). Run:  curl -fsSL "__HUB__/install.sh?token=__TOKEN__" | bash
set -e
HUB='__HUB__'; TOKEN='__TOKEN__'

if [ "$(uname -s)" = "Darwin" ]; then
  # macOS: background LaunchAgent for the current user (starts at login, restarts if it stops).
  DIR="$HOME/Library/Application Support/DeviceMonitorAgent"
  PLIST="$HOME/Library/LaunchAgents/com.devicemonitor.agent.plist"
  mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  curl -fsSL "$HUB/agent-macos.sh" -o "$DIR/agent-macos.sh"; chmod +x "$DIR/agent-macos.sh"
  printf "HUB='%s'\nTOKEN='%s'\n" "$HUB" "$TOKEN" > "$DIR/config"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.devicemonitor.agent</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/agent-macos.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
PLIST
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
  echo "Device Monitor agent for $(scutil --get ComputerName 2>/dev/null || hostname) -> $HUB (LaunchAgent com.devicemonitor.agent)."
  echo "Uninstall: curl -fsSL $HUB/uninstall.sh | bash"
  exit 0
fi

DIR="$HOME/.local/share/device-monitor"
mkdir -p "$DIR"
pkill -f "$DIR/agent.sh" 2>/dev/null || true
curl -fsSL "$HUB/agent.sh" -o "$DIR/agent.sh"; chmod +x "$DIR/agent.sh"
printf "HUB='%s'\nTOKEN='%s'\n" "$HUB" "$TOKEN" > "$DIR/config"

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/device-monitor.service" <<UNIT
[Unit]
Description=Device Monitor agent
After=network-online.target
[Service]
ExecStart=/usr/bin/env bash $DIR/agent.sh
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now device-monitor.service
  loginctl enable-linger "$USER" 2>/dev/null || true   # keep running when logged out
  echo "Installed as systemd user service 'device-monitor'."
else
  (crontab -l 2>/dev/null | grep -v device-monitor; echo "@reboot nohup bash $DIR/agent.sh >/dev/null 2>&1 &") | crontab -
  nohup bash "$DIR/agent.sh" >/dev/null 2>&1 &
  echo "Installed via crontab @reboot."
fi
echo "Device Monitor agent for $(hostname) -> $HUB. Uninstall: curl -fsSL $HUB/uninstall.sh | bash"
