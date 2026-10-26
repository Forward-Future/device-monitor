// Device Monitor desktop app (Electron).
//  - "Host" mode: runs the hub on this PC (dashboard + API on port 7777) and monitors this PC.
//  - "Connect" mode: monitors this PC, reports to a hub elsewhere, and shows that hub's dashboard.
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, clipboard, Notification, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { fileURLToPath } = require('url');
const { startHub, lanAddresses } = require('./server');
const { startAgent } = require('./agent-runner');
const { discover, DISCOVERY_PORT } = require('./discovery');
const { Updater } = require('./updater');

const PORT = 7777;
// Dev-only test hooks (screenshots, isolated profiles); ignored in the installed app.
const TEST = app.isPackaged ? {} : process.env;
const ICON = path.join(__dirname, 'build', 'icon.png');
const IS_MAC = process.platform === 'darwin';
// macOS menu bar icons are monochrome "template" images that adapt to light/dark menu bars.
const TRAY_ICON = path.join(__dirname, 'build', IS_MAC ? 'trayTemplate.png' : 'tray.png');
// PowerShell can't read files inside app.asar, so the agent ships unpacked.
const AGENT_DIR = path.join(__dirname, 'agent').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

let win = null, tray = null, hub = null, agent = null, updater = null, quitting = false;
let installRequested = false;   // "Install now" clicked while automatic updates are off
const IS_WIN = process.platform === 'win32';
// Public half of the release key (see build/release.js); without it, updates are disabled.
const UPDATE_KEY = (() => { try { return fs.readFileSync(path.join(__dirname, 'build', 'update-key.pub.pem'), 'utf8'); } catch { return null; } })();
let settings = {};
let settingsFile;

function loadSettings() {
  // Tolerate a BOM (e.g. if the file was edited by hand) rather than losing the setup.
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8').trim()); } catch { settings = {}; }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

function normalizeHubUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s);
  if (!u.port && u.protocol === 'http:') u.port = String(PORT);
  return u.origin;
}

async function fetchInfo(hubUrl) {
  const res = await fetch(hubUrl + '/api/info', { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const info = await res.json();
  if (!info.token) throw new Error('not a Device Monitor hub');
  return info;
}

function dashboardUrl() {
  return settings.mode === 'host' ? `http://127.0.0.1:${PORT}` : settings.hubUrl;
}

async function stopServices() {
  if (agent) agent.stop();
  if (hub) hub.close();
  agent = hub = null;
}

async function startServices() {
  await stopServices();
  if (settings.mode === 'host') {
    hub = await startHub({ port: PORT, dataDir: path.join(app.getPath('userData'), 'hub'), rootDir: __dirname });
    agent = startAgent({ hub: `http://127.0.0.1:${PORT}`, token: hub.token, scriptDir: AGENT_DIR, appVersion: app.getVersion() });
  } else if (settings.mode === 'client') {
    agent = startAgent({ hub: settings.hubUrl, token: settings.token, scriptDir: AGENT_DIR, appVersion: app.getVersion() });
  }
  buildTrayMenu();
}

// One elevated prompt: allow inbound connections to this app (dashboard + discovery) on private networks.
function allowFirewall() {
  if (process.platform !== 'win32') return Promise.resolve(true); // macOS prompts by itself when needed
  // The elevated command is passed inline (-EncodedCommand), not via a temp file that other
  // software could swap out between writing it and the user approving the UAC prompt.
  const exe = process.execPath.replace(/'/g, "''");
  const elevated = [
    "try {",
    "  Get-NetFirewallRule -DisplayName 'Device Monitor' -ErrorAction SilentlyContinue | Remove-NetFirewallRule",
    // Only what the hub needs, only on private networks: the dashboard/API port and LAN discovery.
    `  New-NetFirewallRule -DisplayName 'Device Monitor' -Direction Inbound -Action Allow -Program '${exe}' -Protocol TCP -LocalPort ${PORT} -Profile Private | Out-Null`,
    `  New-NetFirewallRule -DisplayName 'Device Monitor' -Direction Inbound -Action Allow -Program '${exe}' -Protocol UDP -LocalPort ${DISCOVERY_PORT} -Profile Private | Out-Null`,
    "  exit 0",
    "} catch { exit 1 }",
  ].join("\n");
  const encoded = Buffer.from(elevated, 'utf16le').toString('base64');
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `try { $p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; if ($p.ExitCode -eq 0) { 'ok' } else { 'failed' } } catch { 'denied' }`],
      { windowsHide: true }, (err, stdout) => resolve(!err && String(stdout).trim() === 'ok'));
  });
}

