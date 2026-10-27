// Remote access through Tailscale (https://tailscale.com): a private network between your own
// devices, so the dashboard works away from home without opening anything to the internet.
// The hub only reads Tailscale's status and, when asked from the hub PC itself, turns on
// `tailscale serve` (an HTTPS address on your tailnet that forwards to the hub).
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// [path, extra args]. Besides the normal installs, a Windows PC can run Tailscale in user mode
// (no admin rights) from %LOCALAPPDATA%\dm-tailscale, listening on its own pipe.
function cli() {
  const candidates = process.platform === 'win32'
    ? [[path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'), []],
       [path.join(process.env.LOCALAPPDATA || '', 'dm-tailscale', 'bin', 'tailscale.exe'), ['--socket=\\\\.\\pipe\\dm-tailscaled']]]
    : process.platform === 'darwin'
      ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'].map(f => [f, []])
      : ['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale'].map(f => [f, []]);
  return candidates.find(([f]) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
}

function run(args, timeout = 8000) {
  const c = cli();
  if (!c) return Promise.resolve({ ok: false, out: '', err: 'not installed' });
  const [exe, pre] = c;
  return new Promise(resolve => execFile(exe, pre.concat(args), { timeout, windowsHide: true, maxBuffer: 4 << 20 },
    (e, out, err) => resolve({ ok: !e, out: String(out || ''), err: String(err || (e && e.message) || '') })));
}

let cache = null;
async function status(port, { fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 30e3) return cache.value;
  const value = await readStatus(port);
  cache = { at: Date.now(), value };
  return value;
}

async function readStatus(port) {
  if (!cli()) return { installed: false };
  const r = await run(['status', '--json']);
  let j = null;
  try { j = JSON.parse(r.out); } catch {}
  if (!j) return { installed: true, running: false, state: 'NotRunning' };
  const self = j.Self || {};
  const running = j.BackendState === 'Running';
  const ip = (self.TailscaleIPs || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || null;
  const dnsName = String(self.DNSName || '').replace(/\.$/, '') || null;
  let httpsUrl = null;
  if (running) {
    const s = await run(['serve', 'status', '--json']);
    try {
      for (const [hostPort, site] of Object.entries(JSON.parse(s.out).Web || {})) {
        const proxies = Object.values(site.Handlers || {}).map(h => h.Proxy || '');
        if (proxies.some(p => new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`).test(p))) httpsUrl = 'https://' + hostPort.replace(/:443$/, '');
      }
    } catch {}
  }
  const urls = running ? [httpsUrl, ip && `http://${ip}:${port}`, dnsName && `http://${dnsName}:${port}`].filter(Boolean) : [];
  return { installed: true, running, state: j.BackendState || null, ip, dnsName, httpsUrl, urls, tailnet: j.CurrentTailnet?.Name || null };
}

// HTTPS on the tailnet: https://<machine>.<tailnet>.ts.net -> http://127.0.0.1:<port>.
// The first time, Tailscale may need HTTPS turned on for the tailnet; it prints a link for that.
async function setHttps(port, on) {
  const r = on ? await run(['serve', '--bg', `http://127.0.0.1:${port}`], 20e3) : await run(['serve', '--https=443', 'off'], 15e3);
  cache = null;
  const text = (r.out + '\n' + r.err).trim();
  const link = text.match(/https:\/\/login\.tailscale\.com\/\S+/);
  const st = await status(port, { fresh: true });
  if (on && !st.httpsUrl) return { ok: false, enableUrl: link ? link[0] : null, error: link ? 'HTTPS needs to be turned on for your tailnet first.' : text.split('\n').pop() || 'Tailscale refused.', status: st };
  return { ok: true, status: st };
}

// Addresses where a hub might be, on this computer's online Tailscale peers (for apps that are
// away from home and haven't learned the hub's Tailscale address yet).
async function peerUrls(port = 7777) {
  const r = await run(['status', '--json']);
  let j = null;
  try { j = JSON.parse(r.out); } catch { return []; }
  if (j.BackendState !== 'Running') return [];
  const out = [];
  for (const p of Object.values(j.Peer || {})) {
    if (!p.Online) continue;
    const dns = String(p.DNSName || '').replace(/\.$/, '');
    const ip = (p.TailscaleIPs || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    if (dns) out.push(`https://${dns}`);
    if (ip) out.push(`http://${ip}:${port}`);
  }
  return out.slice(0, 40);
}

module.exports = { status, setHttps, peerUrls, installed: () => !!cli() };
