# Device Monitor

A desktop app (Windows and macOS) in the style of NZXT CAM that shows CPU, GPU, memory, temperatures, disks and network for all your machines in one window.

![icon](build/icon.png)

## Install

Run **`dist\Device Monitor Setup <version>.exe`** on Windows (or download it from your hub at `http://<hub>:7777/download`), or **`Device Monitor.dmg`** on a Mac (see [Mac](#mac)). It installs for your user only (no admin), adds Start menu and desktop shortcuts, and opens the app.

On first launch, pick a role:

- **Host the dashboard here** on your main PC. It runs the hub, monitors itself, and serves the dashboard to other devices. Windows asks once for admin approval so other devices can connect.
- **Connect to a hub** on every other PC. Hubs on your network are found automatically, or you can type the address. That PC is then registered and can view the dashboard too.

The app starts when you sign in and opens its window (Windows can take up to a minute after sign-in to start it). Closing the window keeps it monitoring in the system tray. The **⚙ Settings** button (top-right of the app window) lets you:

- see whether this computer hosts or which hub it's connected to
- copy the dashboard link
- change setup (switch between Host and Connect)
- allow network access
- turn start-at-sign-in on or off, or start minimized to the tray instead of opening the window
- turn automatic updates on or off
- quit

The tray menu has the same options.

## Using the dashboard

- **Reorder** cards by dragging the ⋮⋮ grip. The order is saved on the hub, so it's the same on every screen.
- **Chart range**: 10 min / 60 min / 6 h in the header.
- **History**: the History button, a card's ⋯ menu, or clicking a card's chart. Pick 1 h to 30 days, hover to inspect, drag across a chart to zoom, double-click to reset. History is stored on the hub (2-second samples for the last hour, 1-minute averages for 30 days).

## Pushing updates to all your devices

On the PC that hosts the hub, from this folder:

```
npm run release                      # bumps the patch version, builds, signs, publishes
npm run release -- --version 1.4.0   # or choose the version
```

The hub tells every connected app right away. Each app:
1. downloads the installer
2. checks the signature and SHA-256
3. installs silently once you're not using it (at most an hour later)
4. restarts in the background

Progress for each device is in **Settings → Updates**, and each card shows its app version (e.g. `v1.2.3 → 1.2.4` while an update is pending).

- **The release key.** The first `npm run release` creates a signing key at `~/.device-monitor/release-key.pem`. It is not in the repo. **Back it up.** Apps only accept updates signed with it. The public half is `build/update-key.pub.pem` and is built into the app.
- **Macs** can't install updates themselves without an Apple Developer ID, so they show an "update available" notification that opens the download page.
- **Agents installed with the one-line command** (e.g. on Linux servers) aren't the app, so they don't update this way. Re-run the one-liner to refresh them.

## Mac

The Mac app works like the Windows one: install it, choose **Connect to a hub**, and the Mac is registered and can view the dashboard. A Mac can also be the hub.

The Mac app has to be built on macOS (or by GitHub Actions):

```
npm install
npm run dist:mac      # -> dist/Device Monitor.dmg (universal: Apple Silicon + Intel)
```

Or push this folder to GitHub and run the **Build** workflow (`.github/workflows/build.yml`). It produces both the `.dmg` and the Windows installer.

The app isn't notarized, so the first time you open it, **right-click → Open** (or System Settings → Privacy & Security → Open Anyway). CPU and GPU temperatures on a Mac need `brew install smctemp`; everything else works out of the box without sudo.

## Adding devices

- **Another Windows PC**: install the app and choose **Connect**. If you don't want the full app there, use the one-line command from the dashboard's **+ Add device** dialog. It installs a small background agent with no admin rights needed.
- **Mac / Linux without the app**: run the `curl … | bash` command from **+ Add device**. It installs a background agent (a LaunchAgent on macOS, a systemd user service on Linux) with no sudo needed.

## Viewing from a phone, tablet or browser

Open the hub's address, e.g. `http://192.168.1.20:7777`, on anything on the same network. *Copy dashboard link* in the tray menu gives you the address. For access away from home, use [Tailscale](https://tailscale.com).

## Temperatures

| Sensor | Source |
|---|---|
| NVIDIA GPU temp, power, fan, clock, VRAM | `nvidia-smi` (ships with the driver) |
| CPU temp, motherboard sensors, fan RPM (Windows) | [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) running in the background |
| CPU temp (Linux) | `coretemp` / `k10temp` / thermal zones |
| AMD/Intel GPU load (Windows) | Windows GPU performance counters |

Windows doesn't expose CPU temperature to normal apps, which is why LibreHardwareMonitor is needed for it.

## Security

Device Monitor is designed for a trusted home network.

- **Hub access.** Anyone on your network can view the dashboard and rename, reorder or remove devices. Agents need the hub's token to report, but anyone on the LAN can read that token from `/api/info`.
- **Websites can't reach it.** The hub only answers requests addressed to it by IP address, localhost or this computer's own name. That blocks DNS-rebinding attacks from websites you visit. To use a custom DNS name, add it to `"allowedHosts"` in the hub's `config.json`.
- **Strict pages.** Pages are served with a strict Content-Security-Policy, and every metric an agent reports is validated and re-typed by the hub.
- **App updates** are signed (see above), so tampering on the network can't push code to your devices.
- **One-line installs and downloads use plain HTTP.** Only use them on a network you trust.
- **Firewall.** The app opens TCP 7777 (dashboard/API) and UDP 7778 (discovery) on *private* networks only.

## Development

```
npm install
npm start          # run the app from source
npm run dist       # build dist\Device Monitor Setup <version>.exe
npm run dist:mac   # build dist/Device Monitor.dmg (run on a Mac)
npm run hub        # headless hub only (e.g. on a home server), dashboard at :7777
```

| Path | Purpose |
|---|---|
| `main.js` | Electron app: window, tray, setup, host/connect modes, firewall, start with Windows |
| `preload.js`, `app/` | Setup screen and offline screen |
| `server.js` | Hub: API, live stream (SSE), installer scripts, dashboard |
| `discovery.js` | LAN auto-discovery (UDP 7778) |
| `security.js` | Input validation, Host checks (anti DNS-rebinding), CSP headers |
| `updater.js`, `build/release.js` | Signed self-updates from the hub; the release command |
| `history.js` | Metric history (raw last hour + 1-minute averages for 30 days, on disk) |
| `agent-runner.js`, `agent/` | Metric agents (Windows PowerShell, macOS and Linux bash) and their one-line installers |
| `build/test/` | Test fixtures: seeded test hub, macOS command mocks for the Mac agent |
| `public/index.html` | Dashboard UI |
| `build/make-icon.js` | Generates the app and tray icons |

App data is stored in `%APPDATA%\Device Monitor`: `settings.json`, plus `hub\` with the device list and agent token. The installer isn't code-signed, so Windows SmartScreen may show "Windows protected your PC". Click **More info → Run anyway**.
