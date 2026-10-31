// Device Monitor desktop app (Electron).
//  - "Host" mode: runs the hub on this PC (dashboard + API on port 7777) and monitors this PC.
//  - "Connect" mode: monitors this PC, reports to a hub elsewhere, and shows that hub's dashboard.
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, clipboard, Notification, session, screen, protocol, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { fileURLToPath } = require('url');
const { startHub } = require('./server');
const sec = require('./security');
const transport = require('./transport');
const { validKey } = require('./access');
const { Readable } = require('node:stream');
protocol.registerSchemesAsPrivileged([{ scheme: 'dmapp', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const { startAgent } = require('./agent-runner');
const tlsOrigin = transport.origin(process.env.DM_HTTPS_ORIGIN);
const inboundPort = process.env.DM_TLS_CERT && process.env.DM_TLS_KEY && tlsOrigin ? Number(new URL(tlsOrigin).port || 443) : null;
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
  clearTimeout(saveSettingsTimer);
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  // Write a temporary file and swap it in, so a crash or power cut can't leave a half-written file.
  // Readable by this user only: in Connect mode the file holds the hub's key.
  const tmp = settingsFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, settingsFile);
}
let saveSettingsTimer = null;
const saveSettingsSoon = () => { clearTimeout(saveSettingsTimer); saveSettingsTimer = setTimeout(saveSettings, 800); };

// ---- Window size and position, kept across restarts ----
// Only reused if it still lands on a connected screen (a monitor may have been unplugged).
function savedBounds() {
  const w = settings.window;
  if (!w || TEST.DM_WINDOW_SIZE || ![w.x, w.y, w.width, w.height].every(Number.isFinite)) return {};
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    Math.min(w.x + w.width, a.x + a.width) - Math.max(w.x, a.x) >= 120 && Math.min(w.y + 40, a.y + a.height) - Math.max(w.y, a.y) >= 20);
  return onScreen ? { x: w.x, y: w.y, width: Math.max(560, w.width), height: Math.max(520, w.height) } : { width: w.width, height: w.height };
}
function rememberWindow() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen() || TEST.DM_WINDOW_SIZE) return;
  settings.window = { ...win.getNormalBounds(), maximized: win.isMaximized() || pendingMaximize };   // still maximized if it was never shown
  saveSettingsSoon();
}

// ---- Dashboard preferences (°C/°F, chart ranges…) ----
// Keep dashboard preferences in the desktop profile across enrollment changes.
const PREF_KEY = /^[a-zA-Z]{1,32}$/;
ipcMain.on('dm:prefs-get', e => { e.returnValue = isTrusted(e) ? settings.dashboardPrefs || {} : {}; });
ipcMain.on('dm:pref-set', (e, k, v) => {
  if (!isTrusted(e) || typeof k !== 'string' || !PREF_KEY.test(k)) return;
  if (v != null && (typeof v !== 'string' || v.length > 20000)) return;
  const prefs = settings.dashboardPrefs || (settings.dashboardPrefs = {});
  if (prefs[k] === (v ?? undefined)) return;
  if (v != null && !(k in prefs) && Object.keys(prefs).length >= 50) return;
  if (v == null) delete prefs[k]; else prefs[k] = v;
  saveSettingsSoon();
});

