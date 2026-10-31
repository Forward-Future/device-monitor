// Authenticated desktop requests always use the enrolled origin. Pinning is checked
// by TLS before Node sends headers or a report, including after DNS changes.
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { credentialDigest, desktopKey, mac } = require('./desktop-identity');
const { safeEqual, isValidId } = require('./security');
const { validKey } = require('./access');

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

function requestOnce(base, resource, { method = 'GET', token, body, pin, signal, timeout = 8000, stream = false } = {}) {
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
        if (pin && pin !== verifiedPin) return Object.assign(new Error('Hub TLS identity changed.'), {
          code: 'ERR_DM_TLS_PIN', peerPin: verifiedPin
        });
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

// All native consumers of one enrollment share one pin and one in-flight
// proof. The initial invitation redemption deliberately uses requestOnce's
// fixed pin and cannot enter this recovery path.
function desktopTrust(base, enrollment, persist) {
  if (!base || origin(base) !== base || !/^[A-Za-z0-9+/]{43}=$/.test(enrollment.pin) ||
      !validKey(enrollment.agent) || !validKey(enrollment.client)) {
    throw new Error('Invalid desktop enrollment');
  }
  const key = desktopKey(credentialDigest(enrollment.agent), credentialDigest(enrollment.client));
  const lookup = mac(key, 'lookup'), lifetime = new AbortController();
  let pending;
  async function verify(candidate) {
    const nonce = crypto.randomBytes(32).toString('base64url');
    const { json } = await hubJson(base, '/api/desktop/tls-proof', {
      method:'POST', pin:candidate, signal:AbortSignal.any([lifetime.signal, AbortSignal.timeout(8000)]),
      body:JSON.stringify({ lookup, nonce, challenge:mac(key, 'desktop', base, nonce) })
    });
    if (!safeEqual(json?.proof, mac(key, 'hub', base, nonce, candidate))) throw new Error('Hub identity proof failed.');
    lifetime.signal.throwIfAborted();
    const previous = enrollment.pin;
    enrollment.pin = candidate;
    try { persist(); } catch (err) { enrollment.pin = previous; throw err; }
  }
  return {
    base, get pin() { return enrollment.pin; }, signal:lifetime.signal, close:() => lifetime.abort(),
    async refresh(previous, candidate) {
      lifetime.signal.throwIfAborted();
      if (enrollment.pin !== previous) return;
      if (!pending) pending = verify(candidate).finally(() => { pending = null; });
      await pending;
    }
  };
}

async function hubRequest(base, resource, options = {}) {
  const trust = options.trust;
  if (!trust) return requestOnce(base, resource, options);
  if (trust.base !== base) throw new Error('Enrolled origin changed');
  const signal = options.signal ? AbortSignal.any([options.signal, trust.signal]) : trust.signal;
  const pin = trust.pin;
  try {
    return await requestOnce(base, resource, { ...options, signal, pin });
  } catch (err) {
    // This error originates in the TLS handshake, before any HTTP bytes were
    // sent. Never replay an operation after an ambiguous network failure.
    if (err.code !== 'ERR_DM_TLS_PIN' || signal.aborted) throw err;
    await trust.refresh(pin, err.peerPin);
    signal.throwIfAborted();
    return requestOnce(base, resource, { ...options, signal, pin:trust.pin });
  }
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

async function pairWithHub(link) {
  const u = new URL(String(link).trim());
  const code = new URLSearchParams(u.hash.slice(1)).get('join');
  if (!origin(u.origin) || u.username || u.password || u.pathname !== '/pair' || u.search || !validKey(code)) {
    throw new Error('Paste the complete HTTPS desktop invitation copied from the hub.');
  }
  const probe = await hubJson(u.origin, '/api/info');
  if (!probe.pin || probe.json.app !== 'device-monitor') throw new Error('The address is not a verified Device Monitor hub.');
  const { json } = await hubJson(u.origin, '/api/pair', { method:'POST', token:code, pin:probe.pin });
  if (!validKey(json.client) || !validKey(json.agent) || !isValidId(json.id)) throw new Error('Invalid enrollment response.');
  return { base:u.origin, enrollment:{ client:json.client, agent:json.agent, id:json.id, pin:probe.pin } };
}

module.exports = { origin, isLoopHost, publicKeyPin, pairWithHub, desktopTrust, hubRequest, hubJson, readBytes };
