// Metric history per device.
//  - raw samples (every ~2s) for the last hour, in memory
//  - 1-minute averages for the last 30 days, in memory + appended to data/history/<id>.ndjson
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isValidId } = require('./security');

const FIELDS = ['cpu', 'gpu', 'mem', 'cpuTemp', 'gpuTemp', 'gpuPower', 'power', 'rx', 'tx', 'dr', 'dw'];
const MAX_FIELDS = ['cpu', 'gpu', 'cpuTemp', 'gpuTemp', 'power'];   // also keep the peak within each bucket
const RAW_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const maxKey = f => f + 'Max';
const legacyName = id => id.replace(/[^a-zA-Z0-9_-]/g, '_');
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('Unsafe history directory');
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}
function privateFile(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('Unsafe history file');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}
function replacePrivate(file, contents) {
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, contents, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}
function rows(file, cutoff, stats = {}) {
  privateFile(file);
  const result = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let row; try { row = JSON.parse(line); } catch { stats.pruned = true; continue; }
    if (row && Number.isFinite(row.t) && row.t >= cutoff) result.push(row);
    else stats.pruned = true;
  }
  return result;
}
function byMinute(points) {
  const minutes = new Map();
  for (const { id, ...p } of points) {
    const old = minutes.get(p.t);
    minutes.set(p.t, old ? merge(old, p) : p);
  }
  return [...minutes.values()].sort((a, b) => a.t - b.t);
}

// Average `points` into buckets `width` ms wide. Peaks are kept as <field>Max.
function aggregate(points, width, start) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const p = { t: cur.t };
    for (const f of FIELDS) p[f] = cur.n[f] ? +(cur.sum[f] / cur.n[f]).toFixed(2) : null;
    for (const f of MAX_FIELDS) p[maxKey(f)] = cur.max[f] ?? null;
    out.push(p);
  };
  for (const s of points) {
    const b = start + Math.floor((s.t - start) / width) * width;
    if (!cur || cur.t !== b) { flush(); cur = { t: b, sum: {}, n: {}, max: {} }; }
    for (const f of FIELDS) {
      const v = s[f];
      if (v == null) continue;
      cur.sum[f] = (cur.sum[f] || 0) + v; cur.n[f] = (cur.n[f] || 0) + 1;
    }
    for (const f of MAX_FIELDS) {
      const v = s[maxKey(f)] ?? s[f];
      if (v != null && (cur.max[f] == null || v > cur.max[f])) cur.max[f] = v;
    }
  }
  flush();
  return out;
}

// Combine two points for the same minute (e.g. one flushed at hub shutdown, one after restart),
// weighting averages by their sample counts. Rows written before counts were stored count as 1.
function merge(a, b) {
  const na = a.n || 1, nb = b.n || 1;
  const p = { t: a.t };
  for (const f of FIELDS) {
    const x = a[f], y = b[f];
    p[f] = x == null ? y ?? null : y == null ? x : +((x * na + y * nb) / (na + nb)).toFixed(2);
  }
  for (const f of MAX_FIELDS) {
    const x = a[maxKey(f)], y = b[maxKey(f)];
    p[maxKey(f)] = x == null ? y ?? null : y == null ? x : Math.max(x, y);
  }
  p.n = na + nb;
  return p;
}