const DASHBOARD = 'dmapp://dashboard/';
function endpoint() {
  if (settings.mode === 'host' && hub) return { base: 'http://127.0.0.1:' + hub.port, token: hub.localKey };
  const e = settings.enrollment;
  if (settings.mode === 'client' && e) return { base: settings.hubUrl, token: e.client, pin: e.pin };
  return null;
}
async function pairWithHub(link) {
  const u = new URL(String(link).trim());
  const code = new URLSearchParams(u.hash.slice(1)).get('join');
  if (!transport.origin(u.origin) || u.username || u.password || u.pathname !== '/pair' || u.search || !validKey(code)) {
    throw new Error('Paste the complete HTTPS desktop invitation copied from the hub.');
  }
  // The origin comes from the out-of-band invitation, never a discovery
  // result. Bind the actual redemption connection and every later use to it.
  const probe = await transport.hubJson(u.origin, '/api/info');
  if (!probe.pin || probe.json.app !== 'device-monitor') throw new Error('The address is not a verified Device Monitor hub.');
  const { json } = await transport.hubJson(u.origin, '/api/pair', { method: 'POST', token: code, pin: probe.pin });
  if (!validKey(json.client) || !validKey(json.agent) || !sec.isValidId(json.id)) throw new Error('Invalid enrollment response.');
  return { base: u.origin, enrollment: { client: json.client, agent: json.agent, id: json.id, pin: probe.pin } };
}
function offlineFor(e, repair) {
  if (settings.mode !== 'client' || endpoint()?.token !== e.token || !win || win.isDestroyed() || !win.webContents.getURL().startsWith(DASHBOARD)) return;
  win.loadFile(path.join(__dirname,'app','offline.html'), {query:{hub:e.base,repair:repair ? '1' : '0'}}).catch(() => {});
}
function dashboardProtocol() {
  protocol.handle('dmapp', async request => {
    const u = new URL(request.url);
    if (u.host !== 'dashboard') return new Response(null, { status: 403 });
    if (request.method === 'GET' && u.pathname === '/') {
      const html = sec.htmlWithNonce(fs.readFileSync(path.join(__dirname, 'public','index.html'), 'utf8'));
      return new Response(html.body, { headers: { ...sec.BASE_HEADERS, ...html.headers, 'Content-Type':'text/html; charset=utf-8' } });
    }
    if (request.method === 'GET' && u.pathname === '/session.js') return new Response(fs.readFileSync(path.join(__dirname,'public','session.js')), { headers: { 'Content-Type':'text/javascript; charset=utf-8' } });
    const e = endpoint();
    if (!u.pathname.startsWith('/api/') || !e) return new Response(null, { status: 403 });
    try {
      const body = request.body ? await transport.readBytes(request.body, 1e6) : null;
      const stream = u.pathname === '/api/stream' && request.method === 'GET';
      const signal = stream ? request.signal : AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
      const { res } = await transport.hubRequest(e.base, u.pathname + u.search, { ...e, method:request.method, body, stream, signal });
      const live = stream && res.statusCode === 200;
      if (stream && (res.statusCode === 401 || res.statusCode === 403)) offlineFor(e,true);
      const data = live ? Readable.toWeb(res) : await transport.readBytes(res, /^\/api\/(info|update\/)/.test(u.pathname) ? 64 * 1024 : 32 * 1024 * 1024);
      // Only data crosses this boundary. Never forward HTML, redirect, cookies
      // or response headers from a hub into the native application's origin.
      return new Response(data, { status:res.statusCode, headers: { 'Content-Type':live ? 'text/event-stream' : 'application/json', 'X-Content-Type-Options':'nosniff', 'Cache-Control':'no-store', 'Content-Security-Policy':"default-src 'none'; sandbox" } });
    } catch (error) {
      if (u.pathname === '/api/stream' && !request.signal.aborted) offlineFor(e, /identity changed|certificat/i.test(error.message));
      return Response.json({ error:'Cannot reach the enrolled hub. Check HTTPS and its enrolled certificate key.' }, {status:502});
    }
  });
}
async function stopServices() {
  agent?.stop(); hub?.close(); agent = hub = null;
}
async function startServices() {
  await stopServices();
  if (settings.mode === 'host') {
    const fixture = !!TEST.DM_USER_DATA && TEST.DM_FIXTURE_HUB === '1';
    hub = await startHub({ port:fixture ? 0 : PORT, fixture, dataDir:path.join(app.getPath('userData'),'hub'), rootDir:__dirname });
    if (!fixture) agent = startAgent({ hub:'http://127.0.0.1:' + hub.port, token:hub.agentToken, scriptDir:AGENT_DIR, appVersion:app.getVersion() });
  } else if (settings.mode === 'client' && settings.enrollment) {
    const {agent:token, id, pin} = settings.enrollment;
    agent = startAgent({hub:settings.hubUrl, token, deviceId:id, pin, scriptDir:AGENT_DIR, appVersion:app.getVersion()});
  }
  buildTrayMenu();
}

