// Test fixture: hub on :7788 with 7 days of synthetic history + live fake reports.
const fs = require('fs'), path = require('path'), os = require('os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-hist-test-'));
fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
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
startHub({ port: 7788, dataDir: dir, rootDir: path.join(__dirname, '../..'), fixture: true }).then(hub => {
  console.log('Synthetic test hub on loopback :7788');
  if (process.argv.includes('--invite') && process.stdout.isTTY) console.log(hub.browserLink());
  const want = {}, results = {};
  const fakeProcs = d => ['chrome', 'Code', 'python3', 'node', 'explorer', 'Discord', 'obs64', 'svchost', 'MsMpEng', 'steam'].map((name, i) => ({
    pid: 1000 + i * 37, name, cpu: Math.max(0, 30 / (i + 1) + Math.random() * 3), mem: (12 - i) * 3e8, gpuMem: name === 'python3' ? 20e9 : null, gpu: name === 'python3' ? 88 : null,
    cmd: name === 'python3' ? 'python3 train.py --epochs 40' : null }));
  const tick = () => {
    for (const d of devs) {
      if (d.id === 'nas' && d.sent) continue;   // reports once, then goes offline (Wake-on-LAN test)
      d.sent = true;
      const t = Date.now(), cpu = Math.max(0, wave(t, 3e4, 40, 30));
      const reply = hub.seedReport({
        id: d.id, hostname: d.name, platform: 'linux', os: 'Test OS', uptime: 3600,
        formFactor: d.id === 'mbp' ? 'laptop' : 'desktop', power: d.id === 'dgx' ? { cpu: 85 } : null,
        cpu: { name: 'Test CPU', usage: cpu, cores: [cpu, cpu / 2], temp: 45 + cpu * 0.4 },
        memory: { total: 64e9, used: 36e9 }, gpus: [{ name: 'Test GPU', usage: 90, temp: 80, power: d.id === 'mbp' ? null : 500, memUsed: 10e9, memTotal: d.id === 'mbp' ? 0 : 48e9 }],
        disks: [{ name: '/', total: 1e12, used: d.id === 'lab' ? 9.5e11 : 4e11 }], net: { rx: 1e5, tx: 5e4 }, diskIO: { read: 1e6, write: 2e6 },
        ai: d.id === 'dgx' ? [{ app: 'ComfyUI', mem: 110255669248, models: [{ name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', size: 20970379616, kind: 'unet' }, { name: 'qwen3vl_32b_minimax_h3_bf16.safetensors', size: 51506295256, kind: 'clip' }, { name: 'minimax_h3_video_vae_int8_convrot.safetensors', size: 2811065184, kind: 'vae' }] }, { app: 'Ollama', mem: 5.2e9, models: [{ name: 'qwen3:8b', size: 6.1e9 }] }] : d.id === 'ws' ? [] : undefined,
        features: ['procs', 'actions'], actions: d.id === 'mbp' ? [] : ['sleep', 'restart', 'shutdown'], macs: ['aa:bb:cc:dd:ee:0' + devs.indexOf(d)],
        processes: want[d.id] ? fakeProcs(d) : undefined, actionResult: results[d.id] });
      want[d.id] = !!reply.procs; results[d.id] = undefined;
      for (const c of reply.commands || []) results[d.id] = { id: c.id, ok: c.action !== 'shutdown', message: c.action === 'shutdown' ? 'Test device refused (fake)' : 'Fake ' + c.action + ' done' };
    }
  };
  tick(); setInterval(tick, 2000);
});
