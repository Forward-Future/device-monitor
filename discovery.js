// LAN auto-discovery: hubs answer UDP broadcasts so new devices can find them without typing an IP.
const dgram = require('dgram');
const os = require('os');
const { isPrivateAddress } = require('./security');

const DISCOVERY_PORT = 7778;
const PROBE = 'device-monitor:discover';

function respond({ port, name = os.hostname() }) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg, rinfo) => {
    if (msg.toString() !== PROBE || !isPrivateAddress(rinfo.address)) return;   // only answer LAN peers
    sock.send(JSON.stringify({ app: 'device-monitor', name, port }), rinfo.port, rinfo.address);
  });
  sock.on('error', () => sock.close());
  sock.bind(DISCOVERY_PORT);
  return { close: () => { try { sock.close(); } catch {} } };
}

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

// Resolves with [{ name, url }] of hubs that answered within `timeout` ms.
function discover(timeout = 1500) {
  return new Promise(resolve => {
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      try {
        if (msg.length > 512) return;
        const r = JSON.parse(msg.toString());
        // Replies come from anyone on the LAN: accept only a sane port and a short plain name.
        if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535 || typeof r.name !== 'string') return;
        r.name = r.name.replace(/[^\w .()'-]/g, '').slice(0, 64) || rinfo.address;
        // One entry per hub; prefer typical LAN addresses over virtual adapters (WSL/Hyper-V use 172.16-31.x).
        const virtual = /^172\.(1[6-9]|2\d|3[01])\./.test(rinfo.address);
        const prev = found.get(r.name);
        if (r.app === 'device-monitor' && (!prev || (prev.virtual && !virtual)))
          found.set(r.name, { name: r.name, url: `http://${rinfo.address}:${r.port}`, virtual });
      } catch {}
    });
    sock.on('error', () => {});
    sock.bind(() => {
      sock.setBroadcast(true);
      for (const addr of broadcastAddresses()) sock.send(PROBE, DISCOVERY_PORT, addr, () => {});
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve([...found.values()]); }, timeout);
  });
}

module.exports = { respond, discover, DISCOVERY_PORT };