// Sign-in launches pass --startup (the window opens unless "start minimized" is on);
// --hidden is reserved for relaunching in the background after an update.
const LOGIN_ARGS = ['--startup'];
function setStartup(enabled) {
  if (!app.isPackaged) return; // dev runs would register electron.exe
  app.setLoginItemSettings({ openAtLogin: enabled, args: LOGIN_ARGS });
}
function startupEnabled() {
  if (!app.isPackaged) return false;
  const s = app.getLoginItemSettings({ args: LOGIN_ARGS });
  return s.openAtLogin && s.executableWillLaunchAtLogin !== false; // false if disabled in Task Manager
}

// ---------------------------------------------------------------------------
function createWindow({ show }) {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 560, minHeight: 520,
    ...(TEST.DM_WINDOW_SIZE ? (([w, h]) => ({ width: +w, height: +h }))(TEST.DM_WINDOW_SIZE.split('x')) : {}),
    title: 'Device Monitor', icon: ICON, show: false, backgroundColor: '#0d0d0d',
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 24 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0d0d0d', symbolColor: '#c3c2b7', height: 64 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false,
    },
  });
  win.once('ready-to-show', () => { if (show) win.show(); });
  if (TEST.DM_SCREENSHOT) {
    win.webContents.on('did-finish-load', () => setTimeout(async () => {
      if (TEST.DM_TEST_JS) await win.webContents.executeJavaScript(TEST.DM_TEST_JS).catch(e => console.error(e));
      await new Promise(r => setTimeout(r, 600));
      fs.writeFileSync(TEST.DM_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    }, Number(TEST.DM_SCREENSHOT_DELAY) || 6000));
  }
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!settings.trayHintShown && Notification.isSupported()) {
      new Notification({ title: 'Device Monitor is still running', body: 'It keeps monitoring in the background. Open it from the tray icon.', icon: ICON }).show();
      settings.trayHintShown = true; saveSettings();
    }
  });
  // The window only ever shows the app's own pages or the configured dashboard; anything else
  // (links, redirects, popups) goes to the default browser, and only if it's a web URL.
  win.webContents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' }; });
  const guard = (e, url) => { if (!isAllowedUrl(url)) { e.preventDefault(); openExternalSafe(url); } };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3 && !url.startsWith('file:')) win.loadFile(path.join(__dirname, 'app', 'offline.html'), { query: { hub: settings.hubUrl || '' } });
  });
  loadMain();
}

function loadMain() {
  if (!win) return;
  if (!settings.mode) win.loadFile(path.join(__dirname, 'app', 'setup.html'));
  else win.loadURL(dashboardUrl());
}

