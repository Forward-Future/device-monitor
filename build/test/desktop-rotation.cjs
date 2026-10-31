// Runs with only synthetic enrollments and loopback servers. The parent sets
// NODE_EXTRA_CA_CERTS before Node starts, so real TLS does all chain/name checks.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { startHub } = require('../../server');
const { HistoryStore } = require('../../history');
const { startAgent } = require('../../agent-runner');
const transport = require('../../transport');

async function run(dir) {
  const certs = Array.from({length:5}, (_, i) => ({
    cert:fs.readFileSync(path.join(dir, i + '.crt')), key:fs.readFileSync(path.join(dir, i + '.key'))
  }));
  const pins = certs.map(c => transport.publicKeyPin(new crypto.X509Certificate(c.cert)));
  const dataDir = path.join(dir, 'original-hub'), proxyCertFile = path.join(dir, 'proxy.pem');
  const profile = path.join(dir, 'desktop.json'), id = 'previously-paired-desktop';
  const firstSeen = Math.floor(Date.now() / 60000) * 60000 - 7200000;
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'devices.json'), JSON.stringify({[id]:{id,name:'My desktop',firstSeen}}));
  const history = new HistoryStore(dataDir, [id]);
  history.add(id, {t:firstSeen, cpu:19}); history.close();
  fs.writeFileSync(proxyCertFile, certs[0].cert);

  let hub, other, collector, mode = 'normal', recordedProof;
  const calls = [];
  const proofPath = '/api/desktop/tls-proof';
  const front = https.createServer(certs[0], async (req, res) => {
    const bytes = await transport.readBytes(req, 1e6);
    calls.push({mode, path:req.url, auth:req.headers.authorization, body:bytes.toString()});
    if (mode === 'replay') { res.end(recordedProof); return; }
    const backend = mode === 'unrelated' ? other : hub;
    const headers = {...req.headers, 'x-forwarded-for':'192.168.1.8', 'x-forwarded-proto':'https'};
    let body = bytes;
    if (mode === 'relay' && req.url === proofPath) {
      // Give the impostor a live oracle at the real hub, and let it lie about
      // the public key in both the forwarded headers and the request body.
      headers['x-forwarded-tls-pin'] = pins[2];
      body = Buffer.from(JSON.stringify({...JSON.parse(bytes), pin:pins[2]}));
      headers['content-length'] = body.length;
    }
    const upstream = http.request({host:'127.0.0.1',port:backend.port,path:req.url,method:req.method,headers,agent:false}, reply => {
      res.writeHead(reply.statusCode, reply.headers);
      if (mode === 'normal' && req.url === proofPath) {
        const parts = [];
        reply.on('data', chunk => parts.push(chunk));
        reply.on('end', () => { recordedProof = Buffer.concat(parts); });
      }
      reply.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    res.on('close', () => upstream.destroy());
    upstream.end(body);
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const base = 'https://127.0.0.1:' + front.address().port;
  const options = {port:0,dataDir,fixture:true,publicUrl:base,proxyCertFile};
  let trust;
  try {
    hub = await startHub(options);
    other = await startHub({...options,dataDir:path.join(dir,'different-hub')});
    const local = () => 'http://127.0.0.1:' + hub.port;
    const {json:ticket} = await transport.hubJson(local(), '/api/invites', {
      method:'POST',token:hub.localKey,body:JSON.stringify({kind:'desktop',origin:base,id})
    });
    const {enrollment} = await transport.pairWithHub(base + '/pair#join=' + ticket.code);
    const original = {...enrollment};
    const records = () => fs.readFileSync(path.join(dataDir,'access-v2.json'),'utf8');
    const before = records();
    assert.equal(original.id,id);
    assert.equal(original.pin,pins[0]);
    let saves = 0;
    function save() { fs.writeFileSync(profile,JSON.stringify(enrollment)); saves++; }
    save();
    trust = transport.desktopTrust(base,enrollment,save);
    const dashboard = active => transport.hubJson(base,'/api/devices',{trust:active,token:enrollment.client});
    const report = host => transport.hubJson(base,'/api/report',{
      trust,method:'POST',token:enrollment.agent,body:JSON.stringify({id,hostname:host,cpu:{usage:37}})
    });
    await report('before-rotation');
    // Both the pin-only 1.2.30 profile and the existing hashed enrollment
    // survive downtime; the client never sees the renewal over its old key.
    hub.close(); hub = await startHub(options);
    front.setSecureContext(certs[2]);
    mode = 'unrelated';
    await assert.rejects(dashboard(trust),/Desktop proof refused/);
    mode = 'relay';
    await assert.rejects(report('private-telemetry'),/Hub identity proof failed/);
    for (const call of calls.filter(c => c.mode === 'relay' || c.mode === 'unrelated')) {
      assert.equal(call.path,proofPath); assert.equal(call.auth,undefined);
      assert.deepEqual(Object.keys(JSON.parse(call.body)).sort(),['challenge','lookup','nonce']);
      for (const secret of [id,enrollment.client,enrollment.agent,'private-telemetry']) assert(!call.body.includes(secret));
    }
    const beforeInvalid = calls.length;
    front.setSecureContext(certs[3]); // untrusted CA
    await assert.rejects(dashboard(trust),/certificat|self.signed/i);
    front.setSecureContext(certs[4]); // trusted, different hostname
    await assert.rejects(dashboard(trust),err => err.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.equal(calls.length,beforeInvalid);
    assert.equal(enrollment.pin,pins[0]); assert.equal(saves,1);

    mode = 'normal';
    front.setSecureContext(certs[1]); fs.writeFileSync(proxyCertFile,certs[1].cert);
    const since = calls.length;
    await Promise.all([dashboard(trust),report('after-rotation'),transport.hubJson(base,'/api/downloads',{trust})]);
    const recovered = calls.slice(since);
    assert.equal(recovered.filter(c => c.path === proofPath).length,1);
    assert.equal(recovered.filter(c => c.path === '/api/report').length,1);
    assert.equal(saves,2);
    assert.deepEqual(JSON.parse(fs.readFileSync(profile)),{...original,pin:pins[1]});
    assert.equal(records(),before);

    mode = 'replay';
    const stale = {...original}, late = transport.desktopTrust(base,stale,() => assert.fail('replayed proof accepted'));
    await assert.rejects(dashboard(late),/Hub identity proof failed/);
    late.close(); assert.equal(stale.pin,pins[0]);
    mode = 'normal';
    const diskFailure = transport.desktopTrust(base,stale,() => { throw Error('profile is read-only'); });
    const writesBefore = calls.filter(c => c.auth).length;
    await assert.rejects(dashboard(diskFailure),/profile is read-only/);
    assert.equal(stale.pin,pins[0]); assert.equal(calls.filter(c => c.auth).length,writesBefore);
    diskFailure.close();
    const oneCredential = transport.desktopTrust(base,{...stale,agent:crypto.randomBytes(32).toString('base64url')},()=>{});
    await assert.rejects(dashboard(oneCredential),/Desktop proof refused/);
    oneCredential.close();

    // A restarted desktop uses the saved pin without a challenge.
    trust.close();
    const restored = JSON.parse(fs.readFileSync(profile));
    trust = transport.desktopTrust(base,restored,() => fs.writeFileSync(profile,JSON.stringify(restored)));
    const n = calls.length, {json:devices} = await dashboard(trust);
    assert.equal(calls.length,n+1);
    assert.equal(devices.length,1); assert.equal(devices[0].firstSeen,firstSeen);
    assert.equal(devices[0].id,id); assert.equal(devices[0].latest.hostname,'after-rotation');
    assert.equal(calls.filter(c => c.path === '/api/pair').length,1);

    // Rotate again, this time with the hub terminating TLS. Only the actual
    // collector initiates recovery; it must keep the assigned ID and history.
    front.closeAllConnections(); await new Promise(resolve => front.close(resolve)); hub.close();
    hub = await startHub({...options,proxyCertFile:null,tlsOptions:certs[2]});
    const sample = '{"id":"collector-local-id","hostname":"report-after-second-rotation","cpu":{"usage":42}}';
    fs.writeFileSync(path.join(dir,'agent.ps1'),"param([int]$ParentPid)\n[Console]::WriteLine('"+sample+"')\nStart-Sleep -Seconds 20\n");
    for (const name of ['agent.sh','agent-macos.sh']) fs.writeFileSync(path.join(dir,name),"printf '%s\\n' '"+sample+"'\nexec sleep 20\n");
    collector = startAgent({hub:base,token:restored.agent,deviceId:id,trust,scriptDir:dir});
    const deadline = Date.now()+12000;
    for (;;) {
      const {json:rows} = await transport.hubJson(local(),'/api/devices',{token:hub.localKey});
      assert.equal(rows.length,1);
      if (rows[0].id===id && rows[0].latest?.hostname==='report-after-second-rotation') break;
      assert(Date.now()<deadline,'Collector did not resume'); await delay(100);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(profile)),{...original,pin:pins[2]});
    const {json:series} = await transport.hubJson(base,'/api/history/'+id+'?from='+firstSeen+'&to='+(firstSeen+60000),{trust,token:restored.client});
    assert.equal(series.points[0].t,firstSeen); assert.equal(series.points[0].cpu,19); assert.equal(records(),before);
  } finally {
    collector?.stop(); trust?.close(); hub?.close(); other?.close();
    if(front.listening){front.closeAllConnections();await new Promise(resolve=>front.close(resolve));}
  }
}
run(process.argv[2]).catch(err => { console.error(err.stack); process.exitCode = 1; });
