// Device Monitor hub: receives metrics from agents and serves the dashboard.
// Embedded by the desktop app (main.js); can also run headless with `node server.js`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { startAgent } = require('./agent-runner');
const discovery = require('./discovery');
const { HistoryStore } = require('./history');
const power = require('./power');
const { Alerts } = require('./alerts');
const { readJson, writeJson } = require('./safe-json');
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

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
    }
  }
  return out;
}

// Lets an app check that a hub knows its key before sending the key (see main.js hubAnswers).
const hubProof = (token, nonce) => crypto.createHmac('sha256', String(token)).update('device-monitor-hub:' + nonce).digest('hex');

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

let dlCache = { at: 0, list: [] };
function listDownloads() {
  if (Date.now() - dlCache.at < 5000) return dlCache.list;   // statSync'ing the dir per request is free DDoS work
  const manifests = {};
  for (const platform of ['windows', 'mac']) {
    try { manifests[platform] = JSON.parse(fs.readFileSync(path.join(DOWNLOADS_DIR, `update-${platform}.json`), 'utf8')); } catch {}
  }
  const list = fs.readdirSync(DOWNLOADS_DIR)
    .filter(f => /\.(exe|dmg|zip)$/i.test(f))
    .map(f => {
      const st = fs.statSync(path.join(DOWNLOADS_DIR, f));
      const platform = /\.exe$/i.test(f) ? 'windows' : 'mac';
      // The signed manifest's hash lets a user verify a browser download by hand.
      const m = manifests[platform];
      const sha256 = m && m.file === f && /^[0-9a-f]{64}$/.test(m.sha256 || '') ? m.sha256 : null;
      return { name: f, platform, size: st.size, modified: st.mtimeMs, sha256 };
    })
    .sort((a, b) => b.modified - a.modified);
  dlCache = { at: Date.now(), list };
  return list;
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
  writeJson(CONFIG_FILE, config);
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
  saveTimer = setTimeout(() => { saveTimer = null; writeJson(DEVICES_FILE, registry); }, 1000);
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

function sendHtml(res, file, status = 200, vars = {}) {
  let html = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
  for (const [k, v] of Object.entries(vars)) html = html.split(`<!--${k}-->`).join(v);
  const { body, headers } = sec.htmlWithNonce(html);
  res.writeHead(status, { ...sec.BASE_HEADERS, ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
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

// ---- Rate limiting ----------------------------------------------------------------------
// The endpoints that don't need the key (install commands, downloads, hub info, pairing) get a
// cheap per-IP allowance, so a noisy LAN peer can't make the hub stream installers nonstop.
const RATE_WINDOW_MS = 60e3, RATE_MAX = 120;
const rates = new Map();
const RATE_MAX_KEYS = 5000;   // distinct addresses tracked at once
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function rateOk(req) {
  // Tailscale serve hands every tailnet client over from 127.0.0.1 with X-Forwarded-For, so on a
  // loopback connection the forwarded address is the real client. From anywhere else the header is
  // whatever the peer typed: honouring it would let a LAN client dodge the limit (and grow this
  // table without bound) just by rotating it, so those are keyed on the socket address.
  const addr = req.socket.remoteAddress || '';
  const fwd = LOOPBACK.has(addr) ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  let ip = net.isIP(fwd) ? fwd : addr;
  const now = Date.now();
  let r = rates.get(ip);
  if (!r && rates.size >= RATE_MAX_KEYS) { ip = addr; r = rates.get(ip); }   // table full: share the socket's allowance
  if (!r || now - r.at > RATE_WINDOW_MS) { r = { at: now, n: 0 }; rates.set(ip, r); }
  return ++r.n <= RATE_MAX;
}
const rateTimer = setInterval(() => { const cut = Date.now() - RATE_WINDOW_MS; for (const [ip, r] of rates) if (r.at < cut) rates.delete(ip); }, RATE_WINDOW_MS).unref();
const MAX_DL_STREAMS = 8;
let dlStreams = 0;

// ---- Access --------------------------------------------------------------------------
// The dashboard and its API need the hub's key (the pairing token) — including on the hub PC
// itself, so another local process or user can't take over the hub through loopback.
// Browsers get it once from a dashboard link (/?key=…) and keep it in a cookie; the desktop app
// sends it as a cookie or an Authorization header. Agents only use it to report.
const keyOk = k => sec.safeEqual(k, config.token);
function requestKey(req) {
  const auth = String(req.headers.authorization || '');
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : sec.cookie(req.headers.cookie, 'dm_key');
}
const authorized = req => keyOk(requestKey(req));
const keyCookie = req => `dm_key=${config.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;

// Desktop apps join with a short one-time code shown in the hub's Add device dialog, so the key
// itself never has to be typed. One code at a time; it expires after 10 minutes or 5 wrong tries.
const PAIR_MS = 10 * 60e3;
let pairing = null;

function hubUrlFor(req) {   // Host was validated by hostAllowed()
  // Through `tailscale serve` the request arrives as HTTPS with X-Forwarded-Proto and a bare
  // ts.net Host — render the matching https origin, not a dead http://<host> (port 80).
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers.host}`;
}

// Fills __NAME__ placeholders in an install script. Values land inside single-quoted strings
// (PowerShell or bash), so a quote in a value can never end the string early.
function template(file, vars) {
  let text = fs.readFileSync(path.join(ROOT, 'agent', file), 'utf8');
  const quote = v => (file.endsWith('.ps1') ? String(v).replace(/'/g, "''") : String(v).replace(/'/g, "'\\''"));
  for (const [k, v] of Object.entries(vars)) text = text.split(`__${k}__`).join(quote(v));
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
  // Each queued action is HMAC-signed so an agent can tell a queued command from a LAN MITM
  // injecting one into the plain-HTTP reply. Agents verify before executing.
  if (queued.length) reply.commands = queued.map(({ id: cid, action }) => ({
    id: cid, action,
    sig: crypto.createHmac('sha256', String(config.token)).update(`device-monitor-cmd:${cid}:${action}`).digest('hex'),
  }));
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
  const cost = ids.reduce((s, x) => s + usageSummary(x, bounds).cost, 0);
  return { cost, currency: config.energy.currency };
}
const alerts = new Alerts({
  dataDir: DATA_DIR, broadcast, costToday, hubUrl: preferredHubUrl,
  devices: () => Object.keys(registry).map(id => ({ id, name: registry[id].name, online: Date.now() - (registry[id].lastSeen || 0) < OFFLINE_MS, lastSeen: registry[id].lastSeen })),
});

// ---- Energy and usage totals (Advanced view) --------------------------------
// `bounds` are bucket edges chosen by the dashboard (e.g. local midnights), so days follow the
// viewer's time zone. Each 1-minute history point counts as one minute at its average power.
// Cost uses the rate in force at each minute (time-of-use periods are in the hub's local time).
function rateAt(t, e = config.energy) {
  if (!e) return null;
  if (!e.tou?.length) return e.rate;
  const d = new Date(t), h = d.getHours() + d.getMinutes() / 60;
  return e.tou.find(p => h >= p.from && h < p.to)?.rate ?? e.rate;
}
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
  const costBuckets = new Array(bounds.length - 1).fill(0);
  let b = 0, wh = 0, cost = 0, minutes = 0, estimatedMinutes = 0, firstData = null;
  const bytes = { rx: 0, tx: 0, dr: 0, dw: 0 };
  for (const p of history.minutePoints(id, from, to)) {
    if (p.t < from || p.t >= to) continue;
    while (p.t >= bounds[b + 1]) b++;
    minutes++; firstData ??= p.t;
    let w = p.power;
    if (w == null) { w = power.fromSample(p, reg.hw); if (w != null) estimatedMinutes++; }
    if (w != null) {
      buckets[b] += w / 60; wh += w / 60; add('power', w, p.powerMax ?? w);
      const c = w / 60 / 1000 * (rateAt(p.t) || 0); costBuckets[b] += c; cost += c;
    }
    add('cpu', p.cpu, p.cpuMax); add('gpu', p.gpu, p.gpuMax); add('mem', p.mem);
    add('cpuTemp', p.cpuTemp, p.cpuTempMax); add('gpuTemp', p.gpuTemp, p.gpuTempMax);
    for (const k of Object.keys(bytes)) bytes[k] += (p[k] || 0) * 60;
  }
  const stats = Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, { avg: +(a.sum / a.n).toFixed(1), peak: a.peak === -Infinity ? null : +a.peak.toFixed(1) }]));
  return {
    id, wh: Math.round(wh), buckets: buckets.map(v => Math.round(v * 10) / 10),
    cost: config.energy ? +cost.toFixed(4) : null, costBuckets: config.energy ? costBuckets.map(v => +v.toFixed(4)) : null,
    minutes, estimatedMinutes, stats, bytes: Object.fromEntries(Object.entries(bytes).map(([k, v]) => [k, Math.round(v)])),
    firstData,
  };
}

