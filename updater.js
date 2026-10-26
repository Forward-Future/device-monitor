// Self-update from the hub.
//
// The hub serves update-<platform>.json manifests next to the installers in its downloads folder.
// Each manifest is signed (Ed25519) by `npm run release` with a private key that never leaves the
// build machine; this app ships the matching public key. Updates are only installed if the
// signature AND the installer's SHA-256 check out, so a spoofed hub or anyone tampering with the
// plain-HTTP traffic on the LAN can't push code to your devices.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : null;
const MAX_SIZE = 600 * 1024 * 1024;

function signedPayload(m) {
  return ['device-monitor-update', m.platform, m.version, m.file, m.size, m.sha256].join('\n');
}

function verifyManifest(m, publicKeyPem) {
  if (!m || typeof m !== 'object') return 'invalid manifest';
  if (m.platform !== PLATFORM) return 'wrong platform';
  if (!/^\d+\.\d+\.\d+$/.test(m.version || '')) return 'bad version';
  if (typeof m.file !== 'string' || m.file !== path.basename(m.file) || !/\.(exe|dmg|zip)$/i.test(m.file)) return 'bad file name';
  if (!Number.isInteger(m.size) || m.size <= 0 || m.size > MAX_SIZE) return 'bad size';
  if (!/^[0-9a-f]{64}$/.test(m.sha256 || '')) return 'bad hash';
  try {
    const ok = crypto.verify(null, Buffer.from(signedPayload(m)), crypto.createPublicKey(publicKeyPem), Buffer.from(String(m.signature), 'base64'));
    return ok ? null : 'bad signature';
  } catch { return 'bad signature'; }
}

function newer(a, b) {   // is version a newer than b?
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

class Updater {
  constructor({ app, hubUrl, publicKeyPem, dir, canInstall, isBusy, isVisible, onStatus, log = console.log }) {
    Object.assign(this, { app, hubUrl, publicKeyPem, dir, canInstall, isBusy, isVisible, onStatus, log });
    this.status = { state: publicKeyPem && PLATFORM ? 'idle' : 'unavailable', version: null, message: null, lastCheck: null };
    this.timer = null; this.checking = null; this.waitStarted = null;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.rm(path.join(dir, f), { force: true }, () => {});   // leftovers from a past update
  }

  set(patch) { this.status = { ...this.status, ...patch }; this.onStatus?.(this.status); }

  start(intervalMs = 15 * 60e3) {
    if (this.status.state === 'unavailable') return;
    setTimeout(() => this.check(), 20e3);
    this.timer = setInterval(() => this.check(), intervalMs);
  }
  stop() { clearInterval(this.timer); }

  check() {
    if (this.status.state === 'unavailable' || !this.hubUrl()) return Promise.resolve(this.status);
    if (!this.checking) this.checking = this._check().finally(() => { this.checking = null; });
    return this.checking;
  }

  async _check() {
    const base = this.hubUrl();
    const current = this.app.getVersion();
    try {
      if (this.status.state !== 'ready') this.set({ state: 'checking', message: null });
      const res = await fetch(`${base}/api/update/${PLATFORM}`, { signal: AbortSignal.timeout(8000) });
      if (res.status === 404) { this.set({ state: 'idle', version: null, lastCheck: Date.now() }); return this.status; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const m = await res.json();
      const problem = verifyManifest(m, this.publicKeyPem);
      if (problem) throw new Error(`update rejected: ${problem}`);
      if (!newer(m.version, current)) { this.set({ state: 'idle', version: null, lastCheck: Date.now() }); return this.status; }

      if (!this.canInstall()) {   // e.g. macOS without a Developer ID signature, or a dev build
        this.set({ state: 'available', version: m.version, lastCheck: Date.now(), downloadUrl: `${base}/download` });
        return this.status;
      }
      const file = path.join(this.dir, m.file);
      if (this.status.state !== 'ready' || this.status.version !== m.version) {
        this.set({ state: 'downloading', version: m.version });
        await this.download(`${base}/download/${encodeURIComponent(m.file)}`, file, m);
        this.set({ state: 'ready', version: m.version, lastCheck: Date.now() });
        this.readyFile = file; this.waitStarted = Date.now();
      }
      this.maybeInstall();
    } catch (e) {
      this.log('update check failed:', e.message);
      this.set({ state: 'error', message: e.message, lastCheck: Date.now() });
    }
    return this.status;
  }

  async download(url, file, m) {
    const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60e3) });
    if (!res.ok) throw new Error('download failed: HTTP ' + res.status);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let size = 0;
    try {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > m.size) throw new Error('download larger than expected');
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
      }
    } finally { await new Promise(r => out.end(r)); }
    if (size !== m.size) throw new Error('download size mismatch');
    if (hash.digest('hex') !== m.sha256) { fs.rmSync(file, { force: true }); throw new Error('download hash mismatch'); }
  }

  // Don't restart the app while someone is looking at it — but don't wait forever either.
  maybeInstall(force = false) {
    if (this.status.state !== 'ready' || !this.readyFile) return false;
    const waited = Date.now() - (this.waitStarted || Date.now());
    if (!force && this.isBusy() && waited < 60 * 60e3) {
      clearTimeout(this.retry); this.retry = setTimeout(() => this.maybeInstall(), 5 * 60e3);
      return false;
    }
    this.install();
    return true;
  }

  // Windows: a detached helper waits for this app to exit, runs the installer silently, then
  // relaunches the app (in the background if it was running in the background).
  install() {
    this.set({ state: 'installing' });
    const q = s => `'${String(s).replace(/'/g, "''")}'`;
    const relaunchArgs = this.isVisible() ? '' : " -ArgumentList '--hidden'";
    const logFile = path.join(path.dirname(this.dir), 'update.log');
    const helper = [
      `$log = ${q(logFile)}`,
      `function L($m) { "$(Get-Date -Format s) $m" | Out-File -Append -Encoding utf8 -FilePath $log }`,
      `L 'update ${this.status.version}: waiting for the app to exit'`,
      `Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue`,
      `try { $p = Start-Process -FilePath ${q(this.readyFile)} -ArgumentList '/S','--updated' -Wait -PassThru -ErrorAction Stop; L "installer exit code $($p.ExitCode)" } catch { L "installer failed: $_" }`,
      `Start-Process -FilePath ${q(process.execPath)}${relaunchArgs}`,
      `L 'relaunched'`,
    ].join('\n');
    const commandLine = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(helper, 'utf16le').toString('base64')}`;
    // Launch the helper through WMI (Win32_Process.Create) rather than as our child: a child
    // process — even a "detached" one — can be torn down when this app exits, and the helper's
    // whole job is to outlive the app.
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine}' }).ReturnValue`],
      { windowsHide: true }, (err, stdout) => {
        if (err || String(stdout).trim() !== '0') {
          this.log('could not start the update helper:', err ? err.message : String(stdout).trim());
          this.set({ state: 'error', message: 'could not start the installer' });
          return;
        }
        this.log(`installing update ${this.status.version}`);
        this.app.emit('dm-quit-for-update');
      });
  }
}

module.exports = { Updater, verifyManifest, signedPayload, newer, PLATFORM };
