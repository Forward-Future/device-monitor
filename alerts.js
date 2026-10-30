// Alerts: rules people set up on the dashboard, evaluated on the hub as reports come in.
// Delivered to the desktop apps (through the dashboard's live stream), to phones through ntfy
// (https://ntfy.sh, free, no account needed) and to chat webhooks (Discord, Slack, or anything
// that accepts JSON).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { readJson, writeJson } = require('./safe-json');

// threshold: [min, max]; hyst: how far a value must fall back below the threshold to count as resolved.
const TYPES = {
  offline:   { label: 'Offline', threshold: null },
  cpuTemp:   { label: 'CPU temperature', threshold: [20, 150], hyst: 3 },
  gpuTemp:   { label: 'GPU temperature', threshold: [20, 150], hyst: 3 },
  cpu:       { label: 'CPU load', threshold: [1, 100], hyst: 5 },
  gpu:       { label: 'GPU load', threshold: [1, 100], hyst: 5 },
  mem:       { label: 'Memory use', threshold: [1, 100], hyst: 3 },
  disk:      { label: 'Disk space used', threshold: [1, 100], hyst: 1 },
  power:     { label: 'Power draw', threshold: [1, 100000], hyst: null },
  dailyCost: { label: 'Electricity cost today', threshold: [0.01, 1e7], hyst: null },
};
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DEFAULT_RULES = [
  { type: 'offline', device: '*', minutes: 10 },
  { type: 'cpuTemp', device: '*', threshold: 90, minutes: 2 },
  { type: 'gpuTemp', device: '*', threshold: 85, minutes: 2 },
  { type: 'disk', device: '*', threshold: 90, minutes: 0 },
];
const MAX_LOG = 300;

const newId = () => crypto.randomBytes(6).toString('hex');
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// Alert webhooks/ntfy may point anywhere on the internet — but never at loopback, link-local or
// cloud-metadata addresses, so a key-holder can't turn the hub into an SSRF bounce point.
// LAN/private addresses stay allowed: self-hosted ntfy or a chat bridge on the network is a
// legitimate setup.
function isBlockedAddress(ip) {
  let a = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  if (a.startsWith('::ffff:')) {
    a = a.slice(7);          // IPv4-mapped IPv6, dotted (127.0.0.1) or hex groups (7f00:1)
    if (!net.isIPv4(a) && a.includes(':')) {
      const g = a.split(':').map(h => parseInt(h, 16));
      if (g.length === 2 && g.every(Number.isFinite)) a = [g[0] >> 8, g[0] & 255, g[1] >> 8, g[1] & 255].join('.');
    }
  }
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    return x === 0 || x === 127 || (x === 169 && y === 254);
  }
  return a === '::1' || a === '::' || /^fe[89ab]/.test(a);   // loopback, unspecified, link-local
}
const BLOCKED_HOST = h => isBlockedAddress(h);
const httpUrl = s => {
  try {
    const u = new URL(String(s));
    if (!/^https?:$/.test(u.protocol)) return null;
    const h = u.hostname.toLowerCase();
    if (BLOCKED_HOST(h) || h === 'localhost' || h.endsWith('.localhost')) return null;
    return u.href.replace(/\/$/, '');
  } catch { return null; }
};
const clean = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');

function validRule(r) {
  if (!isObj(r) || !Object.hasOwn(TYPES, r.type)) return null;
  const t = TYPES[r.type];
  const device = r.device === '*' || (typeof r.device === 'string' && ID_RE.test(r.device)) ? r.device : null;
  if (!device) return null;
  let threshold = null;
  if (t.threshold) {
    threshold = Number(r.threshold);
    if (!Number.isFinite(threshold) || threshold < t.threshold[0] || threshold > t.threshold[1]) return null;
  }
  const minutes = Math.round(Number(r.minutes) || 0);
  if (minutes < (r.type === 'offline' ? 1 : 0) || minutes > 1440) return null;
  return { id: typeof r.id === 'string' && /^[a-f0-9]{12}$/.test(r.id) ? r.id : newId(), type: r.type, device, threshold, minutes, enabled: r.enabled !== false };
}