function validEnergySettings(b) {
  if (!b || typeof b !== 'object') return null;
  const region = typeof b.region === 'string' && /^([A-Z]{2}(-[A-Z]{2})?|custom)$/.test(b.region) ? b.region : null;
  const rate = typeof b.rate === 'number' && b.rate > 0 && b.rate <= 1000 ? Math.round(b.rate * 1e4) / 1e4 : null;
  const currency = typeof b.currency === 'string' && /^[A-Z]{3}$/.test(b.currency) ? b.currency : null;
  if (!(region && rate && currency)) return null;
  // Optional time-of-use periods: [{ from, to, rate }] in local hours (0–24, from < to); `rate` covers every other hour.
  if (b.tou == null || (Array.isArray(b.tou) && !b.tou.length)) return { region, rate, currency };
  if (!Array.isArray(b.tou) || b.tou.length > 12) return null;
  const hour = v => typeof v === 'number' && v >= 0 && v <= 24 ? Math.round(v * 4) / 4 : null;
  const tou = [];
  for (const p of b.tou) {
    const from = hour(p?.from), to = hour(p?.to);
    const r = typeof p?.rate === 'number' && p.rate > 0 && p.rate <= 1000 ? Math.round(p.rate * 1e4) / 1e4 : null;
    if (from == null || to == null || from >= to || !r) return null;
    tou.push({ from, to, rate: r });
  }
  return { region, rate, currency, tou: tou.sort((x, y) => x.from - y.from) };
}

