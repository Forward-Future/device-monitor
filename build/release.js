// Push an update to every device:  npm run release
//
//  1. bumps the patch version (or: npm run release -- --version 1.4.0, or --no-bump)
//  2. builds the installer for this OS
//  3. signs an update manifest with your release key (created on first run, kept OUTSIDE the
//     repo at ~/.device-monitor/release-key.pem — back it up; apps only accept updates signed by it)
//  4. publishes installer + manifest to the hub's downloads folder (default: this PC's hub), and
//     tells connected apps, which verify the signature, install silently and restart.
//
// Options: --no-build (re-publish what's already in dist/), --publish-dir <folder>, --no-bump
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { signedPayload } = require('../updater');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const flag = name => args.includes(name);

const KEY_DIR = path.join(os.homedir(), '.device-monitor');
const PRIVATE_KEY = path.join(KEY_DIR, 'release-key.pem');
const PUBLIC_KEY = path.join(ROOT, 'build', 'update-key.pub.pem');
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : null;
if (!platform) { console.error('Releases are built on Windows or macOS.'); process.exit(1); }

// ---- 1. release key ---------------------------------------------------------------
if (!fs.existsSync(PRIVATE_KEY)) {
  if (fs.existsSync(PUBLIC_KEY) && !flag('--new-key')) {
    console.error(`No release key at ${PRIVATE_KEY}, but the app already trusts ${path.relative(ROOT, PUBLIC_KEY)}.\n` +
      'Restore your key from backup. (Or pass --new-key to make a new one — installed apps would then need a manual reinstall.)');
    process.exit(1);
  }
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(PRIVATE_KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`Created release key ${PRIVATE_KEY} (back this up!) and ${path.relative(ROOT, PUBLIC_KEY)}.`);
}
const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY));
const publicKey = crypto.createPublicKey(fs.readFileSync(PUBLIC_KEY));
const probe = Buffer.from('check');
if (!crypto.verify(null, probe, publicKey, crypto.sign(null, probe, privateKey))) {
  console.error(`${PRIVATE_KEY} doesn't match ${path.relative(ROOT, PUBLIC_KEY)}.`); process.exit(1);
}

// ---- 2. version -------------------------------------------------------------------
const pkgFile = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
if (!flag('--no-build') && !flag('--no-bump')) {
  const v = opt('--version') || pkg.version.replace(/(\d+)$/, n => String(Number(n) + 1));
  if (!/^\d+\.\d+\.\d+$/.test(v)) { console.error('Version must look like 1.2.3'); process.exit(1); }
  pkg.version = v;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
}
console.log(`Releasing Device Monitor ${pkg.version} for ${platform}`);

// ---- 3. build ---------------------------------------------------------------------
if (!flag('--no-build')) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  execSync(`npm run ${platform === 'windows' ? 'dist' : 'dist:mac'}`, { cwd: ROOT, stdio: 'inherit', env });
}
const distFile = platform === 'windows' ? `Device Monitor Setup ${pkg.version}.exe` : 'Device Monitor.dmg';
const src = path.join(ROOT, 'dist', distFile);
if (!fs.existsSync(src)) { console.error(`Missing ${src}`); process.exit(1); }
const file = platform === 'windows' ? distFile : `Device Monitor ${pkg.version}.dmg`;

// ---- 4. sign + publish ------------------------------------------------------------
const data = fs.readFileSync(src);
const manifest = { platform, version: pkg.version, file, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), released: new Date().toISOString() };
manifest.signature = crypto.sign(null, Buffer.from(signedPayload(manifest)), privateKey).toString('base64');

const appData = process.platform === 'win32' ? process.env.APPDATA : path.join(os.homedir(), 'Library', 'Application Support');
const publishDir = opt('--publish-dir') || path.join(appData, 'Device Monitor', 'hub', 'downloads');
fs.mkdirSync(publishDir, { recursive: true });
const ext = path.extname(file).toLowerCase();
for (const f of fs.readdirSync(publishDir)) {   // keep only the newest installer per platform
  if (f !== file && path.extname(f).toLowerCase() === ext && f.startsWith('Device Monitor')) fs.rmSync(path.join(publishDir, f), { force: true });
}
fs.copyFileSync(src, path.join(publishDir, file));
fs.writeFileSync(path.join(publishDir, `update-${platform}.json`), JSON.stringify(manifest, null, 2));
console.log(`Published ${file} (${(manifest.size / 1e6).toFixed(1)} MB) to ${publishDir}`);
console.log('Connected apps will verify, install and restart on their own (when idle).');