function showWindow() {
  if (!win) return createWindow({ show: true });
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function shareUrl() {
  if (settings.mode !== 'host') return settings.hubUrl;
  const lan = lanAddresses().find(a => !/vEthernet|WSL|VirtualBox|VMware/i.test(a.name)) || lanAddresses()[0];
  return `http://${lan ? lan.address : os.hostname()}:${PORT}`;
}

function buildTrayMenu() {
  if (!tray) return;
  const items = [
    { label: 'Open Device Monitor', click: showWindow },
    { type: 'separator' },
  ];
  if (settings.mode) {
    items.push({ label: settings.mode === 'host' ? `Hosting dashboard · ${shareUrl()}` : `Connected to ${settings.hubUrl}`, enabled: false });
    items.push({ label: 'Copy dashboard link', click: () => clipboard.writeText(shareUrl()) });
    if (settings.mode === 'host') items.push({ label: 'Allow access from other devices…', click: () => allowFirewall() });
    items.push({ label: 'Change setup…', click: () => { showWindow(); changeSetup(); } });
    items.push({ type: 'separator' });
  }
  if (updater?.status.state === 'ready') items.push({ label: `Restart to update to ${updater.status.version}`, click: () => updater.maybeInstall(true) }, { type: 'separator' });
  else if (updater?.status.state === 'available') items.push({ label: `Download update ${updater.status.version}…`, click: () => openExternalSafe(updater.status.downloadUrl) }, { type: 'separator' });
  items.push({ label: IS_MAC ? 'Open at login' : 'Start with Windows', type: 'checkbox', checked: startupEnabled(), enabled: app.isPackaged, click: m => setStartup(m.checked) });
  items.push({ label: 'Quit', click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(settings.mode === 'host' ? 'Device Monitor — hosting' : settings.mode === 'client' ? 'Device Monitor — connected' : 'Device Monitor');
}

// ---------------------------------------------------------------------------
// IPC is only honoured for the app's own pages (setup/offline) and the configured dashboard.
const APP_PAGES_DIR = path.join(__dirname, 'app') + path.sep;
function isAllowedUrl(url) {
  try {
    if (url.startsWith('file:')) return fileURLToPath(url).startsWith(APP_PAGES_DIR);
    return !!settings.mode && new URL(url).origin === new URL(dashboardUrl()).origin;
  } catch { return false; }
}
function isTrusted(event) {
  // Main frame only: an iframe on the dashboard must never reach these APIs.
  return !!event.senderFrame && event.senderFrame === event.sender.mainFrame && isAllowedUrl(event.senderFrame.url);
}
function openExternalSafe(url) {
  try { const u = new URL(url); if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href); } catch {}
}
// localOnly: only the app's bundled pages (setup/offline screens), never the hub's dashboard.
function handle(channel, fn, { localOnly = false } = {}) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrusted(event)) throw new Error('not allowed from this page');
    if (localOnly && !event.senderFrame.url.startsWith('file:')) throw new Error('not allowed from this page');
    return fn(event, ...args);
  });
}
async function changeSetup() { await stopServices(); settings.mode = null; saveSettings(); buildTrayMenu(); loadMain(); }