// ---- Routes ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (!sec.hostAllowed(req.headers.host, (config.allowedHosts || []).concat(remote.dnsName || []))) {
    return send(res, 421, 'This hub only answers requests addressed to it by IP address or its own name.', 'text/plain');
  }
  if (!sec.isLocalAddress(req.socket.remoteAddress)) {
    return send(res, 403, 'This hub only accepts connections from your own network and Tailscale.', 'text/plain');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sec.sameOrigin(req)) return send(res, 403, { error: 'cross-site request refused' });
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // ---- open to anyone on the network ----
    // (rate-limited: these paths run before the key check)
    const open = p === '/' || p === '/index.html' || p === '/download' || p === '/download/' || p.startsWith('/download/') || p.startsWith('/api/update/')
      || p === '/api/downloads' || p === '/api/info' || p === '/api/pair' || p === '/install.ps1' || p === '/install.sh'
      || p === '/agent.ps1' || p === '/agent.sh' || p === '/agent-macos.sh' || p === '/uninstall.ps1' || p === '/uninstall.sh' || Object.hasOwn(STATIC, p);
    if (open && !authorized(req) && !rateOk(req)) return send(res, 429, { error: 'too many requests' });
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      let key = url.searchParams.get('key');
      if (key != null) {   // a dashboard link: keep the key in a cookie and take it out of the address bar
        key = (key.match(/[?&]key=([^&#\s]+)/)?.[1] || key).trim();   // the whole link pasted into the box
        if (!keyOk(key)) return sendHtml(res, 'locked.html', 403, { ERROR: '<p class="err">That link or key isn’t valid for this hub.</p>' });
        res.writeHead(302, { ...sec.BASE_HEADERS, 'Set-Cookie': keyCookie(req), Location: '/', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return authorized(req) ? sendHtml(res, 'index.html') : sendHtml(res, 'locked.html', 401);
    }
    if (req.method === 'GET' && (p === '/download' || p === '/download/')) {
      return sendHtml(res, 'download.html');
    }
    if (req.method === 'GET' && p === '/api/downloads') return send(res, 200, listDownloads());
    if (req.method === 'GET' && Object.hasOwn(STATIC, p)) {
      const [file, type] = STATIC[p];
      let data; try { data = fs.readFileSync(path.join(ROOT, 'public', file)); } catch { return send(res, 404, { error: 'not found' }); }
      res.writeHead(200, { ...sec.BASE_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return res.end(data);
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
      if (dlStreams >= MAX_DL_STREAMS) return send(res, 503, { error: 'too many downloads in progress' });
      dlStreams++;
      res.writeHead(200, {
        ...sec.BASE_HEADERS,
        'Content-Type': 'application/octet-stream',
        'Content-Length': file.size,
        'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
      });
      res.on('close', () => dlStreams--);
      return fs.createReadStream(path.join(DOWNLOADS_DIR, name)).on('error', () => res.destroy()).pipe(res);
    }
    if (req.method === 'GET' && p === '/api/info') {
      if (!authorized(req)) {
        const nonce = url.searchParams.get('nonce');
        const proof = nonce && /^[a-f0-9]{16,64}$/.test(nonce) ? hubProof(config.token, nonce) : undefined;
        return send(res, 200, { app: 'device-monitor', hostname: os.hostname(), port: PORT, locked: true, proof });
      }
      return send(res, 200, { token: config.token, port: PORT, addresses: lanAddresses(), hostname: os.hostname(), remote: { urls: remote.urls || [] } });
    }
    if (req.method === 'POST' && p === '/api/report') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || !keyOk(body.token)) return send(res, 401, { error: 'bad token' });
      return send(res, 200, handleReport(body));
    }
    if (req.method === 'POST' && p === '/api/pair') {
      const { code } = await readBody(req);
      if (!pairing || Date.now() > pairing.expires) return send(res, 403, { error: 'No pairing code is active. On the hub, click + (Add device) → Desktop app to get one.' });
      if (!sec.safeEqual(String(code ?? '').replace(/\D/g, ''), pairing.code)) {
        if (++pairing.tries >= 5) pairing = null;
        return send(res, 403, { error: pairing ? 'Wrong pairing code.' : 'Wrong pairing code. Too many tries: get a new code from the hub.' });
      }
      pairing = null;
      broadcast({ type: 'paired' });
      return send(res, 200, { token: config.token });
    }
    // Installer / agent scripts. The installer needs the token (sent as a Bearer header — the
    // ?token= form still works for old commands but keeps the key out of URLs going forward).
    // The reply pins the agent script's SHA-256 so the installer can check the second download.
    if (req.method === 'GET' && (p === '/install.ps1' || p === '/install.sh')) {
      if (!keyOk(url.searchParams.get('token') || requestKey(req))) return send(res, 403, 'echo "Invalid or missing token"\n', 'text/plain');
      const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'agent', f))).digest('hex');
      return send(res, 200, template(path.basename(p), {
        HUB: hubUrlFor(req), TOKEN: config.token, SHA_AGENT: sha256('agent.sh'), SHA_AGENT_MAC: sha256('agent-macos.sh'), SHA_AGENT_PS1: sha256('agent.ps1'),
      }), 'text/plain; charset=utf-8');
    }
    if (req.method === 'GET' && (p === '/agent.ps1' || p === '/agent.sh' || p === '/agent-macos.sh' || p === '/uninstall.ps1' || p === '/uninstall.sh')) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'agent', path.basename(p))), 'text/plain; charset=utf-8');
    }

    // ---- everything else needs the key ----
    if (!authorized(req)) return send(res, 401, { error: 'This dashboard is locked. Open it with the dashboard link from the Device Monitor app.' });
    if (req.method === 'POST' && p === '/api/pair/code') {
      pairing = { code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), expires: Date.now() + PAIR_MS, tries: 0 };
      return send(res, 200, { code: pairing.code, expires: pairing.expires });
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
      writeJson(CONFIG_FILE, config);
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
    if (req.method === 'DELETE' && p === '/api/alerts/log') { alerts.events = []; writeJson(path.join(DATA_DIR, 'alerts-log.json'), [], 0); return send(res, 200, { ok: true }); }
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
      // Only finite numbers: "Infinity" or "1e999" would otherwise turn into NaN bucket times.
      const qnum = k => { const v = url.searchParams.get(k); const n = v ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
      const to = qnum('to') ?? Date.now();
      const range = url.searchParams.get('range');
      const from = qnum('from') ?? to - (Object.hasOwn(RANGES, range) ? RANGES[range] : RANGES['1h']);
      const points = Math.max(10, Math.min(3000, qnum('points') || 1200));
      if (from >= to) return send(res, 400, { error: 'bad range' });
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
        const name = typeof body.name === 'string' ? sec.cleanText(body.name, 60) : null;   // no control characters
        if (name) { registry[id].name = name; registry[id].renamed = true; }
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
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (res.headersSent) res.destroy();   // never let one bad request take the hub down
    else send(res, 400, { error: String(e.message || e) });
  }
});

