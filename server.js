// Device Monitor hub: receives metrics from agents and serves the dashboard.
// Embedded by the desktop app (main.js); can also run headless with `node server.js`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { startAgent } = require('./agent-runner');
const discovery = require('./discovery');
const { HistoryStore } = require('./history');
const power = require('./power');
const { Alerts } = require('./alerts');
const tailscale = require('./tailscale');
const sec = require('./security');

const LIVE_HISTORY_MS = 10 * 60 * 1000; // raw samples sent to dashboards on connect
const RANGES = { '10m': 10 * 60e3, '1h': 60 * 60e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
const OFFLINE_MS = 10000;
const MAX_DEVICES = 250;      // caps registry/history growth from bogus reports
const MAX_STREAMS = 64;       // concurrent dashboard connections
const COMMAND_TTL = 60e3;     // power actions not picked up by the device within a minute are dropped
const PROCS_WATCH_MS = 20e3;  // devices send their process list while a dashboard keeps asking
// Static files for the installable phone app (PWA).
const STATIC = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/js/alerts.js': ['alerts.js', 'text/javascript; charset=utf-8'],
  '/js/tools.js': ['tools.js', 'text/javascript; charset=utf-8'],
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
    }
  }
  return out;
}

// Starts the hub. Resolves with { port, token, close } once listening.
function startHub({ port = 7777, dataDir, rootDir = __dirname, assetDir = rootDir } = {}) {
const PORT = port;
const ROOT = assetDir;
const DATA_DIR = dataDir || path.join(rootDir, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
// App installers offered at /download (drop "Device Monitor Setup x.y.z.exe" / ".dmg" files here).
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

function listDownloads() {
  return fs.readdirSync(DOWNLOADS_DIR)
    .filter(f => /\.(exe|dmg|zip)$/i.test(f))
    .map(f => {
      const st = fs.statSync(path.join(DOWNLOADS_DIR, f));
      const platform = /\.exe$/i.test(f) ? 'windows' : 'mac';
      return { name: f, platform, size: st.size, modified: st.mtimeMs };
    })
    .sort((a, b) => b.modified - a.modified);
}

// Signed update manifests (written by `npm run release`). Apps verify the signature themselves;
// the hub just serves them and announces new versions to connected apps.
const UPDATE_PLATFORMS = ['windows', 'mac'];
function readManifest(platform) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(DOWNLOADS_DIR, `update-${platform}.json`), 'utf8'));
    return listDownloads().some(d => d.name === m.file) ? m : null;
  } catch { return null; }
}
let watchTimer = null;
const announceUpdates = () => {
  for (const platform of UPDATE_PLATFORMS) { const m = readManifest(platform); if (m) broadcast({ type: 'update', platform, version: m.version }); }
};
let downloadsWatch = null;
try { downloadsWatch = fs.watch(DOWNLOADS_DIR, () => { clearTimeout(watchTimer); watchTimer = setTimeout(announceUpdates, 2000); }); } catch {}
fs.mkdirSync(DATA_DIR, { recursive: true });

const config = readJson(CONFIG_FILE, {});
if (!config.token) {
  config.token = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// id -> { id, name, hostname, platform, firstSeen, lastSeen }
const registry = Object.create(null);   // null prototype: ids like __proto__ can't reach Object.prototype
for (const [id, d] of Object.entries(readJson(DEVICES_FILE, {}))) if (sec.isValidId(id)) registry[id] = d;
// id -> { latest } (memory only); metric history lives in the HistoryStore
const live = Object.create(null);
const history = new HistoryStore(DATA_DIR);
const commands = new Map();   // id -> [{ id, action, t }] waiting for the device's next report
const procWatch = new Map();  // id -> time until which the device should send its processes

let saveTimer = null;
function saveRegistry() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DEVICES_FILE, JSON.stringify(registry, null, 2), () => {}), 1000);
}

function deviceView(id) {
  const reg = registry[id];
  const l = live[id] || {};
  return {
    ...reg,
    online: Date.now() - (reg.lastSeen || 0) < OFFLINE_MS,
    latest: l.latest || null,
    history: history.recent(id, LIVE_HISTORY_MS),
  };
}

// ---- Server-sent events --------------------------------------------------
const clients = new Set();
function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}
const statusTimer = setInterval(() => {
  // Heartbeat + lets clients notice devices that went offline.
  broadcast({ type: 'status', online: Object.fromEntries(Object.keys(registry).map(id => [id, deviceView(id).online])) });
}, 3000);

// ---- Helpers --------------------------------------------------------------
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { ...sec.BASE_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
  });
}

