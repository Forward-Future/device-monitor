// Input validation and HTTP hardening for the hub.
const net = require('net');
const os = require('os');
const crypto = require('crypto');

// ---- device reports ----------------------------------------------------------
// Device ids come from agents (machine GUID / machine-id / IOPlatformUUID).
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const isValidId = id => typeof id === 'string' && ID_RE.test(id);

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 120) => {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s ? s.slice(0, max) : null;
};
const num = (v, min = 0, max = 1e18) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const PLATFORMS = new Set(['windows', 'linux', 'macos']);
const ACTIONS = new Set(['sleep', 'restart', 'shutdown']);
const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

// Rebuilds a report from known fields only, with every value coerced to the expected type.
// Anything an agent sends that isn't listed here is dropped, so the dashboard only ever sees
// strings where it expects strings and finite numbers where it expects numbers.
function normalizeReport(b) {
  const cpu = isObj(b.cpu) ? b.cpu : {};
  const mem = isObj(b.memory) ? b.memory : {};
  return {
    id: b.id,
    hostname: str(b.hostname, 64),
    platform: PLATFORMS.has(b.platform) ? b.platform : 'unknown',
    os: str(b.os, 120),
    uptime: num(b.uptime, 0, 1e10),
    formFactor: b.formFactor === 'laptop' || b.formFactor === 'desktop' ? b.formFactor : null,
    power: isObj(b.power) ? { cpu: num(b.power.cpu, 0, 5000) } : null,
    features: list(b.features, 8).filter(f => f === 'procs' || f === 'actions'),
    actions: list(b.actions, 8).filter(a => ACTIONS.has(a)),
    macs: list(b.macs, 8).filter(m => typeof m === 'string' && MAC_RE.test(m) && !/^(00[:-]){5}00$/.test(m)).map(m => m.toLowerCase().replace(/-/g, ':')),
    actionResult: isObj(b.actionResult) && typeof b.actionResult.id === 'string' && /^[a-f0-9]{12}$/.test(b.actionResult.id)
      ? { id: b.actionResult.id, ok: b.actionResult.ok === true, message: str(b.actionResult.message, 200) } : null,
    appVersion: typeof b.appVersion === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(b.appVersion) ? b.appVersion : null,
    cpu: {
      name: str(cpu.name, 120),
      usage: num(cpu.usage, 0, 100),
      cores: list(cpu.cores, 1024).map(v => num(v, 0, 100)),
      threads: num(cpu.threads, 0, 1e5),
      clockMHz: num(cpu.clockMHz, 0, 1e5),
      temp: num(cpu.temp, -60, 250),
      tempSource: cpu.tempSource === 'acpi' ? 'acpi' : null,
    },
    memory: { total: num(mem.total), used: num(mem.used) },
    gpus: list(b.gpus, 32).filter(isObj).map(g => ({
      name: str(g.name, 120), vendor: str(g.vendor, 20),
      usage: num(g.usage, 0, 100), temp: num(g.temp, -60, 250),
      memUsed: num(g.memUsed), memTotal: num(g.memTotal),
      power: num(g.power, 0, 1e5), powerLimit: num(g.powerLimit, 0, 1e5),
      fan: num(g.fan, 0, 100), clockMHz: num(g.clockMHz, 0, 1e5),
    })),
    disks: list(b.disks, 64).filter(isObj).map(d => ({ name: str(d.name, 80), label: str(d.label, 80), total: num(d.total), used: num(d.used) })),
    net: isObj(b.net) ? { rx: num(b.net.rx), tx: num(b.net.tx) } : null,
    diskIO: isObj(b.diskIO) ? { read: num(b.diskIO.read), write: num(b.diskIO.write) } : null,
    temps: list(b.temps, 256).filter(isObj).map(t => ({ name: str(t.name, 80), parent: str(t.parent, 120), value: num(t.value, -60, 250) })),
    fans: list(b.fans, 64).filter(isObj).map(f => ({ name: str(f.name, 80), rpm: num(f.rpm, 0, 1e5) })),
  };
}

// Running processes, sent only while someone has the Processes panel open.
function normalizeProcesses(v) {
  if (!Array.isArray(v)) return null;
  return v.slice(0, 120).filter(isObj).map(p => ({
    pid: num(p.pid, 0, 1e9), name: str(p.name, 80), cmd: str(p.cmd, 160), user: str(p.user, 40),
    cpu: num(p.cpu, 0, 100), mem: num(p.mem), gpu: num(p.gpu, 0, 100), gpuMem: num(p.gpuMem),
  })).filter(p => p.pid != null && p.name);
}

// ---- DNS-rebinding protection -------------------------------------------------
// A web page on some other site can't read the hub's API cross-origin, but with DNS rebinding
// it can make its own hostname resolve to the hub. Only answer requests addressed to this
// machine by IP, localhost, or this machine's own name.
function hostAllowed(hostHeader, extra = []) {
  if (!hostHeader) return false;
  let host = String(hostHeader).trim().toLowerCase();
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'));   // [IPv6]:port
  else host = host.replace(/:\d+$/, '');
  if (net.isIP(host)) return true;
  const me = os.hostname().toLowerCase();
  const allowed = new Set(['localhost', me, `${me}.local`, `${me}.lan`, `${me}.home`, `${me}.home.arpa`, ...extra.map(h => String(h).toLowerCase())]);
  if (allowed.has(host)) return true;
  return host.startsWith(me + '.') && host.endsWith('.ts.net');   // Tailscale MagicDNS
}

// ---- LAN-only peers (discovery) ---------------------------------------------
function isPrivateAddress(ip) {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

// ---- response headers -----------------------------------------------------------
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// HTML pages get a per-response script nonce: only the page's own <script> blocks run, so an
// injected <script> or inline event handler would be blocked even if escaping were ever missed.
function htmlWithNonce(html) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const body = String(html).replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
  const csp = [
    "default-src 'self'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "worker-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
  return { body, headers: { 'Content-Security-Policy': csp, 'X-Frame-Options': 'DENY' } };
}

module.exports = { isValidId, normalizeReport, normalizeProcesses, ACTIONS, hostAllowed, isPrivateAddress, htmlWithNonce, BASE_HEADERS };
