// Authenticated desktop requests always use the enrolled origin. Pinning is checked
// by TLS before Node sends headers or a report, including after DNS changes.
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');

let trustedAuthorities;
function authorities() {
  if (!trustedAuthorities && tls.getCACertificates) {
    trustedAuthorities = [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])];
  }
  return trustedAuthorities;
}
const isLoopHost = h => ['127.0.0.1', 'localhost', '[::1]'].includes(h);
function origin(value, allowLoopback = false) {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
    if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])$/i.test(u.hostname)) return null;
    return u.protocol === 'https:' || (allowLoopback && u.protocol === 'http:' && isLoopHost(u.hostname)) ? u.origin : null;
  } catch { return null; }
}
function publicKeyPin(cert) {
  const spki = new crypto.X509Certificate(cert.raw).publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(spki).digest('base64');
}

function hubRequest(base, resource, { method = 'GET', token, body, pin, signal, timeout = 8000, stream = false } = {}) {
  if (!origin(base, true) || !/^\/(?!\/)/.test(resource)) return Promise.reject(new Error('Invalid hub destination'));
  const url = new URL(resource, base);
  if (url.origin !== base) return Promise.reject(new Error('Cross-origin hub request refused'));
  const secure = url.protocol === 'https:';
  if (token && secure && !pin) return Promise.reject(new Error('Missing enrolled TLS identity'));
  const data = body == null ? null : Buffer.from(body);
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
  let verifiedPin;
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(url, { method, headers, signal, agent: false, ...(secure ? {ca:authorities()} : {}),
      checkServerIdentity(host, cert) {
        const error = tls.checkServerIdentity(host, cert);
        if (error) return error;
        verifiedPin = publicKeyPin(cert);
        if (pin && pin !== verifiedPin) return new Error('Hub TLS identity changed. Pair again from the hub.');
      }
    }, res => {
      if (stream) req.setTimeout(0);
      if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); return reject(new Error('Hub redirect refused')); }
      resolve({ res, pin: verifiedPin });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('Hub request timed out')));
    req.end(data);
  });
}
async function readBytes(body, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > limit) throw new Error('Response too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}
async function hubJson(base, resource, options = {}) {
  const { res, pin } = await hubRequest(base, resource, { ...options, signal: options.signal || AbortSignal.timeout(8000) });
  const raw = await readBytes(res, 64 * 1024);
  const json = JSON.parse(raw.toString('utf8'));
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(typeof json.error === 'string' ? json.error.slice(0, 240) : 'HTTP ' + res.statusCode);
  return { json, pin };
}
module.exports = { origin, isLoopHost, publicKeyPin, hubRequest, hubJson, readBytes };