function sendHtml(res, file) {
  const { body, headers } = sec.htmlWithNonce(fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'));
  res.writeHead(200, { ...sec.BASE_HEADERS, ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// Device ids from URLs: only valid ids that exist.
function deviceFromPath(raw) {
  let id; try { id = decodeURIComponent(raw); } catch { return null; }
  return sec.isValidId(id) && registry[id] ? id : null;
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  // Requests forwarded by tailscale serve also come from 127.0.0.1, but carry X-Forwarded-For and the tailnet name.
  return (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1') && !req.headers['x-forwarded-for'] && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || '');
}

function hubUrlFor(req) {   // Host was validated by hostAllowed()
  return `http://${req.headers.host}`;
}

function template(file, vars) {
  let text = fs.readFileSync(path.join(ROOT, 'agent', file), 'utf8');
  for (const [k, v] of Object.entries(vars)) text = text.split(`__${k}__`).join(v);
  return text;
}

function handleReport(raw) {
  if (!sec.isValidId(raw.id)) throw new Error('invalid id');
  const id = raw.id;
  if (!registry[id] && Object.keys(registry).length >= MAX_DEVICES) throw new Error('too many devices');
  const body = sec.normalizeReport(raw);
  const now = Date.now();
  const nextOrder = () => Math.max(-1, ...Object.values(registry).map(r => r.order ?? -1)) + 1;
  const reg = registry[id] || (registry[id] = { id, name: body.hostname || id, firstSeen: now, order: nextOrder() });
  reg.hostname = body.hostname;
  if (!reg.renamed && body.hostname) reg.name = body.hostname;
  reg.platform = body.platform;
  reg.os = body.os;
  reg.lastSeen = now;
  reg.hw = { formFactor: body.formFactor, threads: body.cpu?.threads };   // for power estimates while offline
  if (body.macs.length) reg.macs = body.macs;                          // for Wake-on-LAN while it's off
  const procs = sec.normalizeProcesses(raw.processes);
  if (procs) (live[id] || (live[id] = {})).procs = { t: now, list: procs };
  body.receivedAt = now;
  body.powerEst = power.estimate(body);

  const l = live[id] || (live[id] = {});
  l.latest = body;
  // Biggest GPU first, so the main gauge shows e.g. the GB300 rather than a small display card.
  if (Array.isArray(body.gpus)) body.gpus.sort((a, b) => (b.memTotal || 0) - (a.memTotal || 0));
  const g = (body.gpus || [])[0] || {};
  const sample = {
    t: now,
    cpu: body.cpu?.usage ?? null,
    gpu: g.usage ?? null,
    mem: body.memory?.total ? (body.memory.used / body.memory.total) * 100 : null,
    cpuTemp: body.cpu?.temp ?? null,
    gpuTemp: g.temp ?? null,
    gpuPower: g.power ?? null,
    power: body.powerEst?.watts ?? null,
    rx: body.net?.rx ?? null, tx: body.net?.tx ?? null,
    dr: body.diskIO?.read ?? null, dw: body.diskIO?.write ?? null,
  };
  history.add(id, sample);
  saveRegistry();
  broadcast({ type: 'report', id, device: { ...reg, online: true, latest: body }, sample });
  if (body.actionResult) broadcast({ type: 'actionResult', id, name: reg.name, result: body.actionResult });
  alerts.onReport(id, body);

  // The reply tells the agent what the dashboards want from it.
  const reply = { ok: true };
  if ((procWatch.get(id) || 0) > now) reply.procs = true;
  const queued = (commands.get(id) || []).filter(c => now - c.t < COMMAND_TTL && body.actions.includes(c.action));
  commands.delete(id);
  if (queued.length) reply.commands = queued.map(({ id: cid, action }) => ({ id: cid, action }));
  return reply;
}

// ---- Remote access (Tailscale) -----------------------------------------------------
let remote = { installed: false };
const refreshRemote = () => tailscale.status(PORT).then(s => { remote = s; }, () => {});
refreshRemote();
const remoteTimer = setInterval(refreshRemote, 60e3);
function preferredHubUrl() {
  if (remote.httpsUrl) return remote.httpsUrl;
  const lan = lanAddresses().find(a => !/vEthernet|WSL|VirtualBox|VMware|Tailscale/i.test(a.name) && !a.address.startsWith('100.'));
  return `http://${lan ? lan.address : os.hostname()}:${PORT}`;
}

// ---- Alerts ---------------------------------------------------------------------------
function costToday(id) {
  if (!config.energy) return null;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const bounds = [start.getTime(), Date.now() + 1];
  const ids = id === '*' ? Object.keys(registry) : registry[id] ? [id] : [];
  const wh = ids.reduce((s, x) => s + usageSummary(x, bounds).wh, 0);
  return { cost: wh / 1000 * config.energy.rate, currency: config.energy.currency };
}
const alerts = new Alerts({
  dataDir: DATA_DIR, broadcast, costToday, hubUrl: preferredHubUrl,
  devices: () => Object.keys(registry).map(id => ({ id, name: registry[id].name, online: Date.now() - (registry[id].lastSeen || 0) < OFFLINE_MS, lastSeen: registry[id].lastSeen })),
});

// ---- Energy and usage totals (Advanced view) --------------------------------
// `bounds` are bucket edges chosen by the dashboard (e.g. local midnights), so days follow the
// viewer's time zone. Each 1-minute history point counts as one minute at its average power.
function usageSummary(id, bounds) {
  const reg = registry[id];
  const from = bounds[0], to = bounds[bounds.length - 1];
  const buckets = new Array(bounds.length - 1).fill(0);
  const acc = {};
  const add = (k, v, max = v) => {
    if (v == null) return;
    const a = acc[k] || (acc[k] = { sum: 0, n: 0, peak: -Infinity });
    a.sum += v; a.n++; if (max != null && max > a.peak) a.peak = max;
  };
  let b = 0, wh = 0, minutes = 0, estimatedMinutes = 0, firstData = null;
  const bytes = { rx: 0, tx: 0, dr: 0, dw: 0 };
  for (const p of history.minutePoints(id, from, to)) {
    if (p.t < from || p.t >= to) continue;
    while (p.t >= bounds[b + 1]) b++;
    minutes++; firstData ??= p.t;
    let w = p.power;
    if (w == null) { w = power.fromSample(p, reg.hw); if (w != null) estimatedMinutes++; }
    if (w != null) { buckets[b] += w / 60; wh += w / 60; add('power', w, p.powerMax ?? w); }
    add('cpu', p.cpu, p.cpuMax); add('gpu', p.gpu, p.gpuMax); add('mem', p.mem);
    add('cpuTemp', p.cpuTemp, p.cpuTempMax); add('gpuTemp', p.gpuTemp, p.gpuTempMax);
    for (const k of Object.keys(bytes)) bytes[k] += (p[k] || 0) * 60;
  }
  const stats = Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, { avg: +(a.sum / a.n).toFixed(1), peak: a.peak === -Infinity ? null : +a.peak.toFixed(1) }]));
  return {
    id, wh: Math.round(wh), buckets: buckets.map(v => Math.round(v * 10) / 10),
    minutes, estimatedMinutes, stats, bytes: Object.fromEntries(Object.entries(bytes).map(([k, v]) => [k, Math.round(v)])),
    firstData,
  };
}

function validEnergySettings(b) {
  if (!b || typeof b !== 'object') return null;
  const region = typeof b.region === 'string' && /^([A-Z]{2}(-[A-Z]{2})?|custom)$/.test(b.region) ? b.region : null;
  const rate = typeof b.rate === 'number' && b.rate > 0 && b.rate <= 1000 ? Math.round(b.rate * 1e4) / 1e4 : null;
  const currency = typeof b.currency === 'string' && /^[A-Z]{3}$/.test(b.currency) ? b.currency : null;
  return region && rate && currency ? { region, rate, currency } : null;
}

// ---- Routes ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (!sec.hostAllowed(req.headers.host, (config.allowedHosts || []).concat(remote.dnsName || []))) {
    return send(res, 421, 'This hub only answers requests addressed to it by IP address or its own name.', 'text/plain');
  }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return sendHtml(res, 'index.html');
    }
    if (req.method === 'GET' && (p === '/download' || p === '/download/')) {
      return sendHtml(res, 'download.html');
    }
    if (req.method === 'GET' && p === '/api/downloads') return send(res, 200, listDownloads());
    if (req.method === 'GET' && Object.hasOwn(STATIC, p)) {
      const [file, type] = STATIC[p];
      res.writeHead(200, { ...sec.BASE_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(ROOT, 'public', file)));
    }
    if (req.method === 'GET' && p.startsWith('/api/update/')) {
      const platform = p.slice('/api/update/'.length);
      const m = UPDATE_PLATFORMS.includes(platform) && readManifest(platform);
      return m ? send(res, 200, m) : send(res, 404, { error: 'no update published' });
    }
    if (req.method === 'GET' && p.startsWith('/download/')) {
      const name = path.basename(decodeURIComponent(p.slice('/download/'.length)));
      const file = listDownloads().find(d => d.name === name);
      if (!file) return send(res, 404, { error: 'not found' });
      res.writeHead(200, {
        ...sec.BASE_HEADERS,
        'Content-Type': 'application/octet-stream',
        'Content-Length': file.size,
        'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
      });
      return fs.createReadStream(path.join(DOWNLOADS_DIR, name)).pipe(res);
    }
    if (req.method === 'GET' && p === '/api/info') {
      return send(res, 200, { token: config.token, port: PORT, addresses: lanAddresses(), hostname: os.hostname(), remote: { urls: remote.urls || [] } });
    }
    if (req.method === 'GET' && p === '/api/devices') {
      return send(res, 200, Object.keys(registry).map(deviceView));
    }
    if (req.method === 'GET' && p === '/api/stream') {
      if (clients.size >= MAX_STREAMS) return send(res, 503, { error: 'too many connections' });
      res.writeHead(200, { ...sec.BASE_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', devices: Object.keys(registry).map(deviceView) })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && p === '/api/report') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || body.token !== config.token) return send(res, 401, { error: 'bad token' });
      return send(res, 200, handleReport(body));
    }
    if (req.method === 'GET' && p === '/api/energy') {
      const bounds = String(url.searchParams.get('bounds') || '').split(',').map(Number);
      const ok = bounds.length >= 2 && bounds.length <= 800 && bounds.every((v, i) => Number.isFinite(v) && (i === 0 || v > bounds[i - 1]))
        && bounds[bounds.length - 1] - bounds[0] <= 32 * 86400e3;
      if (!ok) return send(res, 400, { error: 'bad bounds' });
      return send(res, 200, { bounds, settings: config.energy || null, devices: Object.keys(registry).map(id => usageSummary(id, bounds)) });
    }
    if (req.method === 'GET' && p === '/api/energy/settings') return send(res, 200, config.energy || null);
    if (req.method === 'PUT' && p === '/api/energy/settings') {
      const s = validEnergySettings(await readBody(req));
      if (!s) return send(res, 400, { error: 'invalid settings' });
      config.energy = s;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      broadcast({ type: 'energySettings', settings: s });
      return send(res, 200, s);
    }
    if (req.method === 'GET' && p === '/api/alerts') {
      return send(res, 200, { settings: alerts.settings(), active: alerts.active(), events: alerts.events.slice(-150).reverse(), priceSet: !!config.energy });
    }
    if (req.method === 'PUT' && p === '/api/alerts') {
      const s = alerts.update(await readBody(req));
      return s ? send(res, 200, { settings: s, active: alerts.active() }) : send(res, 400, { error: 'invalid alert settings' });
    }
    if (req.method === 'POST' && p === '/api/alerts/test') return send(res, 200, await alerts.test());
    if (req.method === 'DELETE' && p === '/api/alerts/log') { alerts.events = []; fs.writeFile(path.join(DATA_DIR, 'alerts-log.json'), '[]', () => {}); return send(res, 200, { ok: true }); }
    if (req.method === 'GET' && p === '/api/remote') {
      remote = await tailscale.status(PORT, { fresh: url.searchParams.has('fresh') });
      return send(res, 200, { ...remote, port: PORT, canConfigure: isLoopback(req), platform: process.platform });
    }
    if (req.method === 'POST' && p === '/api/remote/https') {
      // Changes this PC's Tailscale setup, so only the hub PC itself may do it.
      if (!isLoopback(req)) return send(res, 403, { error: 'Turn this on from the Device Monitor app on the hub PC.' });
      const body = await readBody(req);
      const r = await tailscale.setHttps(PORT, body.enable !== false);
      remote = r.status || remote;
      return send(res, 200, r);
    }
    if (req.method === 'PUT' && p === '/api/order') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.filter(id => sec.isValidId(id) && registry[id]) : [];
      ids.forEach((id, i) => { registry[id].order = i; });
      saveRegistry();
      broadcast({ type: 'order', order: Object.fromEntries(Object.values(registry).map(r => [r.id, r.order])) });
      return send(res, 200, { ok: true });
    }
    const hm = p.match(/^\/api\/history\/([^/]+)$/);
    const hid = hm && deviceFromPath(hm[1]);
    if (req.method === 'GET' && hid) {
      const to = Number(url.searchParams.get('to')) || Date.now();
      const range = url.searchParams.get('range');
      const from = Number(url.searchParams.get('from')) || to - (Object.hasOwn(RANGES, range) ? RANGES[range] : RANGES['1h']);
      const points = Math.max(10, Math.min(3000, Number(url.searchParams.get('points')) || 1200));
      return send(res, 200, history.query(hid, from, to, points));
    }
    const pm = p.match(/^\/api\/devices\/([^/]+)\/(processes|action)$/);
    const pid = pm && deviceFromPath(pm[1]);
    if (pid && pm[2] === 'processes' && req.method === 'GET') {
      procWatch.set(pid, Date.now() + PROCS_WATCH_MS);
      const l = live[pid] || {};
      return send(res, 200, { procs: l.procs && Date.now() - l.procs.t < PROCS_WATCH_MS ? l.procs : null, supported: !!l.latest?.features?.includes('procs'), threads: l.latest?.cpu?.threads ?? null });
    }
    if (pid && pm[2] === 'action' && req.method === 'POST') {
      const { action } = await readBody(req);
      const reg = registry[pid], latest = live[pid]?.latest;
      if (action === 'wake') {
        if (!reg.macs?.length) return send(res, 400, { error: "This device hasn't reported a network card address yet." });
        await discovery.wake(reg.macs);
        broadcast({ type: 'actionResult', id: pid, name: reg.name, result: { ok: true, message: 'Wake-up signal sent.' } });
        return send(res, 200, { ok: true });
      }
      if (!sec.ACTIONS.has(action)) return send(res, 400, { error: 'unknown action' });
      if (!deviceView(pid).online) return send(res, 409, { error: `${reg.name} is offline.` });
      if (!latest?.actions?.includes(action)) return send(res, 409, { error: `Remote power control is turned off on ${reg.name}.` });
      const cmd = { id: crypto.randomBytes(6).toString('hex'), action, t: Date.now() };
      commands.set(pid, (commands.get(pid) || []).filter(c => c.action !== action).concat(cmd));
      return send(res, 200, { ok: true, id: cmd.id });
    }
    const m = p.match(/^\/api\/devices\/([^/]+)$/);
    const id = m && deviceFromPath(m[1]);
    if (id) {
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        if (typeof body.name === 'string' && body.name.trim()) { registry[id].name = body.name.trim().slice(0, 60); registry[id].renamed = true; }
        saveRegistry();
        broadcast({ type: 'device', device: deviceView(id) });
        return send(res, 200, deviceView(id));
      }
      if (req.method === 'DELETE') {
        delete registry[id]; delete live[id]; history.remove(id); alerts.removeDevice(id); commands.delete(id); procWatch.delete(id);
        saveRegistry();
        broadcast({ type: 'removed', id });
        return send(res, 200, { ok: true });
      }
    }
    // Installer / agent scripts. The installer needs the token; the raw agent does not contain it.
    if (req.method === 'GET' && (p === '/install.ps1' || p === '/install.sh')) {
      if (url.searchParams.get('token') !== config.token) return send(res, 403, 'echo "Invalid or missing token"\n', 'text/plain');
      return send(res, 200, template(path.basename(p), { HUB: hubUrlFor(req), TOKEN: config.token }), 'text/plain; charset=utf-8');
    }
    if (req.method === 'GET' && (p === '/agent.ps1' || p === '/agent.sh' || p === '/agent-macos.sh' || p === '/uninstall.ps1' || p === '/uninstall.sh')) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'agent', path.basename(p))), 'text/plain; charset=utf-8');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: String(e.message || e) });
  }
});