class HistoryStore {
  constructor(dataDir, registered = []) {
    const legacy = path.join(dataDir, 'history');
    privateDir(legacy);
    this.dir = path.join(legacy, 'by-id');
    privateDir(this.dir);
    this.raw = new Map();
    this.minutes = new Map();
    this.pending = new Map();
    const cutoff = Date.now() - KEEP_MS;
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^(?:[0-9a-f]{2}){1,64}\.ndjson$/.test(name)) continue;
      const id = Buffer.from(name.slice(0, -7), 'hex').toString('utf8');
      if (!isValidId(id) || path.basename(this.file(id)) !== name) continue;
      const file = this.file(id), stats = {}, points = rows(file, cutoff, stats);
      const minutes = byMinute(points);
      if (!minutes.length) { fs.unlinkSync(file); continue; }
      this.minutes.set(id, minutes);
      if (stats.pruned || minutes.length !== points.length) this.rewrite(id);
    }
    // Each legacy row records its original ID. Publish all destinations before
    // removing the source; a restart prefers already-published minutes.
    for (const name of fs.readdirSync(legacy)) {
      if (!name.endsWith('.ndjson')) continue;
      const file = path.join(legacy, name), points = rows(file, cutoff);
      const base = name.slice(0, -7);
      const stat = fs.lstatSync(file, {bigint:true});
      const ids = new Set(registered.filter(id => {
        const old = legacyName(id);
        if (old === base) return true;
        if (old.toLowerCase() !== base.toLowerCase()) return false;
        // Case folding is a property of the filesystem, not of the OS.
        const alias = fs.lstatSync(path.join(legacy, old + '.ndjson'), {bigint:true, throwIfNoEntry:false});
        return alias && alias.dev === stat.dev && alias.ino === stat.ino;
      }));
      for (const p of points) if (isValidId(p.id)) ids.add(p.id);
      const fallback = ids.size === 1 ? [...ids][0] : !ids.size && isValidId(base) ? base : null;
      const grouped = new Map(), unassigned = [];
      for (const p of points) {
        const id = p.id == null ? fallback : p.id;
        if (!isValidId(id)) { unassigned.push(p); continue; }
        if (!grouped.has(id)) grouped.set(id, []);
        grouped.get(id).push(p);
      }
      for (const [id, group] of grouped) {
        const combined = new Map(byMinute(group).map(p => [p.t, p]));
        for (const p of this.minutes.get(id) || []) combined.set(p.t, p);
        this.minutes.set(id, [...combined.values()].sort((a,b) => a.t - b.t));
        this.rewrite(id);
      }
      if (unassigned.length) replacePrivate(file + '.unassigned', unassigned.map(p => JSON.stringify(p)).join('\n') + '\n');
      fs.unlinkSync(file);
    }
  }

  file(id) {
    if (!isValidId(id)) throw new Error('Invalid history ID');
    return path.join(this.dir, Buffer.from(id).toString('hex') + '.ndjson');
  }

  rewrite(id) {
    const pts = this.minutes.get(id) || [];
    replacePrivate(this.file(id), pts.map(p => JSON.stringify({ id, ...p })).join('\n') + (pts.length ? '\n' : ''));
  }

  add(id, sample) {
    const raw = this.raw.get(id) || (this.raw.set(id, []), this.raw.get(id));
    const last = raw[raw.length - 1];
    if (last && sample.t - last.t < 1000) return;
    raw.push(sample);
    while (raw.length && raw[0].t < sample.t - RAW_MS) raw.shift();

    const minute = Math.floor(sample.t / MINUTE_MS) * MINUTE_MS;
    let pend = this.pending.get(id);
    if (pend && pend.minute !== minute) { this.commit(id, pend); pend = null; }
    if (!pend) this.pending.set(id, pend = { minute, samples: [] });
    pend.samples.push(sample);
  }

  commit(id, pend) {
    const [p] = aggregate(pend.samples, MINUTE_MS, pend.minute);
    if (!p) return;
    p.n = pend.samples.length;
    const mins = this.minutes.get(id) || (this.minutes.set(id, []), this.minutes.get(id));
    if (mins.length && mins[mins.length - 1].t === p.t) {   // same minute as before a restart: merge, don't double-count
      mins[mins.length - 1] = merge(mins[mins.length - 1], p);
      this.rewrite(id);
      return;
    }
    mins.push(p);
    const cutoff = Date.now() - KEEP_MS;
    if (mins.length && mins[0].t < cutoff - 24 * 60 * 60 * 1000) {   // prune about once a day
      while (mins.length && mins[0].t < cutoff) mins.shift();
      this.rewrite(id);
    } else {
      fs.appendFileSync(this.file(id), JSON.stringify({ id, ...p }) + '\n', { mode: 0o600 });
    }
  }

  // Samples for the live dashboard (raw, last `ms`).
  recent(id, ms) {
    const since = Date.now() - ms;
    return (this.raw.get(id) || []).filter(s => s.t >= since);
  }

  // 1-minute points covering [from, to], including the current unfinished minute.
  minutePoints(id, from, to = Date.now()) {
    const mins = (this.minutes.get(id) || []).filter(p => p.t >= from && p.t <= to);
    const lastMin = mins.length ? mins[mins.length - 1].t : -Infinity;
    const tail = (this.raw.get(id) || []).filter(s => s.t >= lastMin + MINUTE_MS && s.t >= from && s.t <= to);
    return mins.concat(aggregate(tail, MINUTE_MS, Math.floor(from / MINUTE_MS) * MINUTE_MS));
  }

  // Points covering [from, to], at most ~maxPoints, using raw data when it's fine-grained enough.
  query(id, from, to = Date.now(), maxPoints = 1200) {
    const span = Math.max(1, to - from);
    const width = Math.max(1, span / maxPoints);
    const raw = (this.raw.get(id) || []).filter(s => s.t >= from && s.t <= to);
    let points, resolution;
    if (width < MINUTE_MS) {
      // Fine-grained: raw samples, with minute data filling in before raw starts (e.g. right after a restart).
      const rawStart = raw.length ? raw[0].t : Infinity;
      const older = (this.minutes.get(id) || []).filter(p => p.t >= from && p.t + MINUTE_MS <= rawStart);
      const fine = width <= 2000 ? raw : aggregate(raw, width, from);
      points = older.concat(fine);
      resolution = older.length ? MINUTE_MS : Math.max(2000, width);
    } else {
      // Minute data, plus the current unfinished minute from raw so the right edge is live.
      const all = this.minutePoints(id, from, to);
      points = width <= MINUTE_MS ? all : aggregate(all, width, from);
      resolution = Math.max(MINUTE_MS, width);
    }
    return { from, to, resolution, points };
  }

  remove(id) {
    this.raw.delete(id); this.minutes.delete(id); this.pending.delete(id);
    fs.rmSync(this.file(id), { force: true });
  }

  close() { for (const [id, pend] of this.pending) this.commit(id, pend); this.pending.clear(); }
}

module.exports = { HistoryStore, FIELDS };