return new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '::', () => { // dual-stack: IPv4 + IPv6
    const responder = discovery.respond({ port: PORT });
    resolve({
      port: PORT, token: config.token, addresses: lanAddresses(),
      close: () => { if (saveTimer) { clearTimeout(saveTimer); writeJson(DEVICES_FILE, registry); } alerts.close(); clearInterval(remoteTimer); clearInterval(rateTimer); downloadsWatch?.close(); clearTimeout(watchTimer); history.close(); responder.close(); clearInterval(statusTimer); for (const c of clients) c.destroy(); server.close(); },
    });
  });
});
}

module.exports = { startHub, lanAddresses, hubProof };

// Headless mode: `node server.js` (e.g. on a home server). Also monitors this machine.
if (require.main === module) {
  const port = Number(process.env.PORT) || 7777;
  startHub({ port }).then(hub => {
    console.log('Device Monitor hub running');
    console.log(`  This PC:       http://localhost:${port}/?key=${hub.token}   (open this link once — the key goes in a cookie)`);
    for (const a of hub.addresses) console.log(`  Other devices: http://${a.address}:${port}/?key=${hub.token}   (${a.name})`);
    if (!process.env.NO_LOCAL_AGENT) startAgent({ hub: `http://127.0.0.1:${port}`, token: hub.token, scriptDir: path.join(__dirname, 'agent') });
  }, e => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use — is the hub already running?` : e);
    process.exit(1);
  });
  process.on('SIGINT', () => process.exit());
  process.on('SIGTERM', () => process.exit());
}
