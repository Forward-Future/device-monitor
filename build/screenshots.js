// Regenerates the README screenshots in docs/screenshots/.
// Starts a demo hub on :7799 with realistic devices and 7 days of history, then drives a
// headless Chrome/Edge over the DevTools protocol to capture each view.
//   node build/screenshots.js
const fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');

const PORT = 7799, W = 1440, H = 900;
const out = path.join(__dirname, '..', 'docs', 'screenshots');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-screenshots-'));
fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
fs.mkdirSync(out, { recursive: true });
const GB = 1e9, TB = 1e12;

const devs = [
  { id: 'gaming', name: 'Gaming PC', platform: 'windows', os: 'Windows 11 Pro', formFactor: 'desktop', uptime: 5.2 * 3600,
    cpu: { name: 'AMD Ryzen 9 9950X3D', threads: 32, base: 22, swing: 18, clock: 5250, temp: 52 }, mem: 64 * GB, memUse: 0.48,
    gpu: { name: 'NVIDIA GeForce RTX 5090', base: 70, swing: 25, mem: 32 * GB, power: 575, temp: 66 },
    disks: [{ name: 'C:', label: 'Windows', total: 2 * TB, used: 1.1 * TB }, { name: 'D:', label: 'Games', total: 4 * TB, used: 3.1 * TB }],
    fans: [['CPU fan', 1240], ['Rear', 980], ['Front 1', 1110], ['Front 2', 1105]], temps: [['CPU Package', 61], ['Motherboard', 38], ['NVMe 1', 44], ['NVMe 2', 41]] },
  { id: 'spark', name: 'DGX Spark', platform: 'linux', os: 'Ubuntu 24.04 LTS', formFactor: 'desktop', uptime: 12 * 86400,
    cpu: { name: 'NVIDIA Grace (Cortex-X925)', threads: 20, base: 18, swing: 10, clock: 3900, temp: 58 }, mem: 128 * GB, memUse: 0.86, cpuPower: 38,
    gpu: { name: 'NVIDIA GB10', base: 88, swing: 10, mem: 0, power: 140, temp: 71 },
    disks: [{ name: '/', total: 4 * TB, used: 2.3 * TB }],
    ai: [{ app: 'ComfyUI', mem: 62e9, models: [{ name: 'flux2_dev_fp8.safetensors', size: 23.8e9, kind: 'unet' }, { name: 'qwen3_vl_8b.safetensors', size: 16.4e9, kind: 'clip' }, { name: 'flux2_vae.safetensors', size: 0.34e9, kind: 'vae' }] },
         { app: 'Ollama', mem: 21e9, models: [{ name: 'qwen3:32b', size: 20.1e9 }] }] },
  { id: 'mbp', name: 'MacBook Pro', platform: 'macos', os: 'macOS 26.1', formFactor: 'laptop', uptime: 3 * 86400,
    cpu: { name: 'Apple M4 Max', threads: 16, base: 14, swing: 10, clock: 4500, temp: 49 }, mem: 48 * GB, memUse: 0.62,
    gpu: { name: 'Apple M4 Max GPU', base: 12, swing: 8, mem: 0, power: null, temp: null },
    disks: [{ name: '/', label: 'Macintosh HD', total: 2 * TB, used: 0.9 * TB }] },
  { id: 'server', name: 'Home Server', platform: 'linux', os: 'Debian 13', formFactor: 'desktop', uptime: 41 * 86400,
    cpu: { name: 'Intel Core i5-13500', threads: 20, base: 9, swing: 5, clock: 2500, temp: 41 }, mem: 32 * GB, memUse: 0.41,
    gpu: null,
    disks: [{ name: '/', total: 0.5 * TB, used: 0.12 * TB }, { name: '/mnt/media', label: 'Media', total: 16 * TB, used: 11.8 * TB }, { name: '/mnt/backup', label: 'Backup', total: 8 * TB, used: 7.6 * TB }] },
];

// Smooth, slightly noisy load curves so the charts look like real machines.
const wave = (t, base, swing, phase) => Math.max(0, Math.min(100,
  base + swing * (0.6 * Math.sin(t / 2.1e6 + phase) + 0.4 * Math.sin(t / 5.3e5 + phase * 3)) + (Math.random() - 0.5) * swing * 0.3));
const sample = (d, t, i) => {
  const cpu = wave(t, d.cpu.base, d.cpu.swing, i), gpu = d.gpu ? wave(t, d.gpu.base, d.gpu.swing, i + 1) : null;
  return { cpu, gpu, mem: d.memUse * 100 + Math.sin(t / 3e6 + i) * 3,
    cpuTemp: d.cpu.temp + cpu * 0.25, gpuTemp: d.gpu?.temp != null ? d.gpu.temp - 20 + gpu * 0.25 : null,
    gpuPower: d.gpu?.power ? d.gpu.power * (0.12 + 0.85 * gpu / 100) : null };
};