handle('dm:discover', () => discover(1500), { localOnly: true });
handle('dm:setup', async (_e, { mode, hubUrl } = {}) => {
  try {
    if (mode === 'host') {
      settings = { ...settings, mode: 'host', hubUrl: null, token: null };
      await allowFirewall(); // before listening, so Windows doesn't show its own (blocking) prompt
      try { await startServices(); } catch (e) {
        settings.mode = null;
        if (e.code === 'EADDRINUSE') {
          // Something already serves 7777 here — if it's a hub, just connect to it.
          try { const info = await fetchInfo(`http://127.0.0.1:${PORT}`); return { ok: false, error: `A Device Monitor hub is already running on this PC (port ${PORT}). Close it or choose "Connect" with address 127.0.0.1.`, info: !!info }; }
          catch { return { ok: false, error: `Port ${PORT} is already used by another program.` }; }
        }
        throw e;
      }
    } else {
      const url = normalizeHubUrl(hubUrl);
      if (!url) return { ok: false, error: 'Enter the hub address, e.g. 192.168.1.20' };
      let info;
      try { info = await fetchInfo(url); } catch (e) { return { ok: false, error: `Couldn't reach a hub at ${url} (${e.message}). Check the address and that the hub PC is on.` }; }
      settings = { ...settings, mode: 'client', hubUrl: url, token: info.token };
      await startServices();
    }
    saveSettings();
    if (settings.startupConfigured !== true) { setStartup(true); settings.startupConfigured = true; saveSettings(); }
    buildTrayMenu();
    setTimeout(loadMain, 300);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}, { localOnly: true });
handle('dm:retry', () => loadMain(), { localOnly: true });
handle('dm:change-setup', () => changeSetup());
handle('dm:settings', () => ({
  mode: settings.mode, hubUrl: settings.hubUrl, shareUrl: settings.mode ? shareUrl() : null,
  version: app.getVersion(), platform: process.platform,
  startup: startupEnabled(), canSetStartup: app.isPackaged,
  startMinimized: settings.startMinimized === true, canStartMinimized: app.isPackaged && IS_WIN,
  canAllowFirewall: process.platform === 'win32' && settings.mode === 'host',
  update: updater ? updater.status : { state: 'unavailable' },
  autoUpdate: settings.autoUpdate !== false,
  canAutoUpdate: app.isPackaged && IS_WIN && !!UPDATE_KEY,
}));
handle('dm:check-updates', async () => (updater ? updater.check() : { state: 'unavailable' }));
handle('dm:set-auto-update', (_e, on) => { settings.autoUpdate = !!on; saveSettings(); if (on) updater?.check(); return settings.autoUpdate; });
handle('dm:install-update', async () => {
  if (!updater) return { state: 'unavailable' };
  installRequested = true;
  const st = await updater.check();
  if (st.state === 'ready') updater.maybeInstall(true);
  else if (st.state === 'available' && st.downloadUrl) openExternalSafe(st.downloadUrl);
  return updater.status;
});
handle('dm:set-startup', (_e, enabled) => { setStartup(!!enabled); buildTrayMenu(); return startupEnabled(); });
handle('dm:set-start-minimized', (_e, on) => { settings.startMinimized = !!on; saveSettings(); return settings.startMinimized; });
handle('dm:allow-firewall', () => allowFirewall());
handle('dm:copy-link', () => { const u = shareUrl(); if (u) clipboard.writeText(u); return u; });
handle('dm:quit', () => { quitting = true; app.quit(); });

// ---------------------------------------------------------------------------
// Dev/test hook: isolated profile (must be set before taking the single-instance lock).
if (TEST.DM_USER_DATA) app.setPath('userData', TEST.DM_USER_DATA);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow); // macOS: clicking the Dock icon
  app.setAppUserModelId('com.devicemonitor.app');
  app.whenReady().then(async () => {
    settingsFile = path.join(app.getPath('userData'), 'settings.json');
    loadSettings();
    // Up to 1.2.3 the sign-in entry launched with --hidden; re-register it with the current args.
    if (app.isPackaged && IS_WIN && app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin) setStartup(true);
    // The dashboard needs no browser permissions (camera, location, notifications…).
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    const trayImage = nativeImage.createFromPath(TRAY_ICON);
    if (IS_MAC) trayImage.setTemplateImage(true);
    tray = new Tray(trayImage);
    tray.on('click', showWindow);
    buildTrayMenu();
    if (settings.mode) {
      try { await startServices(); } catch (e) { console.error('failed to start services', e); }
    }
    let notifiedVersion = null;
    updater = new Updater({
      app, publicKeyPem: UPDATE_KEY, dir: path.join(app.getPath('userData'), 'updates'),
      hubUrl: () => (settings.mode === 'host' ? `http://127.0.0.1:${PORT}` : settings.mode === 'client' ? settings.hubUrl : null),
      canInstall: () => app.isPackaged && IS_WIN && (settings.autoUpdate !== false || installRequested),
      isBusy: () => !!win && win.isVisible() && !win.isMinimized() && win.isFocused(),
      isVisible: () => !!win && win.isVisible() && !win.isMinimized(),
      onStatus: st => {
        buildTrayMenu();
        if (st.state === 'available' && st.version !== notifiedVersion && Notification.isSupported()) {
          notifiedVersion = st.version;
          const n = new Notification({ title: `Device Monitor ${st.version} is available`, body: 'Click to download it from your hub.', icon: ICON });
          n.on('click', () => openExternalSafe(st.downloadUrl)); n.show();
        }
      },
    });
    updater.start();
    const atLogin = process.argv.includes('--startup') || (IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin);
    const hidden = process.argv.includes('--hidden') || (atLogin && settings.startMinimized === true);
    createWindow({ show: !(hidden && settings.mode) });
  });
  app.on('before-quit', () => { quitting = true; updater?.stop(); stopServices(); });
  app.on('dm-quit-for-update', () => { quitting = true; app.quit(); });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
}
