// Device Monitor hub: receives metrics from agents and serves the dashboard.
// Embedded by the desktop app (main.js); can also run headless with `node server.js`.
const http = require('http');
const https = require('https');
const { pipeline } = require('node:stream/promises');
const transport = require('./transport');
const { Access, bearer, localOperatorLink } = require('./access');
const { mac } = require('./desktop-identity');
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
  '/session.js': ['session.js', 'text/javascript; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
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

// Starts the hub. Resolves with { port, token, close } once listening.
function startHub({ port = 7777, dataDir, rootDir = __dirname, assetDir = rootDir, fixture = false, headlessInvites = false, publicUrl = fixture ? null : process.env.DM_HTTPS_ORIGIN, tlsOptions, proxyCertFile = fixture ? null : process.env.DM_TLS_PROXY_CERT } = {}) {
let PORT = port;
const configuredOrigin = transport.origin(publicUrl);
if (publicUrl && !configuredOrigin) throw new Error('DM_HTTPS_ORIGIN must be a bare HTTPS origin');
const certPath = !fixture && process.env.DM_TLS_CERT, keyPath = !fixture && process.env.DM_TLS_KEY;
if (certPath || keyPath) {
  if (!certPath || !keyPath || !configuredOrigin) throw new Error('Set DM_HTTPS_ORIGIN, DM_TLS_CERT and DM_TLS_KEY together');
  tlsOptions = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}
if (tlsOptions && !configuredOrigin) throw new Error('TLS listener requires an HTTPS origin');
if (tlsOptions && (Number(new URL(configuredOrigin).port) || 443) === PORT) throw new Error('Choose different ports for HTTPS and the local HTTP listener');
const ROOT = assetDir;
const DATA_DIR = dataDir || path.join(rootDir, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
// App installers offered at /download (drop "Device Monitor Setup x.y.z.exe" / ".dmg" files here).
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true, mode: 0o700 });

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
const access = new Access(config, CONFIG_FILE);

// id -> { id, name, hostname, platform, firstSeen, lastSeen }
const registry = Object.create(null);   // null prototype: ids like __proto__ can't reach Object.prototype
for (const [id, d] of Object.entries(readJson(DEVICES_FILE, {}))) if (sec.isValidId(id)) registry[id] = d;
// id -> { latest } (memory only); metric history lives in the HistoryStore
const live = Object.create(null);
const history = new HistoryStore(DATA_DIR, Object.keys(registry));
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
const clients = new Map();
const STREAM_BUDGET = 256 * 1024;
function broadcast(msg) {
  const data = 'data: ' + JSON.stringify(msg) + '\n\n';
  for (const [res, client] of clients) {
    if (!client.permitted()) { res.destroy(); continue; }
    if (client.queue) {
      if (client.bytes > STREAM_BUDGET) { res.destroy(); continue; }
      client.bytes += Buffer.byteLength(data);
      client.queue.push(data);
    } else if (res.writableLength > STREAM_BUDGET) {
      res.destroy();
    } else { res.write(data); }
  }
}
async function snapshotChunk(res, data) {
  if (res.destroyed) throw new Error('Stream closed');
  if (res.write(data)) return;
  await new Promise((resolve, reject) => {
    const done = () => { res.off('drain', drain); res.off('close', close); };
    const drain = () => { done(); resolve(); };
    const close = () => { done(); reject(new Error('Stream closed')); };
    res.once('drain', drain); res.once('close', close);
  });
}
async function streamDashboard(req, res) {
  if (clients.size >= MAX_STREAMS) return send(res, 503, { error: 'too many connections' });
  const client = { permitted: () => isDashboard(principal(req)), queue: [], bytes: 0 };
  clients.set(res, client); res.once('close', () => clients.delete(res));
  res.setTimeout(15000, () => res.destroy());
  res.writeHead(200, { ...sec.BASE_HEADERS, 'Content-Type':'text/event-stream', 'Cache-Control':'no-store', Connection:'keep-alive' });
  // Preserve the existing snapshot event without materializing a whole fleet per socket.
  await snapshotChunk(res, 'data: {"type":"snapshot","devices":[');
  let separator = '';
  for (const id of Object.keys(registry)) {
    if (!registry[id]) continue;
    if (!client.permitted()) { res.destroy(); return; }
    await snapshotChunk(res, separator + JSON.stringify(deviceView(id)));
    separator = ',';
  }
  await snapshotChunk(res, ']}\n\n');
  while (client.queue.length) {
    const chunk = client.queue.shift(); client.bytes -= Buffer.byteLength(chunk);
    await snapshotChunk(res, chunk);
  }
  client.queue = null;
}
const statusTimer = setInterval(() => {
  // Heartbeat + lets clients notice devices that went offline.
  broadcast({ type: 'status', online: Object.fromEntries(Object.keys(registry).map(id => [id, Date.now() - (registry[id].lastSeen || 0) < OFFLINE_MS])) });
}, 3000);

// ---- Helpers --------------------------------------------------------------
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { ...sec.BASE_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...(status >= 400 ? { Connection: 'close' } : {}) });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

