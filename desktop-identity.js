// Desktop enrollments already share two independent, random credentials with
// the hub. Only their SHA-256 verifiers are stored on the hub. Neither bearer
// nor either verifier crosses a connection whose TLS pin is being challenged.
const crypto = require('node:crypto');

const credentialDigest = token => crypto.createHash('sha256').update(token).digest('hex');

function desktopKey(agentDigest, clientDigest) {
  if (![agentDigest, clientDigest].every(d => typeof d === 'string' && /^[0-9a-f]{64}$/.test(d))) return null;
  return crypto.createHmac('sha256', Buffer.from(clientDigest, 'hex'))
    .update('device-monitor/desktop-tls/v1\0').update(Buffer.from(agentDigest, 'hex')).digest();
}

function mac(key, role, ...fields) {
  return crypto.createHmac('sha256', key).update(JSON.stringify([role, ...fields])).digest('base64url');
}

module.exports = { credentialDigest, desktopKey, mac };