function validSettings(b, prev) {
  if (!isObj(b)) return null;
  const rules = Array.isArray(b.rules) ? b.rules.slice(0, 100).map(validRule) : null;
  if (!rules || rules.some(r => !r)) return null;
  const ch = isObj(b.channels) ? b.channels : {};
  const ntfy = isObj(ch.ntfy) ? ch.ntfy : {};
  const hook = isObj(ch.webhook) ? ch.webhook : {};
  const topic = clean(ntfy.topic, 64);
  if (topic && !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return null;
  const email = clean(ntfy.email, 120);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  const server = ntfy.server ? httpUrl(ntfy.server) : 'https://ntfy.sh';
  const hookUrl = hook.url ? httpUrl(hook.url) : '';
  if (!server || hookUrl === null) return null;
  return {
    rules,
    channels: {
      desktop: ch.desktop !== false,
      ntfy: { enabled: !!ntfy.enabled && !!topic, server, topic, email },
      webhook: { enabled: !!hook.enabled && !!hookUrl, url: hookUrl || '' },
    },
    notifyResolved: b.notifyResolved !== false,
    tempUnit: b.tempUnit === 'F' ? 'F' : 'C',
  };
}

class Alerts {
  // devices(): [{ id, name, online, lastSeen }]; latest(id): the device's last report;
  // costToday(id | '*'): { cost, currency } or null; hubUrl(): link to put in notifications.
  constructor({ dataDir, broadcast, devices, latest, costToday, hubUrl, log = console.log }) {
    Object.assign(this, { broadcast, devices, latest, costToday, hubUrl, log });
    this.file = path.join(dataDir, 'alerts.json');
    this.logFile = path.join(dataDir, 'alerts-log.json');
    const saved = readJson(this.file, null);
    this.cfg = (saved && validSettings(saved.settings || saved)) ||
      validSettings({ rules: DEFAULT_RULES, channels: { desktop: true } });
    const savedLog = readJson(this.logFile, []);
    this.events = Array.isArray(savedLog) ? savedLog.slice(-MAX_LOG) : [];
    // "<ruleId>|<deviceId>" -> { since, firing, firedAt, value, detail }
    this.state = new Map(Object.entries(saved?.firing || {}).map(([k, v]) => [k, { since: v.firedAt, firing: true, firedAt: v.firedAt, value: v.value, detail: v.detail }]));
    this.started = Date.now();
    if (!saved) this.save();
    // Devices that were already offline when the hub started count as firing, without a notification.
    for (const r of this.cfg.rules) if (r.enabled && r.type === 'offline')
      for (const d of this.targets(r)) if (!d.online && d.lastSeen) this.mark(r, d.id, { since: d.lastSeen, firing: true, firedAt: d.lastSeen });
    this.timer = setInterval(() => this.tick(), 15e3);
    this.costTimer = setInterval(() => this.checkCost(), 5 * 60e3);
  }

  settings() { return this.cfg; }

  update(input) {
    const s = validSettings(input);
    if (!s) return null;
    const keep = new Map(s.rules.map(r => [r.id, JSON.stringify({ ...r, enabled: true })]));
    const old = new Map(this.cfg.rules.map(r => [r.id, JSON.stringify({ ...r, enabled: true })]));
    this.cfg = s;
    // Forget state for rules that were removed, changed or switched off.
    for (const key of [...this.state.keys()]) {
      const rid = key.split('|')[0], rule = s.rules.find(r => r.id === rid);
      if (!rule || !rule.enabled || keep.get(rid) !== old.get(rid)) this.state.delete(key);
    }
    this.save();
    this.broadcast({ type: 'alerts', settings: s, active: this.active() });
    this.tick();
    return s;
  }

  save() {
    const firing = Object.fromEntries([...this.state].filter(([, st]) => st.firing).map(([k, st]) => [k, { firedAt: st.firedAt, value: st.value, detail: st.detail }]));
    writeJson(this.file, { settings: this.cfg, firing });
  }

  targets(rule) {
    const all = this.devices();
    return rule.device === '*' ? all : all.filter(d => d.id === rule.device);
  }

  mark(rule, id, st) { this.state.set(rule.id + '|' + id, st); }

  // ---- evaluation ---------------------------------------------------------------
  onReport(id, body) {
    for (const r of this.cfg.rules) {
      if (!r.enabled || (r.device !== '*' && r.device !== id)) continue;
      if (r.type === 'offline') { this.resolveOffline(r, id); continue; }
      if (r.type === 'dailyCost') continue;
      const [value, detail] = metric(r.type, body);
      if (value == null) continue;
      this.evaluate(r, id, value, detail);
    }
  }

  evaluate(r, id, value, detail) {
    const key = r.id + '|' + id, now = Date.now();
    const st = this.state.get(key) || { since: null, firing: false };
    const hyst = TYPES[r.type].hyst ?? r.threshold * 0.05;
    if (value > r.threshold) {
      st.since ??= now;
      if (!st.firing && now - st.since >= r.minutes * 60e3) {
        Object.assign(st, { firing: true, firedAt: now, value, detail });
        this.state.set(key, st);
        return this.emit(r, id, 'firing', value, detail);
      }
      if (st.firing) { st.value = value; st.detail = detail; }
    } else if (st.firing && value <= r.threshold - hyst) {
      this.state.delete(key);
      return this.emit(r, id, 'resolved', value, detail);
    } else if (!st.firing) st.since = null;
    this.state.set(key, st);
  }

  resolveOffline(r, id) {
    const key = r.id + '|' + id, st = this.state.get(key);
    if (st?.firing) { this.state.delete(key); this.emit(r, id, 'resolved', null, { since: st.since }); }
  }

  tick() {
    const now = Date.now();
    for (const r of this.cfg.rules) {
      if (!r.enabled || r.type !== 'offline') continue;
      for (const d of this.targets(r)) {
        const key = r.id + '|' + d.id;
        if (d.online || !d.lastSeen || this.state.get(key)?.firing) continue;
        if (now - d.lastSeen >= r.minutes * 60e3) {
          this.state.set(key, { since: d.lastSeen, firing: true, firedAt: now });
          this.emit(r, d.id, 'firing', null, { since: d.lastSeen });
        }
      }
    }
  }

  checkCost() {
    const today = new Date().toDateString();
    for (const r of this.cfg.rules) {
      if (!r.enabled || r.type !== 'dailyCost') continue;
      const key = r.id + '|' + r.device, st = this.state.get(key);
      if (st?.firing && st.day !== today) this.state.delete(key);   // new day: quietly start over
      if (this.state.get(key)?.firing) continue;
      const c = this.costToday(r.device);
      if (c && c.cost > r.threshold) {
        this.state.set(key, { since: Date.now(), firing: true, firedAt: Date.now(), value: c.cost, detail: { currency: c.currency }, day: today });
        this.emit(r, r.device, 'firing', c.cost, { currency: c.currency });
      }
    }
  }

  active() {
    const out = [];
    for (const [key, st] of this.state) {
      if (!st.firing) continue;
      const [ruleId, device] = key.split('|');
      const r = this.cfg.rules.find(x => x.id === ruleId);
      if (r) out.push({ ruleId, type: r.type, device, deviceName: this.nameOf(device), since: st.firedAt, value: st.value ?? null, threshold: r.threshold, ...this.text(r, device, 'firing', st.value, st.detail) });
    }
    return out.sort((a, b) => b.since - a.since);
  }

  nameOf(id) { return id === '*' ? 'All devices' : this.devices().find(d => d.id === id)?.name || id; }

  removeDevice(id) {
    for (const key of [...this.state.keys()]) if (key.endsWith('|' + id)) this.state.delete(key);
    this.save();
  }

  // ---- wording --------------------------------------------------------------------
  temp(c) { return this.cfg.tempUnit === 'F' ? Math.round(c * 9 / 5 + 32) + '°F' : Math.round(c) + '°C'; }
  fmt(type, v, detail) {
    if (v == null) return '';
    if (type === 'cpuTemp' || type === 'gpuTemp') return this.temp(v);
    if (type === 'power') return v >= 1000 ? (v / 1000).toFixed(2) + ' kW' : Math.round(v) + ' W';
    if (type === 'dailyCost') { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: detail?.currency || 'USD' }).format(v); } catch { return v.toFixed(2); } }
    return Math.round(v) + '%';
  }
  text(r, id, state, value, detail = {}) {
    const name = this.nameOf(id), label = TYPES[r.type].label, limit = this.fmt(r.type, r.threshold, detail);
    const dur = r.minutes ? ` for ${r.minutes} min` : '';
    const clock = t => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (r.type === 'offline') return state === 'firing'
      ? { title: `${name} is offline`, message: `No reports since ${clock(detail?.since || Date.now())}.` }
      : { title: `${name} is back online`, message: detail?.since ? `It was offline since ${clock(detail.since)}.` : 'Reporting again.' };
    if (r.type === 'disk') return state === 'firing'
      ? { title: `${name}: disk ${detail?.disk || ''} is ${this.fmt('disk', value)} full`.replace('  ', ' '), message: `Over your ${limit} limit${detail?.free != null ? ` · ${(detail.free / 1e9).toFixed(1)} GB free` : ''}.` }
      : { title: `${name}: disk space back under ${limit}`, message: `Now ${this.fmt('disk', value)} used.` };
    if (r.type === 'dailyCost') return { title: `${name}: electricity today is ${this.fmt(r.type, value, detail)}`, message: `Over your ${limit} daily limit.` };
    return state === 'firing'
      ? { title: `${name}: ${label} ${this.fmt(r.type, value)}`, message: `Above ${limit}${dur}.` }
      : { title: `${name}: ${label} back to normal`, message: `Now ${this.fmt(r.type, value)} (limit ${limit}).` };
  }

  // ---- delivery -------------------------------------------------------------------
  emit(r, id, state, value, detail) {
    const ev = { id: newId(), t: Date.now(), ruleId: r.id, type: r.type, device: id, deviceName: this.nameOf(id), state, value, ...this.text(r, id, state, value, detail) };
    this.events.push(ev);
    if (this.events.length > MAX_LOG) this.events.splice(0, this.events.length - MAX_LOG);
    clearTimeout(this.logTimer);
    this.logTimer = setTimeout(() => writeJson(this.logFile, this.events, 0), 1000);
    this.save();
    const notify = state === 'firing' || this.cfg.notifyResolved;
    this.broadcast({ type: 'alert', event: ev, notify: notify && this.cfg.channels.desktop, active: this.active() });
    if (notify) this.deliver(ev).catch(() => {});
    return ev;
  }

  async deliver(ev) {
    const { ntfy, webhook } = this.cfg.channels, out = {};
    const link = this.hubUrl() + '/#/alerts';
    if (ntfy.enabled) {
      out.ntfy = await post(ntfy.server, {
        topic: ntfy.topic, title: ev.title, message: ev.message, priority: ev.state === 'firing' ? 4 : 3,
        tags: [ev.state === 'firing' ? 'warning' : 'white_check_mark'], click: link, ...(ntfy.email ? { email: ntfy.email } : {}),
      });
    }
    if (webhook.enabled) {
      const line = `${ev.state === 'firing' ? '⚠️' : '✅'} ${ev.title}\n${ev.message}`;
      // `content` is what Discord reads, `text` is what Slack (and most others) read.
      out.webhook = await post(webhook.url, { content: line, text: line, title: ev.title, message: ev.message, device: ev.deviceName, state: ev.state, time: new Date(ev.t).toISOString(), link });
    }
    if (Object.values(out).some(r => !r.ok)) this.log('alert delivery failed:', JSON.stringify(out));
    return out;
  }

  async test() {
    const ev = { id: newId(), t: Date.now(), state: 'firing', title: 'Device Monitor test alert', message: 'Alerts from your hub will arrive like this.', test: true };
    this.broadcast({ type: 'alert', event: ev, notify: this.cfg.channels.desktop, active: this.active() });
    return this.deliver(ev);
  }

  close() { clearInterval(this.timer); clearInterval(this.costTimer); clearTimeout(this.logTimer); }
}