let activeBodies = 0;
const bodyPeers = new Map();
async function readBody(req, limit = 1e6) {
  const peer = peerAddress(req), count = bodyPeers.get(peer) || 0;
  if (count >= 4 || activeBodies >= 32) throw Object.assign(new Error('Too many active requests'), { status: 429 });
  if (Number(req.headers['content-length']) > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
  const initial = principal(req);
  activeBodies++; bodyPeers.set(peer, count + 1);
  const timer = setTimeout(() => req.destroy(), 10000);
  try {
    const bytes = await transport.readBytes(req, limit);
    const current = principal(req);
    if (initial && (!current || current.role !== initial.role || current.id !== initial.id)) throw Object.assign(new Error('Credential revoked'), {status:401});
    return bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
  } finally {
    clearTimeout(timer); activeBodies--;
    const left = bodyPeers.get(peer) - 1;
    if (left) bodyPeers.set(peer, left); else bodyPeers.delete(peer);
  }
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
  if (!r && rates.size >= RATE_MAX_KEYS) { ip = 'overflow'; r = rates.get(ip); }   // table full: share the socket's allowance
  if (!r || now - r.at > RATE_WINDOW_MS) { r = { at: now, n: 0 }; rates.set(ip, r); }
  return ++r.n <= RATE_MAX;
}
const rateTimer = setInterval(() => { const cut = Date.now() - RATE_WINDOW_MS; for (const [ip, r] of rates) if (r.at < cut) rates.delete(ip); }, RATE_WINDOW_MS).unref();
const MAX_DL_STREAMS = 8;
let dlStreams = 0;

const directLocal = req => isLoopback(req);
const localOrigin = () => 'http://127.0.0.1:' + PORT;
function publicOrigin() { return configuredOrigin || transport.origin(remote.httpsUrl); }
function audience(req) {
  if (directLocal(req) && !req.socket.encrypted && !req.headers['x-forwarded-proto']) return localOrigin();
  const expected = publicOrigin();
  if (!expected || String(req.headers.host || '').toLowerCase() !== new URL(expected).host) return null;
  if (req.socket.encrypted) return expected;
  // Only a locally configured HTTPS proxy may assert transport security.
  const peer = String(req.headers['x-forwarded-for'] || '').trim();
  return LOOPBACK.has(req.socket.remoteAddress) && req.headers['x-forwarded-proto'] === 'https' &&
    net.isIP(peer) && sec.isLocalAddress(peer) ? expected : null;
}

// A forwarded request cannot tell us which key terminated TLS. Never sign a
// pin from a client, a forwarded header or a DNS lookup of the public origin.
async function servedTlsPin(req, dest) {
  if (req.socket.encrypted) return transport.publicKeyPin(req.socket.getCertificate());
  const host = new URL(dest).hostname.replace(/^\[|\]$/g, '');
  let pem;
  if (proxyCertFile) {
    const stat = await fs.promises.stat(proxyCertFile);
    if (stat.isFile() && stat.size <= 65536) pem = await fs.promises.readFile(proxyCertFile);
  } else if (!fixture && transport.origin(remote.httpsUrl) === dest && remote.dnsName?.toLowerCase() === host) {
    pem = await tailscale.publicCertificate(host);
  }
  if (!pem) return null;
  const cert = new crypto.X509Certificate(pem), now = Date.now();
  if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now ||
      !(net.isIP(host) ? cert.checkIP(host) : cert.checkHost(host))) return null;
  return transport.publicKeyPin(cert);
}
const principal = req => access.principal(bearer(req), directLocal(req));
const isDashboard = who => who && ['root', 'operator', 'client', 'browser'].includes(who.role);
const lastReport = new Map();
const downloadsByPeer = new Map();
const peerAddress = req => LOOPBACK.has(req.socket.remoteAddress) && net.isIP(req.headers['x-forwarded-for'] || '') ?
  req.headers['x-forwarded-for'] : req.socket.remoteAddress;

