// The headless agent package for Debian-based servers (Proxmox VE, Ubuntu Server): no desktop, no
// Node, just the bash collector under systemd. The hub builds it on demand, so the package always
// matches the hub, and nothing here needs dpkg, so any hub can serve it. `npm run deb` writes a copy.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { version } = require('./package.json');

// Fixed so the same version always builds the same bytes.
const MTIME = 1700000000;
const octal = (n, width) => n.toString(8).padStart(width - 1, '0') + '\0';

function tarEntry(name, mode, data) {
  const h = Buffer.alloc(512);
  const put = (text, at) => h.write(text, at, 'latin1');
  put(name, 0); put(octal(mode, 8), 100); put(octal(0, 8), 108); put(octal(0, 8), 116);
  put(octal(data ? data.length : 0, 12), 124); put(octal(MTIME, 12), 136);
  put(' '.repeat(8), 148); put(data ? '0' : '5', 156);
  put('ustar\x0000', 257); put('root', 265); put('root', 297);
  put(octal(h.reduce((sum, b) => sum + b, 0), 7), 148);
  return data ? [h, data, Buffer.alloc(-data.length & 511)] : [h];
}
// entries: [archive path, mode, Buffer]. Parent directories are added ahead of their files.
function tarGz(entries) {
  const dirs = new Set(), parts = [];
  for (const [name, mode, data] of entries) {
    const steps = name.split('/');
    for (let i = 1; i < steps.length; i++) {
      const dir = steps.slice(0, i).join('/') + '/';
      if (!dirs.has(dir)) { dirs.add(dir); parts.push(...tarEntry(dir, 0o755)); }
    }
    parts.push(...tarEntry(name, mode, data));
  }
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]), { level: 9 });
}

function arMember(name, data) {
  const field = (value, width) => String(value).padEnd(width);
  const header = field(name, 16) + field(MTIME, 12) + field(0, 6) + field(0, 6) + field('100644', 8) + field(data.length, 10) + '`\n';
  return [Buffer.from(header, 'latin1'), data, Buffer.alloc(data.length % 2, '\n')];
}

function buildAgentDeb() {
  const read = (...p) => fs.readFileSync(path.join(__dirname, ...p));
  const payload = [
    ['./usr/lib/device-monitor/agent.sh', 0o755, read('agent', 'agent.sh')],
    ['./usr/lib/systemd/system/device-monitor-agent.service', 0o644, read('agent', 'deb', 'device-monitor-agent.service')],
    ['./usr/sbin/device-monitor-enroll', 0o755, read('agent', 'deb', 'device-monitor-enroll')],
    ['./usr/share/doc/device-monitor-agent/copyright', 0o644, read('LICENSE')],
  ];
  const kib = Math.ceil(payload.reduce((sum, [, , data]) => sum + data.length, 0) / 1024);
  const control = Buffer.from([
    'Package: device-monitor-agent', `Version: ${version}`, 'Architecture: all', 'Section: admin', 'Priority: optional',
    'Maintainer: Device Monitor <device-monitor@localhost>', `Installed-Size: ${kib}`,
    'Depends: bash, curl, systemd, awk', 'Recommends: python3',
    'Description: Device Monitor agent for headless servers',
    ' Reports CPU, GPU, memory, temperatures, disks and network to a Device Monitor hub.', '',
  ].join('\n'));
  return Buffer.concat([
    Buffer.from('!<arch>\n'),
    ...arMember('debian-binary', Buffer.from('2.0\n')),
    ...arMember('control.tar.gz', tarGz([
      ['./control', 0o644, control],
      ...['postinst', 'prerm', 'postrm'].map(f => ['./' + f, 0o755, read('agent', 'deb', f)]),
    ])),
    ...arMember('data.tar.gz', tarGz(payload)),
  ]);
}

let cached = null;
const agentDeb = () => cached || (cached = buildAgentDeb());

module.exports = { agentDeb, buildAgentDeb };

if (require.main === module) {
  const out = path.join(__dirname, 'dist', `device-monitor-agent_${version}_all.deb`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildAgentDeb());
  console.log(out);
}
