// Bridges the desktop app to its pages (setup screen, offline screen and the dashboard).
// The main process only honours these calls from the app's own pages and the configured hub.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deviceMonitorApp', {
  discover: () => ipcRenderer.invoke('dm:discover'),
  setup: opts => ipcRenderer.invoke('dm:setup', opts),
  retry: () => ipcRenderer.invoke('dm:retry'),
  changeSetup: () => ipcRenderer.invoke('dm:change-setup'),
  getSettings: () => ipcRenderer.invoke('dm:settings'),
  setStartup: enabled => ipcRenderer.invoke('dm:set-startup', !!enabled),
  setStartMinimized: on => ipcRenderer.invoke('dm:set-start-minimized', !!on),
  allowFirewall: () => ipcRenderer.invoke('dm:allow-firewall'),
  firewallStatus: () => ipcRenderer.invoke('dm:firewall-status'),
  copyLink: () => ipcRenderer.invoke('dm:copy-link'),
  quit: () => ipcRenderer.invoke('dm:quit'),
  checkForUpdates: () => ipcRenderer.invoke('dm:check-updates'),
  setAutoUpdate: on => ipcRenderer.invoke('dm:set-auto-update', !!on),
  installUpdate: () => ipcRenderer.invoke('dm:install-update'),
  onUpdateStatus: cb => { ipcRenderer.on('dm:update-status', (_e, status) => cb(status)); },
  // Dashboard preferences kept by the app (read once, synchronously, before the page's script runs).
  prefs: (() => { try { return ipcRenderer.sendSync('dm:prefs-get'); } catch { return null; } })(),
  setPref: (k, v) => ipcRenderer.send('dm:pref-set', String(k), v == null ? null : String(v)),
});

// Lets pages make room for the native window buttons and drag the window by its header.
window.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('app-window', 'platform-' + process.platform));
