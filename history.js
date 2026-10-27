// Metric history per device.
//  - raw samples (every ~2s) for the last hour, in memory
//  - 1-minute averages for the last 30 days, in memory + appended to data/history/<id>.ndjson
const fs = require('fs');
const path = require('path');

const FIELDS = ['cpu', 'gpu', 'mem', 'cpuTemp', 'gpuTemp', 'gpuPower', 'power', 'rx', 'tx', 'dr', 'dw'];
const MAX_FIELDS = ['cpu', 'gpu', 'cpuTemp', 'gpuTemp', 'power'];   // also keep the peak within each bucket
const RAW_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const maxKey = f => f + 'Max';
const safe = id => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');

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

class HistoryStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'history');
    fs.mkdirSync(this.dir, { recursive: true });
    this.raw = new Map();      // id -> samples (last hour)
    this.minutes = new Map();  // id -> 1-minute points (last 30 days)
    this.pending = new Map();  // id -> samples in the current, unfinished minute
    this.load();
  }

  file(id) { return path.join(this.dir, safe(id) + '.ndjson'); }

  load() {
    const cutoff = Date.now() - KEEP_MS;
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.ndjson')) continue;
      const file = path.join(this.dir, name);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const pts = [];
      for (const line of lines) { if (!line) continue; try { const p = JSON.parse(line); if (p.t >= cutoff) pts.push(p); } catch {} }
      if (!pts.length) { fs.unlinkSync(file); continue; }
      const id = pts[pts.length - 1].id || name.slice(0, -7);
      for (const p of pts) delete p.id;
      this.minutes.set(id, pts);
      if (pts.length < lines.length - 1) this.rewrite(id);   // drop expired lines
    }
  }

  rewrite(id) {
    const pts = this.minutes.get(id) || [];
    fs.writeFileSync(this.file(id), pts.map(p => JSON.stringify({ id, ...p })).join('\n') + (pts.length ? '\n' : ''));
  }

  add(id, sample) {
    const raw = this.raw.get(id) || (this.raw.set(id, []), this.raw.get(id));
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
    const mins = this.minutes.get(id) || (this.minutes.set(id, []), this.minutes.get(id));
    mins.push(p);
    const cutoff = Date.now() - KEEP_MS;
    if (mins.length && mins[0].t < cutoff - 24 * 60 * 60 * 1000) {   // prune about once a day
      while (mins.length && mins[0].t < cutoff) mins.shift();
      this.rewrite(id);
    } else {
      fs.appendFileSync(this.file(id), JSON.stringify({ id, ...p }) + '\n');
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
    fs.rm(this.file(id), { force: true }, () => {});
  }

  close() { for (const [id, pend] of this.pending) this.commit(id, pend); this.pending.clear(); }
}

module.exports = { HistoryStore, FIELDS };