return new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '::', () => { // dual-stack: IPv4 + IPv6
    const responder = discovery.respond({ port: PORT });
    resolve({
      port: PORT, token: config.token, addresses: lanAddresses(),
      close: () => { alerts.close(); clearInterval(remoteTimer); downloadsWatch?.close(); clearTimeout(watchTimer); history.close(); responder.close(); clearInterval(statusTimer); for (const c of clients) c.destroy(); server.close(); },
    });
  });
});
}

module.exports = { startHub, lanAddresses };

// Headless mode: `node server.js` (e.g. on a home server). Also monitors this machine.
if (require.main === module) {
  const port = Number(process.env.PORT) || 7777;
  startHub({ port }).then(hub => {
    console.log('Device Monitor hub running');
    console.log(`  This PC:       http://localhost:${port}`);
    for (const a of hub.addresses) console.log(`  Other devices: http://${a.address}:${port}   (${a.name})`);
    if (!process.env.NO_LOCAL_AGENT) startAgent({ hub: `http://127.0.0.1:${port}`, token: hub.token, scriptDir: path.join(__dirname, 'agent') });
  }, e => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use — is the hub already running?` : e);
    process.exit(1);
  });
  process.on('SIGINT', () => process.exit());
  process.on('SIGTERM', () => process.exit());
}
