// The root credential stays on the hub. Persistent client and agent records
// contain only hashes. Invitations and browser sessions expire and die on restart.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isValidId, safeEqual } = require('./security');
const secret = () => crypto.randomBytes(32).toString('base64url');
const digest = s => crypto.createHash('sha256').update(s).digest('hex');
const validKey = s => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
const bearer = req => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1] || '';
const INVITE_TTL = 10 * 60e3, SESSION_TTL = 8 * 60 * 60e3;
function privateWrite(file, value) {
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), {flag:'wx', mode:0o600});
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, {force:true}); }
}

// Headless bootstrap is owned by the account, independent of the process that
// happens to answer HTTP. Tickets die with the running hub instance.
function localOperatorLink(dataDir, port) {
  const dir = path.join(dataDir, 'local-invites-' + port);
  const { epoch } = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
  if (!validKey(epoch)) throw new Error('No running headless hub');
  const code = secret();
  privateWrite(path.join(dir, 'pending.json'), { epoch, hash:digest(code), until:Date.now() + INVITE_TTL });
  return 'http://127.0.0.1:' + port + '/unlock#join=' + code;
}
class Access {
  constructor(config, file) {
    this.file = path.join(path.dirname(file), 'access-v2.json');
    this.invites = new Map(); this.sessions = new Map();
    try { this.config = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw new Error('Cannot read hub access records. Restore a trusted backup.');
      this.config = { localKey: secret(), identities: {} };
      try { fs.writeFileSync(this.file, JSON.stringify(this.config), {flag:'wx', mode:0o600}); }
      catch (createError) {
        if (createError.code !== 'EEXIST') throw createError;
        this.config = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    }
    if (!fs.lstatSync(this.file).isFile()) throw new Error('Unsafe hub credential file');
    if (process.platform !== 'win32') fs.chmodSync(this.file, 0o600);
    if (!validKey(this.config.localKey) || !this.config.identities || typeof this.config.identities !== 'object') throw new Error('Invalid hub authentication state');
    if (Object.hasOwn(config, 'token')) {
      delete config.token;
      const { writeJson } = require('./safe-json');
      if (!writeJson(file, config) || !writeJson(file, config)) throw new Error('Could not retire the legacy hub credential');
    }
    this.index = new Map();
    for (const [id, row] of Object.entries(this.config.identities)) this.indexRow(id, row);
    this.localAgent = secret();
  }
  save() {
    // Recovering an older auth backup could revive revoked credentials.
    privateWrite(this.file, this.config);
  }
  openOperatorMailbox(port) {
    const dir = path.join(path.dirname(this.file), 'local-invites-' + port);
    fs.mkdirSync(dir, { recursive:true, mode:0o700 });
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('Invalid invitation directory');
    if (process.platform !== 'win32') fs.chmodSync(dir,0o700);
    this.mailbox = { dir, origin:'http://127.0.0.1:' + port, epoch:secret(), claimed:null };
    privateWrite(path.join(dir, 'instance.json'), {epoch:this.mailbox.epoch});
  }
  takeOperatorInvitation(hash, audience) {
    const box = this.mailbox;
    if (!box || box.origin !== audience || box.claimed === hash) return false;
    let ticket;
    try { ticket = JSON.parse(fs.readFileSync(path.join(box.dir, 'pending.json'), 'utf8')); } catch { return false; }
    if (ticket.until <= Date.now() || !safeEqual(ticket.epoch,box.epoch) || !safeEqual(ticket.hash,hash)) return false;
    box.claimed = hash;
    return true;
  }
  clearSessions() {
    this.sessions.clear(); this.invites.clear();
    if (this.mailbox) {
      this.mailbox.epoch = secret(); this.mailbox.claimed = null;
      privateWrite(path.join(this.mailbox.dir, 'instance.json'), {epoch:this.mailbox.epoch});
    }
  }
  close() {
    if (this.mailbox) {
      fs.rmSync(path.join(this.mailbox.dir, 'instance.json'), {force:true});
      this.mailbox = null;
    }
  }
  indexRow(id, row) {
    if (row.agent) this.index.set(row.agent, { role: 'agent', id });
    if (row.client) this.index.set(row.client, { role: 'client', id });
  }
  principal(key, local = false) {
    if (!validKey(key)) return null;
    if (local && safeEqual(key, this.config.localKey)) return { role: 'root' };
    if (local && safeEqual(key, this.localAgent)) return { role: 'local-agent' };
    const hash = digest(key), member = this.index.get(hash), session = this.sessions.get(hash);
    if (member) return member;
    if (session && session.until > Date.now()) {
      if (session.operator && !local) return null;
      return { role: session.operator ? 'operator' : 'browser', id: session.owner };
    }
    if (session) this.sessions.delete(hash);
    return null;
  }
  logout(key) { if (validKey(key)) this.sessions.delete(digest(key)); }
  issue(kind, audience, id, owner) {
    if (!['browser','desktop','agent'].includes(kind) || !audience || (id != null && !isValidId(id))) throw new Error('Invalid enrollment');
    for (const [k, v] of this.invites) if (v.until <= Date.now()) this.invites.delete(k);
    if (this.invites.size >= 256) throw new Error('Too many pending invitations');
    const code = secret();
    this.invites.set(digest(code), { kind, audience, owner, id: id || crypto.randomUUID(), until: Date.now() + INVITE_TTL });
    return code;
  }
  redeem(code, kind, audience) {
    if (!validKey(code)) return null;
    const hash = digest(code);
    let item = this.invites.get(hash);
    if (!item && kind === 'browser' && this.takeOperatorInvitation(hash, audience)) item = { kind, audience, operator:true, until:Date.now() + INVITE_TTL };
    if (!item || item.kind !== kind || item.audience !== audience || item.until <= Date.now()) return null;
    this.invites.delete(hash);
    if (kind === 'browser') {
      for (const [k, v] of this.sessions) if (v.until <= Date.now()) this.sessions.delete(k);
      if (this.sessions.size >= 256) throw new Error('Too many browser sessions');
      const token = secret(); this.sessions.set(digest(token), { until: Date.now() + SESSION_TTL, owner: item.owner, operator:item.operator === true });
      return { token };
    }
    const { id } = item, rows = this.config.identities;
    if (!Object.hasOwn(rows, id) && Object.keys(rows).length >= 250) throw new Error('Too many enrolled devices');
    const agent = secret(), client = kind === 'desktop' ? secret() : null;
    const prior = Object.hasOwn(rows, id) ? rows[id] : null;
    const row = { agent: digest(agent), ...(client ? { client: digest(client) } : {}) };
    Object.defineProperty(rows, id, { value: row, configurable: true, enumerable: true, writable: true });
    try { this.save(); } catch (e) { if (prior) rows[id] = prior; else delete rows[id]; throw e; }
    if (prior) { this.index.delete(prior.agent); this.index.delete(prior.client); }
    this.revokeDerived(id);
    this.indexRow(id, row);
    return { id, agent, ...(client ? { client } : {}) };
  }
  revoke(id) {
    const rows = this.config.identities, prior = Object.hasOwn(rows, id) && rows[id];
    if (prior) {
      delete rows[id]; try { this.save(); } catch (e) { rows[id] = prior; throw e; }
      this.index.delete(prior.agent); this.index.delete(prior.client);
    }
    this.revokeDerived(id);
  }
  revokeDerived(id) {
    for (const [k,v] of this.invites) if (v.id === id || v.owner === id) this.invites.delete(k);
    for (const [k,v] of this.sessions) if (v.owner === id) this.sessions.delete(k);
  }
}
module.exports = { Access, bearer, validKey, localOperatorLink };
