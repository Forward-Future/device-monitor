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
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { readBytes } = require('./transport');

const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : null;
const MAX_SIZE = 600 * 1024 * 1024;

function signedPayload(m) {
  return ['device-monitor-update', m.platform, m.version, m.file, m.size, m.sha256].join('\n');
}

function verifyManifest(m, publicKeyPem) {
  if (!m || typeof m !== 'object') return 'invalid manifest';
  if (m.platform !== PLATFORM) return 'wrong platform';
  if (typeof m.version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,8}$/.test(m.version)) return 'bad version';
  if (typeof m.file !== 'string' || m.file !== path.basename(m.file) || !(PLATFORM === 'windows' ? /\.exe$/i : /\.(dmg|zip)$/i).test(m.file)) return 'bad file name';
  if (!Number.isInteger(m.size) || m.size <= 0 || m.size > MAX_SIZE) return 'bad size';
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return 'bad hash';
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
  constructor({ app, hubUrl, publicKeyPem, dir, canInstall, manualDownload, isBusy, isVisible, onStatus, request = fetch, log = console.log }) {
    Object.assign(this, { app, hubUrl, publicKeyPem, dir, canInstall, manualDownload, isBusy, isVisible, onStatus, request, log });
    this.status = { state: publicKeyPem && PLATFORM ? 'idle' : 'unavailable', version: null, message: null, lastCheck: null };
    this.timer = null; this.checking = null; this.waitStarted = null;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(dir)) {
      if (!/^dm-[a-f0-9-]+\.(part|exe|dmg|zip)$/.test(f)) continue;
      try { fs.rmSync(path.join(dir, f), { force:true }); }
      catch (e) { this.log('Staged update still in use; cleanup deferred:', e.code); }
    }
  }

  set(patch) { this.status = { ...this.status, ...patch }; this.onStatus?.(this.status); }

  start(intervalMs = 15 * 60e3) {
    if (this.status.state === 'unavailable') return;
    this.firstCheck = setTimeout(() => this.check(), 20e3);
    this.timer = setInterval(() => this.check(), intervalMs);
  }
  stop() { clearInterval(this.timer); clearTimeout(this.firstCheck); clearTimeout(this.retry); }

  check() {
    if (this.installing || this.status.state === 'unavailable' || !this.hubUrl()) return Promise.resolve(this.status);
    if (!this.checking) {
      this.checking = this._check().finally(() => { this.checking = null; this.maybeInstall(); });
    }
    return this.checking;
  }

  async _check() {
    const base = this.hubUrl();
    const previous = this.readyFile ? { ...this.status } : null;
    try {
      if (!previous) this.set({ state: 'checking', message: null });
      const res = await this.request(base + '/api/update/' + PLATFORM, { redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (res.status === 404) {
        await res.body?.cancel();
        if (!previous) this.set({ state: 'idle', version: null });
        return this.status;
      }
      if (!res.ok) { await res.body?.cancel(); throw new Error('HTTP ' + res.status); }
      const m = JSON.parse((await readBytes(res.body, 32 * 1024)).toString('utf8'));
      const problem = verifyManifest(m, this.publicKeyPem);
      if (problem) throw new Error('update rejected: ' + problem);
      if (!newer(m.version, this.app.getVersion())) {
        if (!previous) this.set({ state: 'idle', version: null });
        return this.status;
      }
      if (!this.manualDownload?.() && !this.canInstall()) {
        this.set({ state: 'source-release', version: m.version, lastCheck: Date.now() });
        return this.status;
      }
      if (!this.readyFile || signedPayload(m) !== signedPayload(this.readyManifest)) {
        this.set({ state: 'downloading', version: m.version });
        const file = await this.download(base + '/download/' + encodeURIComponent(m.file), m);
        const old = this.readyFile;
        this.readyFile = file; this.readyManifest = m; this.waitStarted = Date.now();
        if (old) await fs.promises.unlink(old).catch(() => {});
      }
      this.set({ state: PLATFORM === 'windows' ? 'ready' : 'ready-download', version: m.version, lastCheck: Date.now() });
    } catch (e) {
      this.log('update check failed:', e.message);
      if (previous) this.set({ ...previous, lastCheck: Date.now() });
      else this.set({ state: 'error', message: e.message, lastCheck: Date.now() });
    }
    return this.status;
  }

  async download(url, m) {
    const res = await this.request(url, { redirect: 'error', signal: AbortSignal.timeout(10 * 60e3) });
    if (!res.ok) { await res.body?.cancel(); throw new Error('download failed: HTTP ' + res.status); }
    const base = path.join(this.dir, 'dm-' + crypto.randomUUID());
    const tmp = base + '.part', file = base + path.extname(m.file).toLowerCase();
    const hash = crypto.createHash('sha256');
    let size = 0;
    const verify = new Transform({ transform(chunk, enc, done) {
      size += chunk.length;
      if (size > m.size) return done(new Error('download larger than expected'));
      hash.update(chunk); done(null, chunk);
    } });
    try {
      await pipeline(res.body, verify, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      if (size !== m.size || hash.digest('hex') !== m.sha256) throw new Error('installer integrity check failed');
      await fs.promises.rename(tmp, file);
      return file;
    } finally { await fs.promises.rm(tmp, { force: true }); }
  }

  async openManual(open) {
    if (this.status.state !== 'ready-download' || !this.readyFile || !this.readyManifest) return false;
    const file = this.readyFile, expected = this.readyManifest.sha256;
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    if (hash.digest('hex') !== expected || file !== this.readyFile) throw new Error('installer integrity check failed');
    await open(file);
    return true;
  }

  // Don't restart the app while someone is looking at it — but don't wait forever either.
  maybeInstall(force = false) {
    if (this.installing || this.checking || this.status.state !== 'ready' || !this.readyFile || (!force && !this.canInstall())) return false;
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
    this.installing = true;
    clearTimeout(this.retry);
    this.set({ state: 'installing' });
    const q = s => `'${String(s).replace(/'/g, "''")}'`;
    const relaunchArgs = this.isVisible() ? '' : " -ArgumentList '--hidden'";
    const logFile = path.join(path.dirname(this.dir), 'update.log');
    const helper = [
      `$log = ${q(logFile)}`,
      `function L($m) { "$(Get-Date -Format s) $m" | Out-File -Append -Encoding utf8 -FilePath $log }`,
      `L 'update ${this.status.version}: waiting for the app to exit'`,
      `Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue`,
      `$file = ${q(this.readyFile)}`,
      `try {`,
      `  $handle = [IO.File]::Open($file, 'Open', 'Read', 'Read')`,
      `  $sha = [Security.Cryptography.SHA256]::Create()`,
      `  $actual = [BitConverter]::ToString($sha.ComputeHash($handle)).Replace('-','')`,
      `  if ($actual -ine ${q(this.readyManifest.sha256)}) { throw 'Installer digest mismatch' }`,
      `  $p = Start-Process -FilePath $file -ArgumentList '/S','--updated' -Wait -PassThru -ErrorAction Stop`,
      `  L "installer exit code $($p.ExitCode)"`,
      `} catch { L "installer failed: $_" } finally { if ($handle) { $handle.Dispose() }; if ($sha) { $sha.Dispose() } }`,
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
          this.installing = false;
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