const now = Date.now(), MIN = 60e3;
devs.forEach((d, i) => {
  const lines = [];
  for (let t = Math.floor((now - 7 * 86400e3) / MIN) * MIN; t < now - MIN; t += MIN) {
    if (d.id === 'mbp' && new Date(t).getHours() < 7) continue;   // laptop asleep overnight
    const s = sample(d, t, i);
    lines.push(JSON.stringify({ id: d.id, t, ...s, rx: 1e5 + Math.random() * (d.id === 'server' ? 4e6 : 8e5), tx: 4e4 + Math.random() * (d.id === 'server' ? 2e6 : 2e5),
      dr: Math.random() * 3e7, dw: Math.random() * 2e7, cpuMax: Math.min(100, s.cpu + 15), gpuMax: s.gpu, cpuTempMax: s.cpuTemp + 4, gpuTempMax: s.gpuTemp != null ? s.gpuTemp + 3 : null }));
  }
  fs.writeFileSync(path.join(dir, 'history', d.id + '.ndjson'), lines.join('\n') + '\n');
});

function report(d, i) {
  const t = Date.now(), s = sample(d, t, i);
  return { id: d.id, hostname: d.name, platform: d.platform, os: d.os, uptime: d.uptime + (t - now) / 1000, formFactor: d.formFactor,
    appVersion: require('../package.json').version, power: d.cpuPower ? { cpu: d.cpuPower } : null,
    cpu: { name: d.cpu.name, usage: s.cpu, threads: d.cpu.threads, clockMHz: d.cpu.clock, temp: s.cpuTemp,
      cores: Array.from({ length: d.cpu.threads }, () => Math.max(0, Math.min(100, s.cpu + (Math.random() - 0.5) * 30))) },
    memory: { total: d.mem, used: d.mem * s.mem / 100 },
    gpus: d.gpu ? [{ name: d.gpu.name, vendor: /Apple/.test(d.gpu.name) ? 'apple' : 'nvidia', usage: s.gpu, temp: s.gpuTemp, power: s.gpuPower, powerLimit: d.gpu.power,
      memUsed: d.gpu.mem * (0.3 + 0.6 * s.gpu / 100), memTotal: d.gpu.mem, fan: s.gpuTemp != null ? 30 + s.gpu * 0.4 : null, clockMHz: d.gpu.power ? 2400 + s.gpu * 3 : null }] : [],
    disks: d.disks, net: { rx: 2e5 + Math.random() * 1.5e6, tx: 5e4 + Math.random() * 3e5 }, diskIO: { read: Math.random() * 2e7, write: Math.random() * 1e7 },
    temps: (d.temps || []).map(([name, v]) => ({ name, parent: 'Motherboard', value: v + Math.random() * 2 })),
    fans: (d.fans || []).map(([name, rpm]) => ({ name, rpm: rpm + Math.random() * 30 })),
    ai: d.ai, features: ['procs', 'actions'], actions: ['sleep', 'restart', 'shutdown'] };
}

// Minimal DevTools-protocol client (Node's built-in WebSocket).
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let seq = 0; const pending = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => ws.close() };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browsers = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'];

(async () => {
  const { startHub } = require('../server');
  const hub = await startHub({ port: PORT, dataDir: dir, rootDir: path.join(__dirname, '..'), fixture:true });
  const tick = () => devs.forEach((d,i) => hub.seedReport(report(d,i)));
  tick(); const timer = setInterval(tick, 2000);
  await sleep(3000);

  const exe = browsers.find(b => fs.existsSync(b));
  if (!exe) throw new Error('No Chrome or Edge found');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-shot-profile-'));
  const browser = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try {
      const port = Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);
      target = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json()).then(l => l.find(t => t.type === 'page'));
    } catch {}
  }
  const page = await cdp(target.webSocketDebuggerUrl);
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  const base = `http://127.0.0.1:${PORT}/`;
  const go = async (hash, wait = 3500) => { await page.send('Page.navigate', { url: base + hash }); await sleep(wait); };
  const evaluate = expr => page.send('Runtime.evaluate', { expression: expr, awaitPromise: true });
  const resize = height => page.send('Emulation.setDeviceMetricsOverride', { width: W, height, deviceScaleFactor: 2, mobile: false });
  // clip: a CSS selector to capture just that element (plus a 16px margin).
  const shot = async (name, clip) => {
    await sleep(800);
    let params = { format: 'png' };
    if (clip) {
      const { result } = await evaluate(`JSON.stringify(document.querySelector(${JSON.stringify(clip)}).getBoundingClientRect())`);
      const r = JSON.parse(result.value), pad = 16;
      params.clip = { x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad, scale: 1 };
    }
    const { data } = await page.send('Page.captureScreenshot', params);
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(data, 'base64'));
    console.log('saved', name);
  };

  await page.send('Page.navigate', { url: hub.browserLink() });
  await sleep(1000);
  await go('');
  await evaluate(`localStorage.setItem('range', '1h'); localStorage.setItem('hvRange', '24h')`);
  await go('', 5000);
  await resize(580);   // just the row of cards
  await shot('dashboard');
  // One card with Details open: sensors and the AI models loaded on the GPU.
  await resize(1800);
  await evaluate(`document.querySelector('.card[data-id="spark"] details').open = true`);
  await shot('card-details', '.card[data-id="spark"]');
  await resize(H);
  await go('#/history/spark', 4000);
  await shot('history');
  await go('#/advanced', 4000);
  await shot('advanced');

  page.close(); browser.kill(); clearInterval(timer); hub.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