// One elevated prompt permits the explicitly configured TLS listener on the local subnet.
// Remote access over Tailscale doesn't need this (Tailscale hands those connections to the app locally).
const psQuote = s => String(s).replace(/'/g, "''");
// Rules Windows creates from its own "allow this app" prompt let every port in, from any address.
const appRules = exe => `(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -ieq '${psQuote(exe)}' } | Get-NetFirewallRule | Where-Object { $_.DisplayName -ne 'Device Monitor' -and $_.Direction -eq 'Inbound' })`;
function allowFirewall() {
  if (process.platform !== 'win32') return Promise.resolve(true); // macOS prompts by itself when needed
  if (settings.mode !== 'host' || !inboundPort) return Promise.resolve(false);    // only the hub accepts connections
  // The elevated command is passed inline (-EncodedCommand), not via a temp file that other
  // software could swap out between writing it and the user approving the UAC prompt.
  const exe = psQuote(process.execPath);
  const elevated = [
    "try {",
    "  Get-NetFirewallRule -DisplayName 'Device Monitor' -ErrorAction SilentlyContinue | Remove-NetFirewallRule",
    `  ${appRules(process.execPath)} | Remove-NetFirewallRule`,
    // Only the HTTPS dashboard/API port from the local subnet. Every profile,
    // because home networks are often marked Public; the hub also refuses non-local addresses.
    `  New-NetFirewallRule -DisplayName 'Device Monitor' -Direction Inbound -Action Allow -Program '${exe}' -Protocol TCP -LocalPort ${inboundPort} -RemoteAddress LocalSubnet -Profile Any | Out-Null`,
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
// 'ok': our scoped HTTPS rule · 'open': Windows' own rules let more in · 'missing'
function firewallStatus() {
  if (!IS_WIN || !inboundPort || settings.mode !== 'host') return Promise.resolve(null);
  const ps = [
    "$r = @(Get-NetFirewallRule -DisplayName 'Device Monitor' -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' })",
    "$ours = $r.Count -eq 1 -and -not ($r | Where-Object { \"$($_.Profile)\" -ne 'Any' -or ((($_ | Get-NetFirewallAddressFilter).RemoteAddress) -join ',') -ne 'LocalSubnet' })",
    `$open = @(${appRules(process.execPath)} | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' }).Count`,
    "if ($open) { 'open' } elseif ($ours) { 'ok' } else { 'missing' }",
  ].join('; ');
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30e3 },
    (err, out) => resolve(err ? null : String(out).trim())));
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
  // executableWillLaunchAtLogin is Windows-only (false if disabled in Task Manager); Electron reports it false on macOS.
  return s.openAtLogin && (!IS_WIN || s.executableWillLaunchAtLogin !== false);
}

// ---------------------------------------------------------------------------
function createWindow({ show }) {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 560, minHeight: 520, ...savedBounds(),
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
  // maximize() also shows the window, so a hidden start keeps it for the first showWindow().
  pendingMaximize = !!settings.window?.maximized && !TEST.DM_WINDOW_SIZE;
  win.once('ready-to-show', () => { if (show) showWindow(); });
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, rememberWindow);
  if (TEST.DM_SCREENSHOT) {
    win.webContents.on('did-finish-load', () => setTimeout(async () => {
      if (TEST.DM_TEST_JS) await win.webContents.executeJavaScript(TEST.DM_TEST_JS).catch(e => console.error(e));
      await new Promise(r => setTimeout(r, 600));
      fs.writeFileSync(TEST.DM_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    }, Number(TEST.DM_SCREENSHOT_DELAY) || 6000));
  }
  win.on('close', e => {
    rememberWindow(); saveSettings();
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!settings.trayHintShown && Notification.isSupported()) {
      new Notification({ title: 'Device Monitor is still running', body: 'It keeps monitoring in the background. Open it from the tray icon.', icon: ICON }).show();
      settings.trayHintShown = true; saveSettings();
    }
  });
  // A downloaded update waits while the window is on screen; closing it to the tray lets it install.
  win.on('hide', () => { session.defaultSession.flushStorageData(); setTimeout(() => updater?.maybeInstall(), 1500); });
  // The window only ever shows the app's own pages or the configured dashboard; anything else
  // (links, redirects, popups) goes to the default browser, and only if it's a web URL.
  win.webContents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' }; });
  const guard = (e, url) => { if (!isAllowedUrl(url)) { e.preventDefault(); openExternalSafe(url); } };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3 && url.startsWith(DASHBOARD)) {
      win.loadFile(path.join(__dirname, 'app', 'offline.html'), { query: { hub: settings.hubUrl || '' } });

    }
  });
  loadMain();
}

function loadMain() {
  if (!win) return;
  if (!settings.mode) return win.loadFile(path.join(__dirname, 'app', 'setup.html'));
  return win.loadURL(DASHBOARD);
}

let pendingMaximize = false;
function showWindow() {
  if (!win) return createWindow({ show: true });
  if (win.isMinimized()) win.restore();
  if (pendingMaximize) { pendingMaximize = false; win.maximize(); }
  win.show(); win.focus();
}

