#!/usr/bin/env bash
# Device Monitor installer (Linux and macOS).
# Run:  curl -fsSL -H "Authorization: Bearer __TOKEN__" "__HUB__/install.sh" | bash
set -e
HUB='__HUB__'; TOKEN='__TOKEN__'
SHA_AGENT='__SHA_AGENT__'; SHA_AGENT_MAC='__SHA_AGENT_MAC__'

# Downloads a file and checks it against the SHA-256 the hub pinned when it issued this
# installer — a tampered or spoofed agent script never runs.
fetch_verified() {
  local url="$1" out="$2" want="$3" got
  curl -fsSL "$url" -o "$out"
  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$out" | cut -d' ' -f1)
  elif command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$out" | cut -d' ' -f1)
  elif command -v openssl >/dev/null 2>&1; then got=$(openssl dgst -sha256 "$out" | awk '{print $NF}')
  else echo "Can't check the agent download (no sha256 tool found) — refusing to install." >&2; rm -f "$out"; exit 1; fi
  if [ "$got" != "$want" ]; then echo "The agent download failed its integrity check — refusing to install." >&2; rm -f "$out"; exit 1; fi
}

if [ "$(uname -s)" = "Darwin" ]; then
  # macOS: background LaunchAgent for the current user (starts at login, restarts if it stops).
  DIR="$HOME/Library/Application Support/DeviceMonitorAgent"
  PLIST="$HOME/Library/LaunchAgents/com.devicemonitor.agent.plist"
  mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  fetch_verified "$HUB/agent-macos.sh" "$DIR/agent-macos.sh" "$SHA_AGENT_MAC"; chmod +x "$DIR/agent-macos.sh"
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
fetch_verified "$HUB/agent.sh" "$DIR/agent.sh" "$SHA_AGENT"; chmod +x "$DIR/agent.sh"
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