async function post(url, body) {
  try {
    // Check where the name actually resolves — a DNS name pointing at loopback/metadata is just
    // as much an SSRF as a literal address. Redirects are refused rather than followed, for the
    // same reason.
    const { hostname } = new URL(url);
    if (!net.isIP(hostname.replace(/^\[|\]$/g, ''))) {
      const addrs = await dns.promises.lookup(hostname, { all: true }).catch(() => []);
      if (addrs.length && addrs.every(a => isBlockedAddress(a.address))) return { ok: false, error: 'blocked: resolves to a local address' };
    } else if (isBlockedAddress(hostname)) return { ok: false, error: 'blocked: local address' };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10e3), redirect: 'manual' });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim() };
  } catch (e) { return { ok: false, error: e.cause?.code || e.message }; }
}

// Current value of a metric in a report, plus details for the message.
function metric(type, b) {
  const gpus = b.gpus || [];
  const max = vals => { const v = vals.filter(x => x != null); return v.length ? Math.max(...v) : null; };
  switch (type) {
    case 'cpuTemp': return [b.cpu?.temp ?? null];
    case 'gpuTemp': return [max(gpus.map(g => g.temp))];
    case 'cpu': return [b.cpu?.usage ?? null];
    case 'gpu': return [max(gpus.map(g => g.usage))];
    case 'mem': return [b.memory?.total ? b.memory.used / b.memory.total * 100 : null];
    case 'power': return [b.powerEst?.watts ?? null];
    case 'disk': {
      let worst = null;
      for (const d of b.disks || []) if (d.total > 1e9 && d.used != null) { const p = d.used / d.total * 100; if (!worst || p > worst.p) worst = { p, d }; }
      return worst ? [worst.p, { disk: worst.d.name, free: worst.d.total - worst.d.used }] : [null];
    }
  }
  return [null];
}

module.exports = { Alerts, TYPES, validSettings, metric };