function shareUrl() {
  return settings.mode === 'host' ? (hub?.publicOrigin() || (hub ? 'http://127.0.0.1:' + hub.port : null)) : settings.hubUrl;
}
async function copyDashboardLink() {
  const e = endpoint(), dest = shareUrl();
  if (!e || !dest) return false;
  const { json } = await transport.hubJson(e.base, '/api/invites', { ...e, method: 'POST', body: JSON.stringify({ kind:'browser', origin:dest }) });
  if (!validKey(json.code)) return false;
  clipboard.writeText(dest + '/unlock#join=' + json.code);
  return true;
}
async function confirmNative(message) {
  if (!win || win.isDestroyed()) return false;
  const result = await dialog.showMessageBox(win, { type:'question', title:'Device Monitor', message, buttons:['Cancel','Continue'], defaultId:0, cancelId:0, noLink:true });
  return result.response === 1;
}
function openVerifiedUpdate() {
  return updater?.openManual(file => shell.openPath(file)).catch(e => console.error('Cannot open update:', e.message));
}
function buildTrayMenu() {
  if (!tray) return;
  const items = [
    { label: 'Open Device Monitor', click: showWindow },
    { type: 'separator' },
  ];
  if (settings.mode) {
    items.push({ label: settings.mode === 'host' ? `Hosting dashboard · ${shareUrl()}` : `Connected to ${settings.hubUrl}`, enabled: false });
    items.push({ label: 'Copy dashboard link', click: () => copyDashboardLink().catch(e => console.error(e.message)) });
    if (settings.mode === 'host' && inboundPort) items.push({ label: 'Allow access from other devices…', click: () => allowFirewall() });
    items.push({ label: 'Change setup…', click: () => { showWindow(); changeSetup(); } });
    items.push({ type: 'separator' });
  }
  if (updater?.status.state === 'ready') items.push({ label: `Restart to update to ${updater.status.version}`, click: () => updater.maybeInstall(true) }, { type: 'separator' });
  else if (updater?.status.state === 'ready-download' && updater.readyFile) items.push({ label: `Open verified update ${updater.status.version}`, click: openVerifiedUpdate }, { type: 'separator' });

  items.push({ label: IS_MAC ? 'Open at login' : 'Start with Windows', type: 'checkbox', checked: startupEnabled(), enabled: app.isPackaged, click: m => setStartup(m.checked) });
  items.push({ label: 'Quit', click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(settings.mode === 'host' ? 'Device Monitor — hosting' : settings.mode === 'client' ? 'Device Monitor — connected' : 'Device Monitor');
}

// ---------------------------------------------------------------------------
// Privileged IPC is available only to this window's bundled pages.
const LOCAL_PAGES = new Set(['setup.html','offline.html'].map(name => path.join(__dirname, 'app', name)));
function isAllowedUrl(url) {
  try {
    if (url.startsWith('file:')) return LOCAL_PAGES.has(fileURLToPath(url));
    const u = new URL(url); return u.protocol === 'dmapp:' && u.host === 'dashboard' && u.pathname === '/';
  } catch { return false; }
}
function isTrusted(event) {
  // Main frame only: an iframe on the dashboard must never reach these APIs.
  return !!win && event.sender === win.webContents && !!event.senderFrame && event.senderFrame === event.sender.mainFrame && isAllowedUrl(event.senderFrame.url);
}
function sendToPage(channel, data) {
  if (win && !win.isDestroyed() && isAllowedUrl(win.webContents.getURL())) win.webContents.send(channel, data);
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
async function changeSetup() { await stopServices(); settings.mode = null; delete settings.enrollment; delete settings.hubUrl; saveSettings(); buildTrayMenu(); loadMain(); }

handle('dm:setup', async (_e, { mode, hubUrl } = {}) => {
  try {
    if (mode === 'host') {
      settings = { ...settings, mode: 'host', hubUrl: null }; delete settings.enrollment;
      if (inboundPort) await allowFirewall(); // before listening, so Windows doesn't show its own (blocking) prompt
      try { await startServices(); } catch (e) {
        settings.mode = null;
        if (e.code === 'EADDRINUSE') {
          return { ok:false, error:'The local hub port is in use. Close the other hub before starting Host mode.' };
        }
        throw e;
      }
    } else {
      const { base, enrollment } = await pairWithHub(hubUrl);
      settings = { ...settings, mode:'client', hubUrl:base, enrollment };
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
handle('dm:change-setup', async () => { if (await confirmNative('Disconnect this computer and change setup?')) await changeSetup(); });
handle('dm:settings', () => ({
  mode: settings.mode, hubUrl: settings.hubUrl, shareUrl: settings.mode ? shareUrl() : null,
  version: app.getVersion(), platform: process.platform,
  startup: startupEnabled(), canSetStartup: app.isPackaged,
  startMinimized: settings.startMinimized === true, canStartMinimized: app.isPackaged && IS_WIN,
  canAllowFirewall: process.platform === 'win32' && settings.mode === 'host' && !!inboundPort,
  update: updater ? updater.status : { state: 'unavailable' },
  autoUpdate: settings.autoUpdate !== false,
  canAutoUpdate: app.isPackaged && IS_WIN && !!UPDATE_KEY,
}));
handle('dm:check-updates', async () => (updater ? updater.check() : { state: 'unavailable' }));
handle('dm:set-auto-update', async (_e, on) => { if (!on && !await confirmNative('Turn off automatic updates on this computer?')) return settings.autoUpdate !== false; settings.autoUpdate = !!on; saveSettings(); if (on) updater?.check(); return settings.autoUpdate; });
handle('dm:install-update', async () => {
  if (!updater) return { state: 'unavailable' };
  const st = await updater.check();
  if (st.state === 'ready') updater.maybeInstall(true);
  else if (st.state === 'ready-download' && updater.readyFile) await openVerifiedUpdate();

  return updater.status;
});
handle('dm:set-startup', async (_e, enabled) => { if (await confirmNative('Change whether Device Monitor starts at sign-in?')) setStartup(!!enabled); buildTrayMenu(); return startupEnabled(); });
handle('dm:set-start-minimized', (_e, on) => { settings.startMinimized = !!on; saveSettings(); return settings.startMinimized; });
handle('dm:allow-firewall', () => allowFirewall());
handle('dm:firewall-status', () => firewallStatus());
handle('dm:copy-link', copyDashboardLink);
handle('dm:quit', async () => { if (await confirmNative('Quit Device Monitor and stop reporting on this computer?')) { quitting = true; app.quit(); } });

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
    if (settings.token || settings.altHubUrls || (settings.mode === 'client' && !settings.enrollment)) {
      delete settings.token; delete settings.altHubUrls;
      if (settings.mode === 'client') { settings.mode = null; delete settings.hubUrl; delete settings.enrollment; }
      saveSettings();
    }
    for (const c of await session.defaultSession.cookies.get({ name: 'dm_key' })) {
      const host = c.domain?.replace(/^\./, '');
      if (host) await session.defaultSession.cookies.remove((c.secure ? 'https://' : 'http://') + host + (c.path || '/'), 'dm_key').catch(() => {});
    }
    dashboardProtocol();
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
      hubUrl: () => endpoint()?.base,
      request: async (url, {signal}) => {
        const e = endpoint(), u = new URL(url);
        if (!e || e.base !== u.origin) throw new Error('Update origin changed');
        const {res} = await transport.hubRequest(e.base, u.pathname + u.search, {pin:e.pin, signal, timeout:60000});
        return new Response(Readable.toWeb(res), {status:res.statusCode});
      },
      canInstall: () => app.isPackaged && IS_WIN && settings.autoUpdate !== false,
      // Platforms without silent install (macOS) still get the verified download, not a browser link.
      manualDownload: () => app.isPackaged && (IS_MAC || IS_WIN) && !!UPDATE_KEY,
      // While the window is on screen the dashboard shows an Update button instead of restarting
      // under the user (the updater still installs on its own after an hour).
      isBusy: () => !!win && win.isVisible() && !win.isMinimized(),
      isVisible: () => !!win && win.isVisible() && !win.isMinimized(),
      onStatus: st => {
        buildTrayMenu();
        sendToPage('dm:update-status', st);
        const showable = st.state === 'ready-download' || (st.state === 'ready' && settings.autoUpdate === false);
        if (showable && st.version !== notifiedVersion && Notification.isSupported()) {
          notifiedVersion = st.version;
          const n = new Notification({ title: `Device Monitor ${st.version} is available`, body: 'Click to install it.', icon: ICON });
          n.on('click', () => st.state === 'ready-download' ? openVerifiedUpdate() : updater.maybeInstall(true)); n.show();
        }
      },
    });
    updater.start();
    const atLogin = process.argv.includes('--startup') || (IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin);
    const hidden = process.argv.includes('--hidden') || (atLogin && settings.startMinimized === true);
    createWindow({ show: !(hidden && settings.mode) });
  });
  app.on('before-quit', () => {
    quitting = true; updater?.stop(); stopServices();
    rememberWindow(); session.defaultSession.flushStorageData();
    try { if (settingsFile) saveSettings(); } catch {}
  });
  app.on('dm-quit-for-update', () => { quitting = true; app.quit(); });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
}
