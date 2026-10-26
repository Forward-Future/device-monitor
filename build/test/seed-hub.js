// Test fixture: hub on :7788 with 7 days of synthetic history + live fake reports.
const fs = require('fs'), path = require('path'), os = require('os');
const dir = path.join(os.tmpdir(), 'dm-hist-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
const token = 'testtoken';
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ token }));
const devs = [{ id: 'ws', name: 'Workstation' }, { id: 'dgx', name: 'DGX Test' }, { id: 'mbp', name: 'MacBook Pro' }, { id: 'nas', name: 'NAS' }, { id: 'lab', name: 'Lab PC' }];
const now = Date.now(), MIN = 60e3;
const wave = (t, p, a, b) => a + b * Math.sin(t / p);
for (const d of devs) {
  const lines = [];
  for (let t = Math.floor((now - 7 * 86400e3) / MIN) * MIN; t < now - 2 * MIN; t += MIN) {
    if (d.id === 'dgx' && t > now - 30 * 3600e3 && t < now - 26 * 3600e3) continue; // offline gap
    const cpu = Math.max(0, wave(t, 3.6e6, 35, 30) + Math.random() * 10), gpu = (Math.floor(t / 7.2e6) % 3 === 0) ? 95 : 10 + Math.random() * 5;
    lines.push(JSON.stringify({ id: d.id, t, cpu, gpu, mem: 55 + Math.random() * 5, cpuTemp: 45 + cpu * 0.4, gpuTemp: 40 + gpu * 0.45, gpuPower: 80 + gpu * 5, rx: 2e4 + Math.random() * 5e5, tx: 1e4 + Math.random() * 2e5, dr: Math.random() * 5e7, dw: Math.random() * 3e7, cpuMax: Math.min(100, cpu + 20), gpuMax: gpu, cpuTempMax: 50 + cpu * 0.45, gpuTempMax: 42 + gpu * 0.47 }));
  }
  fs.writeFileSync(path.join(dir, 'history', d.id + '.ndjson'), lines.join('\n') + '\n');
}
const { startHub } = require('../../server');
startHub({ port: 7788, dataDir: dir, rootDir: path.join(__dirname, '../..') }).then(() => {
  console.log('test hub on :7788');
  const tick = () => {
    for (const d of devs) {
      const t = Date.now(), cpu = Math.max(0, wave(t, 3e4, 40, 30));
      fetch('http://127.0.0.1:7788/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        id: d.id, token, hostname: d.name, platform: 'linux', os: 'Test OS', uptime: 3600,
        cpu: { name: 'Test CPU', usage: cpu, cores: [cpu, cpu / 2], temp: 45 + cpu * 0.4 },
        memory: { total: 64e9, used: 36e9 }, gpus: [{ name: 'Test GPU', usage: 90, temp: 80, power: 500, memUsed: 10e9, memTotal: 48e9 }],
        disks: [{ name: '/', total: 1e12, used: 4e11 }], net: { rx: 1e5, tx: 5e4 }, diskIO: { read: 1e6, write: 2e6 } }) }).catch(() => {});
    }
  };
  tick(); setInterval(tick, 2000);
});