// Fills __NAME__ placeholders in an install script. Values land inside single-quoted strings
// (PowerShell or bash), so a quote in a value can never end the string early.
function template(file, vars) {
  let text = fs.readFileSync(path.join(ROOT, 'agent', file), 'utf8');
  const quote = v => (file.endsWith('.ps1') ? String(v).replace(/'/g, "''") : String(v).replace(/'/g, "'\\''"));
  for (const [k, v] of Object.entries(vars)) text = text.split(`__${k}__`).join(quote(v));
  return text;
}

function handleReport(raw, signingKey) {
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
    sig: crypto.createHmac('sha256', signingKey).update(`device-monitor-cmd:${cid}:${action}`).digest('hex'),
  }));
  return reply;
}

// ---- Remote access (Tailscale) -----------------------------------------------------
let remote = { installed: false };
const refreshRemote = () => fixture ? Promise.resolve() : tailscale.status(PORT).then(s => { remote = s; }, () => {});
refreshRemote();
const remoteTimer = setInterval(refreshRemote, 60e3);
function preferredHubUrl() {
  return publicOrigin() || localOrigin();
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
  dataDir: DATA_DIR, broadcast, costToday, hubUrl: preferredHubUrl, external: !fixture,
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
const handler = async (req, res) => {
  try {
    if (!sec.hostAllowed(req.headers.host, (config.allowedHosts || []).concat(remote.dnsName || [], configuredOrigin ? [new URL(configuredOrigin).hostname] : []))) {
      return send(res, 421, 'This hub only answers requests addressed to it by IP address or its own name.', 'text/plain');
    }
    if (!sec.isLocalAddress(req.socket.remoteAddress)) {
      return send(res, 403, 'This hub only accepts connections from your own network and Tailscale.', 'text/plain');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sec.sameOrigin(req)) return send(res, 403, { error: 'cross-site request refused' });
    if (!/^\/(?!\/)/.test(req.url) || req.url.includes('\\')) return send(res, 400, { error: 'Invalid request target' });
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const routeOrigin = audience(req);
    if (!routeOrigin) return send(res, 403, { error: 'Use the configured HTTPS hub address.' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && req.headers.origin !== routeOrigin &&
        !(directLocal(req) && req.headers.origin === 'http://' + req.headers.host)) return send(res, 403, { error: 'cross-site request refused' });
    const who = principal(req);
    if (!who && !rateOk(req)) return send(res, 429, { error: 'too many requests' });
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendHtml(res, 'index.html');
    if (req.method === 'GET' && p === '/pair') return send(res, 200, 'Paste this complete invitation into Device Monitor → Connect on the computer you want to enroll.', 'text/plain; charset=utf-8');
    if (req.method === 'GET' && p === '/unlock') return sendHtml(res, 'locked.html');
    if (req.method === 'POST' && p === '/api/desktop/tls-proof') {
      if (!routeOrigin.startsWith('https:')) return send(res, 403, {error:'HTTPS required'});
      const body = await readBody(req, 1024);
      const key = access.desktopProofKey(body, routeOrigin);
      if (!key) return send(res, 403, {error:'Desktop proof refused'});
      const pin = await servedTlsPin(req, routeOrigin).catch(() => null);
      if (!pin) return send(res, 503, {error:'Hub TLS identity is temporarily unavailable'});
      if (access.desktopProofKey(body, routeOrigin) !== key) return send(res, 403, {error:'Desktop proof refused'});
      return send(res, 200, {proof:mac(key, 'hub', routeOrigin, body.nonce, pin)});
    }
    if (req.method === 'POST' && (p === '/api/session' || p === '/api/pair')) {
      const kind = p === '/api/session' ? 'browser' : 'desktop';
      const member = access.redeem(bearer(req), kind, routeOrigin);
      if (!member) return send(res, 403, { error: 'Invitation is invalid, expired or already used.' });
      return send(res, 200, member);
    }
    if (req.method === 'POST' && p === '/api/invites') {
      if (!isDashboard(who)) return send(res, 401, { error: 'Sign in on the hub first.' });
      const b = await readBody(req);
      const issuer = principal(req);
      if (!issuer || (!['root','operator'].includes(issuer.role) && !(issuer.role === 'client' && b.kind === 'browser'))) return send(res, 403, { error:'Create this invitation on the hub.' });
      const dest = transport.origin(b.origin, true);
      if (!dest || (dest !== publicOrigin() && !(directLocal(req) && dest === localOrigin()))) return send(res, 400, { error: 'Configure a trusted HTTPS hub address for remote devices.' });
      if (b.kind !== 'browser' && !dest.startsWith('https:')) return send(res, 400, { error: 'Remote enrollment requires HTTPS.' });
      if (b.id != null && (!sec.isValidId(b.id) || !registry[b.id])) return send(res, 400, { error: 'Choose an existing device or leave it blank.' });
      const code = access.issue(b.kind, dest, b.id, issuer.id);
      return send(res, 200, { code, origin: dest, expires: Date.now() + 600000 });
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
      const peer = peerAddress(req), mine = downloadsByPeer.get(peer) || 0;
      if (mine >= 2) return send(res, 429, { error: 'Too many downloads from this address' });
      if (dlStreams >= MAX_DL_STREAMS) return send(res, 503, { error: 'too many downloads in progress' });
      dlStreams++; downloadsByPeer.set(peer, mine + 1);
      const deadline = setTimeout(() => res.destroy(), 10 * 60e3);
      try {
        res.setTimeout(15000, () => res.destroy());
        res.writeHead(200, { ...sec.BASE_HEADERS, 'Content-Type':'application/octet-stream', 'Content-Length':file.size,
          'Content-Disposition':"attachment; filename*=UTF-8''" + encodeURIComponent(name).replace(/'/g, '%27') });
        await pipeline(fs.createReadStream(path.join(DOWNLOADS_DIR, name)), res);
      } finally {
        clearTimeout(deadline); dlStreams--;
        const left = downloadsByPeer.get(peer) - 1;
        if (left) downloadsByPeer.set(peer, left); else downloadsByPeer.delete(peer);
      }
      return;
    }
    if (req.method === 'GET' && p === '/api/info') {
      if (!isDashboard(who)) return send(res, 200, { app: 'device-monitor', locked: true });
      return send(res, 200, { app: 'device-monitor', hostname: os.hostname(), port: PORT, canEnroll:['root','operator'].includes(who.role), canShare:who.role !== 'browser', origin: publicOrigin(), localOrigin: directLocal(req) ? localOrigin() : null });
    }
    if (req.method === 'POST' && p === '/api/report') {
      if (!who || !['local-agent', 'agent'].includes(who.role)) return send(res, 401, { error: 'Re-enroll this agent to obtain a device credential.' });
      const rateId = who.id || 'local/agent', now = Date.now();
      if (now - (lastReport.get(rateId) || 0) < 1000) return send(res, 429, { error: 'Reports are limited to one per second.' });
      lastReport.set(rateId, now);
      const b = await readBody(req);
      if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'Invalid report' });
      if (who.role === 'agent') {
        if (!access.principal(bearer(req)) || b.id !== who.id) return send(res, 403, { error: 'Report identity does not match its enrollment.' });
      }
      return send(res, 200, handleReport(b, bearer(req)));
    }
    if (req.method === 'GET' && (p === '/install.ps1' || p === '/install.sh')) {
      if (!routeOrigin.startsWith('https:')) return send(res, 403, 'Agent installation requires HTTPS.', 'text/plain');
      const member = access.redeem(bearer(req), 'agent', routeOrigin);
      if (!member) return send(res, 403, 'Invalid or expired agent invitation.', 'text/plain');
      const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'agent', f))).digest('hex');
      return send(res, 200, template(path.basename(p), {
        HUB: routeOrigin, TOKEN: member.agent, DEVICE_ID: member.id,
        SHA_AGENT: sha256('agent.sh'), SHA_AGENT_MAC: sha256('agent-macos.sh'), SHA_AGENT_PS1: sha256('agent.ps1'),
      }), 'text/plain; charset=utf-8');
    }
    if (req.method === 'GET' && (p === '/agent.ps1' || p === '/agent.sh' || p === '/agent-macos.sh' || p === '/uninstall.ps1' || p === '/uninstall.sh')) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'agent', path.basename(p))), 'text/plain; charset=utf-8');
    }

    if (!isDashboard(who)) return send(res, 401, { error: 'Open a fresh dashboard invitation.' });
    if (req.method === 'POST' && p === '/api/logout') { access.logout(bearer(req)); return send(res, 200, { ok:true }); }
    if (req.method === 'POST' && p === '/api/sessions/revoke') {
      if (!directLocal(req) || !['root','operator'].includes(who.role)) return send(res, 403, { error:'Use the hub app to revoke all browser sessions.' });
      access.clearSessions(); return send(res, 200, {ok:true});
    }
    if (req.method === 'GET' && p === '/api/devices') {
      return send(res, 200, Object.keys(registry).map(deviceView));
    }
    if (req.method === 'GET' && p === '/api/stream') return await streamDashboard(req, res);
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
      if (!fixture) remote = await tailscale.status(PORT, { fresh: url.searchParams.has('fresh') });
      return send(res, 200, { ...remote, port: PORT, canConfigure: !fixture && isLoopback(req) && ['root','operator'].includes(who.role), platform: process.platform });
    }
    if (req.method === 'POST' && p === '/api/remote/https') {
      // Changes this PC's Tailscale setup, so only the hub PC itself may do it.
      if (fixture || !isLoopback(req) || !['root','operator'].includes(who.role)) return send(res, 403, { error: 'Turn this on from the Device Monitor app on the hub PC.' });
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
        if (fixture) return send(res, 403, { error: 'Host integrations disabled' });
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
        access.revoke(id); lastReport.delete(id);
        delete registry[id]; delete live[id]; history.remove(id); alerts.removeDevice(id); commands.delete(id); procWatch.delete(id);
        saveRegistry();
        broadcast({ type: 'removed', id });
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (res.headersSent) res.destroy();   // never let one bad request take the hub down
    else if (!res.destroyed) send(res, e.status || 400, { error: String(e.message || e) });
  }
};

const server = http.createServer(handler);
const secureServer = tlsOptions ? https.createServer(tlsOptions, handler) : null;
function close() {
  if (saveTimer) { clearTimeout(saveTimer); writeJson(DEVICES_FILE, registry); }
  access.close(); alerts.close(); clearInterval(remoteTimer); clearInterval(rateTimer); downloadsWatch?.close();
  clearTimeout(watchTimer); history.close(); clearInterval(statusTimer);
  for (const res of clients.keys()) res.destroy();
  for (const listener of [server, secureServer]) if (listener) { listener.close(); listener.closeAllConnections(); }
}
function listen(listener, n, host) {
  listener.maxConnections = 256; listener.headersTimeout = 10000; listener.requestTimeout = 15000;
  return new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(n, host, () => { listener.removeListener('error', reject); resolve(); });
  });
}
return (async () => {
  try {
    await listen(server, PORT, '127.0.0.1');
    PORT = server.address().port;
    if (secureServer) await listen(secureServer, Number(new URL(configuredOrigin).port) || 443, fixture ? '127.0.0.1' : '::');
    if (headlessInvites) access.openOperatorMailbox(PORT);
    return { port: PORT, localKey: access.config.localKey, agentToken: access.localAgent, publicOrigin, addresses: lanAddresses(), close,
      ...(fixture ? { seedReport: b => handleReport(b, access.localAgent), browserLink: () => localOrigin() + '/unlock#join=' + access.issue('browser', localOrigin()) } : {}) };
  } catch (e) { close(); throw e; }
})();
}

module.exports = { startHub, lanAddresses };

// Headless mode: `node server.js` (e.g. on a home server). Also monitors this machine.
if (require.main === module) {
  const port = Number(process.env.PORT) || 7777;
  if (process.argv.includes('--invite')) {
    (async () => {
      if (!process.stdout.isTTY) throw new Error('Use an interactive terminal to display an invitation.');
      console.log(localOperatorLink(path.join(__dirname, 'data'), port));
    })().catch(e => { console.error(e.message); process.exitCode = 1; });
  } else startHub({ port, headlessInvites:true }).then(hub => {
    console.log('Device Monitor hub listening locally on port ' + hub.port + '. Run node server.js --invite to open a dashboard.');
    if (!process.env.NO_LOCAL_AGENT) startAgent({ hub: 'http://127.0.0.1:' + hub.port, token: hub.agentToken, scriptDir: path.join(__dirname, 'agent') });
  }, e => { console.error(e.message); process.exitCode = 1; });
  process.on('SIGINT', () => process.exit());
  process.on('SIGTERM', () => process.exit());
}
