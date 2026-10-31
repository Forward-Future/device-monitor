'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const dns = require('node:dns');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { startHub } = require('../../server');
const { Access, validKey, localOperatorLink } = require('../../access');
const { HistoryStore } = require('../../history');
const transport = require('../../transport');
const alerts = require('../../alerts');
const root = path.resolve(__dirname, '../..');

function temp(t, beforeDelete = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-security-test-'));
  t.after(() => {
    beforeDelete();
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('dm-security-test-')) throw Error('Unsafe test directory');
    fs.rmSync(dir, {recursive:true,force:true,maxRetries:3});
  });
  return dir;
}
async function fixture(t, options = {}, prepare = () => {}) {
  let h;
  const dataDir = temp(t, () => h?.close());
  prepare(dataDir);
  h = await startHub({port:0,dataDir,fixture:true,publicUrl:'https://hub.test', ...options});
  const base = 'http://127.0.0.1:' + h.port;
  const proxy = {Host:'hub.test','X-Forwarded-For':'192.168.1.10','X-Forwarded-Proto':'https'};
  function call(url, {method='GET',key,body,headers={},remote=false}={}) {
    // A real proxy sets Host; browser Fetch deliberately cannot override it.
    return new Promise((resolve,reject) => {
      const req=http.request(base + url, {method,headers:{ ...(remote ? proxy : {}), ...(key ? {Authorization:'Bearer '+key} : {}), ...(body ? {'Content-Type':'application/json'} : {}), ...headers}}, async res=>{
        try { resolve(new Response(await transport.readBytes(res,4e6),{status:res.statusCode,headers:res.headers})); } catch(e) {reject(e);}
      });
      req.on('error',reject);req.end(body && JSON.stringify(body));
    });
  }
  async function invite(kind, id, dest = 'https://hub.test') {
    const r = await call('/api/invites',{method:'POST',key:h.localKey,body:{kind,origin:dest,id}});
    assert.equal(r.status, 200); const {code}=await r.json(); assert.ok(validKey(code)); return code;
  }
  return {h,base,call,invite,dataDir};
}
test('legacy master, cookies, raw pairing codes and credential-bearing info are retired',async t=>{
  const old=crypto.randomBytes(12).toString('hex');
  const {h,call,dataDir:dir}=await fixture(t,{},d=>fs.writeFileSync(path.join(d,'config.json'),JSON.stringify({token:old,energy:{rate:1}})));
  assert.equal((await call('/api/devices',{key:old})).status,401);
  assert.equal((await call('/api/devices',{headers:{Cookie:'dm_key='+old}})).status,401);
  assert.equal((await call('/api/report',{method:'POST',body:{id:'box',token:old}})).status,401);
  assert.equal((await call('/api/pair',{method:'POST',body:{code:'123456'}})).status,403);
  assert.equal((await call('/api/info?nonce=abcdef0123456789').then(r=>r.json())).proof,undefined);
  const info=await call('/api/info',{key:h.localKey}).then(r=>r.json());
  assert.equal(info.app,'device-monitor'); assert.equal(info.token,undefined);
  for(const name of ['config.json','config.json.bak']) assert.ok(!fs.readFileSync(path.join(dir,name),'utf8').includes(old));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'config.json'))).energy.rate,1);
});
test('invitations bind role and origin; reports bind identity and management stays separate',async t=>{
  const {call,invite}=await fixture(t);
  const code=await invite('desktop');
  assert.equal((await call('/api/pair',{method:'POST',key:code})).status,403);
  assert.equal((await call('/api/session',{method:'POST',key:code,remote:true})).status,403);
  const paired=await call('/api/pair',{method:'POST',key:code,remote:true}).then(r=>r.json());
  assert.ok(validKey(paired.client)); assert.ok(validKey(paired.agent)); assert.notEqual(paired.client,paired.agent);
  assert.equal((await call('/api/pair',{method:'POST',key:code,remote:true})).status,403);
  assert.equal((await call('/api/report',{method:'POST',key:paired.client,body:{id:paired.id}})).status,401);
  assert.equal((await call('/api/report',{method:'POST',key:paired.agent,body:{id:paired.id,hostname:'device'}})).status,200);
  assert.equal((await call('/api/report',{method:'POST',key:paired.agent,body:{id:paired.id}})).status,429);
  for(const resource of ['/api/alerts','/api/devices','/api/remote']) assert.equal((await call(resource,{key:paired.agent})).status,401);
  const second=await call('/api/pair',{method:'POST',key:await invite('desktop'),remote:true}).then(r=>r.json());
  assert.equal((await call('/api/report',{method:'POST',key:second.agent,body:{id:paired.id}})).status,403);
  assert.equal((await call('/api/devices/'+paired.id,{key:paired.agent,method:'DELETE'})).status,401);
  const replacement=await call('/api/pair',{method:'POST',key:await invite('desktop',paired.id),remote:true}).then(r=>r.json());
  assert.equal(replacement.id,paired.id);
  assert.equal((await call('/api/devices',{key:paired.client})).status,401);
  assert.equal((await call('/api/devices',{key:replacement.client})).status,200);
  assert.equal((await call('/api/devices/'+paired.id,{method:'DELETE',key:replacement.client})).status,200);
  assert.equal((await call('/api/devices',{key:replacement.client})).status,401);
});
test('browser credentials stay out of cookies and URLs and can be revoked',async t=>{
  const {call,invite,h,base}=await fixture(t);
  const ticket=await invite('browser',null,base);
  const res=await call('/api/session',{method:'POST',key:ticket});assert.equal(res.status,200);assert.equal(res.headers.get('set-cookie'),null);
  const {token}=await res.json();assert.ok(validKey(token));
  assert.equal((await call('/api/devices',{headers:{Cookie:'dm_key='+token}})).status,401);
  assert.equal((await call('/api/devices',{key:token})).status,200);
  assert.equal((await call('/api/logout',{key:token,method:'POST'})).status,200);
  assert.equal((await call('/api/devices',{key:token})).status,401);
  assert.equal((await call('/api/invites',{key:h.localKey,method:'POST',body:{kind:'agent',origin:base}})).status,400);
  assert.equal((await call('/api/session',{method:'POST',key:ticket})).status,403);
  const access=new Access({},path.join(temp(t),'config.json'));const exp=access.issue('browser',base);access.invites.values().next().value.until=0;
  assert.equal(access.redeem(exp,'browser',base),null);
  const source=fs.readFileSync(path.join(root,'public/session.js'),'utf8');
  const location=new URL('https://hub.test/');let sent;
  const ctx={URL,Headers,location,sessionStorage:{getItem:()=>token},fetch:(u,o)=>{sent=o;return Promise.resolve({status:200});}};
  vm.runInNewContext(source,ctx);
  await vm.runInNewContext("hubFetch('/api/devices')",ctx);
  assert.equal(sent.headers.get('Authorization'),'Bearer '+token);assert.equal(sent.credentials,'omit');assert.equal(sent.redirect,'error');
  assert.throws(()=>vm.runInNewContext("hubFetch('https://hub.test:8080/api/devices')",ctx),/Invalid dashboard/);
});
test('bootstrap tickets are single use, HTTPS only and cannot authorize the dashboard',async t=>{
  const {call,invite}=await fixture(t);
  for(const endpoint of ['/install.sh','/install.ps1']){
    const ticket=await invite('agent');
    assert.equal((await call(endpoint,{key:ticket})).status,403);
    const res=await call(endpoint,{key:ticket,remote:true});assert.equal(res.status,200);const script=await res.text();
    assert.ok(script.includes('https://hub.test'));assert.ok(!script.includes('__TOKEN__'));assert.ok(!script.includes(ticket));
    const newKey=/TOKEN\s*=\s*'([A-Za-z0-9_-]{43})'/i.exec(script)[1];assert.ok(validKey(newKey));
    assert.equal((await call('/api/devices',{key:newKey})).status,401);
    assert.equal((await call(endpoint,{key:ticket,remote:true})).status,403);
  }
  const browserScript=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  assert.match(browserScript,/--proto '=https'/);assert.match(browserScript,/-MaximumRedirection 0/);
});
test('malformed targets fail per request; unknown upload is refused before its body arrives',async t=>{
  const {h,call}=await fixture(t);
  async function status(target,method='GET',headers={}) {
    return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:h.port,path:target,method,headers,timeout:2000},res=>{
      res.resume();resolve(res.statusCode);req.destroy();
    });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Server awaited untrusted body')));if(method==='POST')req.flushHeaders();else req.end();});
  }
  assert.equal(await status('//['),400);assert.equal(await status('/\\test'),400);
  assert.equal(await status('/api/report','POST',{'Content-Length':900000}),401);
  assert.equal((await call('/api/devices',{key:h.localKey})).status,200);
  assert.equal((await call('/api/remote/https',{method:'POST',key:h.localKey,body:{enable:true}})).status,403);
});
test('history migration separates collisions, survives retry, and enforces retention and permissions',t=>{
  const dir=temp(t),legacy=path.join(dir,'history');fs.mkdirSync(legacy);
  const minute=Math.floor(Date.now()/60000)*60000;
  const old=path.join(legacy,'rack_1.ndjson');
  const data=[{id:'rack.1',t:minute,cpu:11,n:1},{id:'rack_1',t:minute,cpu:77,n:1},{t:minute-60000,cpu:33}].map(x=>JSON.stringify(x)).join('\n')+'\n';
  fs.writeFileSync(old,data);
  let hist=new HistoryStore(dir,['rack.1','rack_1']);
  assert.notEqual(hist.file('rack.1'),hist.file('rack_1'));assert.notEqual(hist.file('A'),hist.file('a'));
  assert.equal(hist.minutes.get('rack.1')[0].cpu,11);assert.equal(hist.minutes.get('rack_1')[0].cpu,77);
  assert.ok(fs.existsSync(old+'.unassigned'));fs.writeFileSync(old,data);
  hist=new HistoryStore(dir,['rack.1','rack_1']);
  assert.equal(hist.minutes.get('rack.1')[0].n,1);
  hist.remove('rack.1');assert.ok(fs.existsSync(hist.file('rack_1')));
  if(process.platform!=='win32'){
    assert.equal(fs.statSync(legacy).mode & 0o777,0o700);
    assert.equal(fs.statSync(hist.file('rack_1')).mode & 0o777,0o600);
  }
  for(let i=0;i<10000;i++) hist.add('fast',{t:minute+i,cpu:2});
  assert.ok(hist.raw.get('fast').length<=10);assert.ok(hist.pending.get('fast').samples.length<=10);
});
test('DNS socket lookup fails closed on mixed, changed and failed answers and permits private LAN',async t=>{
  let answers=[{address:'192.168.1.8',family:4}];
  t.mock.method(dns,'lookup',(host,opts,cb)=>cb(answers instanceof Error ? answers:null,answers));
  const resolve=()=>new Promise((ok,no)=>alerts.publicLookup('alerts.test',{all:true},(e,a)=>e?no(e):ok(a)));
  assert.equal((await resolve())[0].address,'192.168.1.8');
  answers.push({address:'127.0.0.1',family:4});await assert.rejects(resolve(),/Blocked/);
  answers=[{address:'0:0:0:0:0:ffff:7f00:1',family:6}];await assert.rejects(resolve(),/Blocked/);
  answers=new Error('lookup failed');await assert.rejects(resolve(),/lookup failed/);
  assert.equal((await alerts.post('http://127.0.0.1/',{})).ok,false);
});
test('alert errors discard response bodies, and fixtures never send notifications',async t=>{
  let destroyed=false, lookup;
  t.mock.method(http,'request',(u,opts,cb)=>{lookup=opts.lookup;return {on(){},end(){cb({statusCode:503,destroy(){destroyed=true},get body(){throw Error('Error body was read')}});}};});
  const result=await alerts.post('http://alerts.example/hook',{});
  assert.deepEqual(result,{ok:false,error:'HTTP 503'});assert.equal(lookup,alerts.publicLookup);assert.equal(destroyed,true);
});
test('transport rejects unsafe destinations and caps decoded metadata before JSON parsing',async()=>{
  for (const url of ['http://192.168.1.10:7777','https://a@example.test','https://example.test/path']) assert.equal(transport.origin(url),null);
  assert.equal(transport.origin('https://hub.example:8443'),'https://hub.example:8443');
  await assert.rejects(transport.hubRequest('https://hub.example','/api/info',{token:'inert'}),/TLS identity/);
  await assert.rejects(transport.hubRequest('https://hub.example','//different.test/api/info'),/destination/);
  await assert.rejects(transport.readBytes(Readable.from([Buffer.alloc(20),Buffer.alloc(20)]),25),/too large/);
  assert.equal((await transport.readBytes(Readable.from([Buffer.from('ok')]),2)).toString(),'ok');
});

function loadModule(name, overrides, globals = {}) {
  const { createRequire } = require('node:module');
  const filename=path.join(root,name), localRequire=createRequire(filename), exported={exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{ ...globals, module:exported,
    require:id=>Object.hasOwn(overrides,id)?overrides[id]:localRequire(id), Buffer, console, URL, AbortSignal, setTimeout,clearTimeout,setInterval,clearInterval
  },{filename});
  return exported.exports;
}
test('Windows update checks cannot reopen the committed file; manual and automatic installs share verification',async t=>{
  const dir=temp(t), keys=crypto.generateKeyPairSync('ed25519');
  let payload=Buffer.from('inert test bytes'), served=payload, manifest, requests=0, launch=null;
  const counterFetch=async url=>{
    requests++;
    return url.includes('/api/update/') ? new Response(JSON.stringify(manifest)) : new Response(served);
  };
  const {Updater,signedPayload}=loadModule('updater.js',{'child_process':{execFile:(exe,args)=>{launch=args;}}},{process:{platform:'win32',pid:12345,execPath:'inert.exe'},fetch:counterFetch});
  function sign(v,b) {
    manifest={platform:'windows',version:v,file:'same-name.exe',size:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};
    manifest.signature=crypto.sign(null,Buffer.from(signedPayload(manifest)),keys.privateKey).toString('base64');
  }
  sign('9.0.0',payload);
  let auto=false;
  const u=new Updater({app:{getVersion:()=> '1.0.0'},dir,publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}),
    canInstall:()=>auto,manualDownload:()=>true,isBusy:()=>true,isVisible:()=>true,hubUrl:()=> 'https://unused.invalid',log:()=>{}});
  t.after(()=>u.stop());
  await u.check();const first=u.readyFile;
  assert.equal(u.status.state,'ready');assert.equal(u.maybeInstall(),false);assert.deepEqual(fs.readFileSync(first),payload);
  sign('9.1.0',payload);served=Buffer.from('wrong bytes');
  await u.check();assert.equal(u.readyFile,first);assert.deepEqual(fs.readFileSync(first),payload);
  served=payload;await u.check();const ready=u.readyFile;assert.notEqual(ready,first);
  assert.ok(!fs.existsSync(first));assert.ok(!fs.readdirSync(dir).some(f=>f.endsWith('.part')));
  auto=true;assert.equal(u.maybeInstall(),false);auto=false;
  assert.equal(u.maybeInstall(true),true);const atLaunch=requests;
  assert.equal(u.status.state,'installing');await Promise.all([u.check(),u.check()]);
  assert.equal(requests,atLaunch);assert.deepEqual(fs.readFileSync(ready),payload);
  const encoded=launch.at(-1).match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1];
  const helper=Buffer.from(encoded,'base64').toString('utf16le');
  assert.ok(helper.includes(manifest.sha256));assert.match(helper,/\[IO\.File\]::Open\(\$file, 'Open', 'Read', 'Read'\)/);
  assert.ok(helper.indexOf('ComputeHash')<helper.indexOf('Start-Process -FilePath $file'));
  assert.ok(helper.indexOf('$handle.Dispose()')>helper.indexOf('Start-Process -FilePath $file'));
  if(process.platform==='win32'){
    const cp=require('node:child_process');
    // Run the exact helper verification statements with harmless data and no executable launch.
    const firstLine=helper.indexOf('$file ='), lastLine=helper.indexOf('  $p = Start-Process');
    const verify=helper.slice(firstLine,lastLine)+"  'verified'\n} catch { exit 7 } finally { if ($handle) {$handle.Dispose()} }";
    const run=()=>cp.spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(verify,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8'});
    assert.equal(run().status,0);fs.writeFileSync(ready,'tampered inert bytes');assert.equal(run().status,7);
  }
});
test('macOS manual opening rechecks the file and refuses modified bytes',async t=>{
  const bytes=Buffer.from('test image'), dir=temp(t), keys=crypto.generateKeyPairSync('ed25519');
  let manifest;
  const {Updater,signedPayload}=loadModule('updater.js',{}, {process:{platform:'darwin'},fetch:async url=>url.includes('/api/update/')?new Response(JSON.stringify(manifest)):new Response(bytes)});
  manifest={platform:'mac',file:'image.dmg',version:'2.0.0',size:bytes.length,sha256:crypto.hash('sha256',bytes)};
  manifest.signature=crypto.sign(null,Buffer.from(signedPayload(manifest)),keys.privateKey).toString('base64');
  const u=new Updater({app:{getVersion:()=> '1.0.0'},dir,hubUrl:()=> 'https://unused.invalid',publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}),canInstall:()=>false,manualDownload:()=>true});
  await u.check();assert.equal(u.status.state,'ready-download');
  let opened=0;await u.openManual(()=>{opened++;});fs.writeFileSync(u.readyFile,'changed');
  await assert.rejects(u.openManual(()=>{opened++;}),/integrity/);assert.equal(opened,1);
});
test('Tailscale fresh reads coalesce simultaneous CLI launches and enforce a cooldown',async()=>{
  let calls=0;
  const mod=loadModule('tailscale.js',{fs:{statSync:()=>({isFile:()=>true})},child_process:{execFile:(exe,args,opts,cb)=>{
    calls++;setImmediate(()=>cb(null,JSON.stringify(args.includes('serve')?{}:{BackendState:'Running',Self:{}}),''));
  }}},{process:{platform:'linux',env:{}}});
  await Promise.all(Array.from({length:40},()=>mod.status(7777,{fresh:true})));
  assert.equal(calls,2);await mod.status(7777,{fresh:true});assert.equal(calls,2);
  const operations=Array.from({length:25},()=>mod.setHttps(7777,true));
  assert.equal((await mod.setHttps(7777,false)).ok,false);
  await Promise.all(operations);assert.equal(calls,5);
});
test('cleartext claims and forwarded public addresses cannot enable remote enrollment',async t=>{
  const {call,invite}=await fixture(t);const ticket=await invite('desktop');
  for (const headers of [{'X-Forwarded-Proto':'http'},{'X-Forwarded-For':'203.0.113.1'},{Host:'other.test'}])
    assert.ok((await call('/api/pair',{method:'POST',key:ticket,remote:true,headers})).status>=400);
  assert.equal((await call('/api/pair',{method:'POST',key:ticket,remote:true})).status,200);
});
test('a slow download peer cannot reserve the entire pool',async t=>{
  const {call,h,dataDir}=await fixture(t);const file=path.join(dataDir,'downloads','fixture.exe');
  const fd=fs.openSync(file,'w');fs.ftruncateSync(fd,32*1024*1024);fs.closeSync(fd);
  const held=[], streams=[], createReadStream=fs.createReadStream;
  t.mock.method(fs,'createReadStream',(...args)=>{const stream=createReadStream(...args);streams.push(stream);return stream;});
  try {
    for(let i=0;i<2;i++) held.push(await new Promise((a,b)=>{
      const req=http.get({host:'127.0.0.1',port:h.port,path:'/download/fixture.exe'},res=>{res.pause();a(res);});req.on('error',b);
    }));
    assert.equal((await call('/download/fixture.exe')).status,429);
    const ok=await new Promise((a,b)=>{const req=http.get({host:'127.0.0.1',port:h.port,path:'/download/fixture.exe',headers:{Host:'hub.test','X-Forwarded-Proto':'https','X-Forwarded-For':'192.168.1.34'}},res=>{a(res.statusCode);res.destroy();});req.on('error',b);});
    assert.equal(ok,200);
  } finally {for(const res of held)res.destroy();}
  await Promise.all(streams.map(stream=>stream.closed?Promise.resolve():new Promise(ok=>stream.once('close',ok))));
  assert.ok(streams.every(stream=>stream.fd === null));
});

test('real TLS sends credentials only on the enrolled connection and rejects redirects',async t=>{
  const cp=require('node:child_process'),https=require('node:https'),execFile=require('node:util').promisify(cp.execFile);
  const dir=temp(t), windowsSSL=path.join(process.env.ProgramFiles||'C:/Program Files','Git','usr','bin','openssl.exe');
  const openssl=process.platform==='win32' && fs.existsSync(windowsSSL)?windowsSSL:'openssl';
  const certs=[];
  const config=path.join(dir,'openssl.cnf');
  fs.writeFileSync(config,'[req]\ndistinguished_name = dn\nx509_extensions = test\nprompt = no\n[dn]\nCN = 127.0.0.1\n[test]\nsubjectAltName = IP:127.0.0.1\nbasicConstraints = critical,CA:TRUE\n');
  for(const i of [0,1]){
    const key=path.join(dir,i+'.key'),cert=path.join(dir,i+'.crt');
    await execFile(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',config,'-subj','/CN=synthetic-hub-'+i,'-keyout',key,'-out',cert],{windowsHide:true});
    certs.push({key:fs.readFileSync(key),cert:fs.readFileSync(cert)});
  }
  const ca=path.join(dir,'trusted.pem');fs.writeFileSync(ca,Buffer.concat(certs.map(c=>c.cert)));
  let accepted=0,wrongPeer=0,redirected=0,changed=false;
  const tlsServer=https.createServer(certs[0],(req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{Location:'/redirected'});res.end();return;}
    if(req.url==='/redirected')redirected++;
    if(req.headers.authorization){if(changed)wrongPeer++;else accepted++;}
    res.setHeader('Content-Type','application/json');res.end('{"ok":true}');
    if(req.url==='/rotate'){changed=true;tlsServer.setSecureContext(certs[1]);}
  });
  await new Promise(ok=>tlsServer.listen(0,'127.0.0.1',ok));
  try{
    const base='https://127.0.0.1:'+tlsServer.address().port;
    const code=[
      "const assert=require('node:assert/strict'), t=require(process.argv[1]), base=process.argv[2];",
      "(async()=>{const probe=await t.hubJson(base,'/info');assert.ok(probe.pin);",
      "await assert.rejects(t.hubJson(base,'/redirect'),/redirect/);",
      "await t.hubJson(base,'/rotate',{token:'synthetic-only',pin:probe.pin});",
      "await assert.rejects(t.hubJson(base,'/after',{token:'synthetic-only',pin:probe.pin}),/identity changed/);",
      "})().catch(e=>{console.error(e.message);process.exitCode=1});"
    ].join('\n');
    await execFile(process.execPath,['-e',code,path.join(root,'transport.js'),base],{env:{...process.env,NODE_EXTRA_CA_CERTS:ca},windowsHide:true});
    assert.equal(accepted,1);assert.equal(wrongPeer,0);assert.equal(redirected,0);
  }finally{tlsServer.closeAllConnections();await new Promise(ok=>tlsServer.close(ok));}
  // Exercise the real hub listener and enrollment, with a private test CA and a local-only fixture.
  const reservation=net.createServer();await new Promise(ok=>reservation.listen(0,'127.0.0.1',ok));
  const tlsPort=reservation.address().port;await new Promise(ok=>reservation.close(ok));
  const dest='https://127.0.0.1:'+tlsPort;
  const {invite,call,h}=await fixture(t,{publicUrl:dest,tlsOptions:certs[0]});
  const enrollment=await invite('desktop',null,dest);
  const client=[
    "const t=require(process.argv[1]),base=process.argv[2],assert=require('node:assert/strict');",
    "(async()=>{const {pin}=await t.hubJson(base,'/api/info');",
    "const {json:e}=await t.hubJson(base,'/api/pair',{method:'POST',pin,token:process.env.TEST_INVITE});",
    "assert.ok(e.id && e.agent && e.client); await t.hubJson(base,'/api/report',{pin,token:e.agent,method:'POST',body:JSON.stringify({id:e.id,hostname:'tls-fixture'})});",
    "const d=await t.hubJson(base,'/api/devices',{pin,token:e.client});assert.equal(d.json[0].hostname,'tls-fixture');",
    "})().catch(e=>{console.error(e.message);process.exitCode=1});"
  ].join('\n');
  await execFile(process.execPath,['-e',client,path.join(root,'transport.js'),dest],{env:{...process.env,NODE_EXTRA_CA_CERTS:ca,TEST_INVITE:enrollment},windowsHide:true});
  assert.equal((await call('/api/devices',{key:h.localKey}).then(r=>r.json())).length,1);
});
test('SSE snapshots preserve device history and an over-budget socket is evicted',async t=>{
  const {h}=await fixture(t);
  h.seedReport({id:'demo',hostname:'Demo',cpu:{usage:14}});
  let stream;
  const write=http.ServerResponse.prototype.write;
  t.mock.method(http.ServerResponse.prototype,'write',function(...args){
    if(this.getHeader('Content-Type')==='text/event-stream' || String(args[0]).startsWith('data: {"type":"snapshot"'))stream=this;
    return write.apply(this,args);
  });
  const received=await new Promise((ok,no)=>{
    const req=http.get({host:'127.0.0.1',port:h.port,path:'/api/stream',headers:{Authorization:'Bearer '+h.localKey}},res=>{
      let frame='';res.on('data',c=>{frame+=c;if(frame.includes('\n\n')){res.pause();ok({frame,res});}});
    });req.on('error',no);
  });
  try{
    const snapshot=JSON.parse(received.frame.split('\n\n')[0].slice(6));
    assert.equal(snapshot.devices[0].id,'demo');assert.equal(snapshot.devices[0].history.length,1);
    Object.defineProperty(stream,'writableLength',{get:()=>512*1024});
    h.seedReport({id:'demo',hostname:'again'});assert.equal(stream.destroyed,true);
  }finally{received.res.destroy();}
});
test('authenticated body readers have a per-peer admission ceiling',async t=>{
  const {h,call}=await fixture(t),held=[];
  try{
    for(let i=0;i<4;i++){
      const req=http.request({host:'127.0.0.1',port:h.port,path:'/api/energy/settings',method:'PUT',headers:{Authorization:'Bearer '+h.localKey,'Content-Length':50000}});
      req.on('error',()=>{});held.push(req);req.write('{');await new Promise(ok=>req.socket?ok():req.once('socket',ok));
    }
    await new Promise(ok=>setTimeout(ok,30));
    assert.equal((await call('/api/energy/settings',{method:'PUT',key:h.localKey,body:{}})).status,429);
  }finally{for(const req of held)req.destroy();}
});

test('shared sessions cannot mint credentials and rotating a device revokes its descendants',async t=>{
  const {h,call,invite,base}=await fixture(t);
  const browser=await call('/api/session',{key:await invite('browser',null,base),method:'POST'}).then(r=>r.json());
  for(const kind of ['browser','agent','desktop']){
    assert.equal((await call('/api/invites',{key:browser.token,method:'POST',body:{kind,origin:'https://hub.test'}})).status,403);
  }
  const first=await call('/api/pair',{key:await invite('desktop'),remote:true,method:'POST'}).then(r=>r.json());
  await call('/api/report',{key:first.agent,body:{id:first.id,hostname:'One'},method:'POST'});
  assert.equal((await call('/api/invites',{key:first.client,method:'POST',body:{kind:'desktop',origin:'https://hub.test'}})).status,403);
  const phone=await call('/api/invites',{key:first.client,method:'POST',body:{kind:'browser',origin:'https://hub.test'}}).then(r=>r.json());
  const child=await call('/api/session',{key:phone.code,remote:true,method:'POST'}).then(r=>r.json());
  const replacementA=await invite('desktop',first.id),replacementB=await invite('desktop',first.id);
  assert.equal((await call('/api/pair',{key:replacementA,remote:true,method:'POST'})).status,200);
  assert.equal((await call('/api/pair',{key:replacementB,remote:true,method:'POST'})).status,403);
  assert.equal((await call('/api/devices',{key:child.token})).status,401);
  assert.equal((await call('/api/sessions/revoke',{key:h.localKey,method:'POST'})).status,200);
  assert.equal((await call('/api/devices',{key:browser.token})).status,401);
});
test('headless operator bootstrap stays inside a private, instance-bound mailbox',async t=>{
  const {call,h,dataDir}=await fixture(t,{headlessInvites:true});
  const ticket=()=>new URLSearchParams(new URL(localOperatorLink(dataDir,h.port)).hash.slice(1)).get('join');
  const prior=ticket(), current=ticket();
  assert.equal((await call('/api/session',{method:'POST',key:prior})).status,403);
  assert.equal((await call('/api/session',{method:'POST',key:current,remote:true})).status,403);
  const op=await call('/api/session',{method:'POST',key:current}).then(r=>r.json());
  assert.equal((await call('/api/session',{method:'POST',key:current})).status,403);
  assert.equal((await call('/api/devices',{key:op.token,remote:true})).status,401);
  assert.equal((await call('/api/invites',{method:'POST',key:op.token,body:{kind:'desktop',origin:'https://hub.test'}})).status,200);
  const pending=ticket();
  assert.equal((await call('/api/sessions/revoke',{method:'POST',key:op.token})).status,200);
  assert.equal((await call('/api/session',{method:'POST',key:pending})).status,403);
  assert.ok(!fs.readFileSync(path.join(dataDir,'local-invites-'+h.port,'pending.json'),'utf8').includes(h.localKey));
});

test('shell report dispatch keeps credentials outside argv and report bytes on all paths',()=>{
  const cp=require('node:child_process');
  const bash=process.platform==='win32'?path.join(process.env.ProgramFiles,'Git/bin/bash.exe'):'bash';
  for(const name of ['agent.sh','agent-macos.sh']){
    const source=fs.readFileSync(path.join(root,'agent',name),'utf8').replace(/\r/g,'');
    const start=source.lastIndexOf('  if [ "$DM_REPORT_PIPE" = 1 ]; then');
    const dispatch=source.slice(start,source.indexOf('\n  fi',start)+5);
    assert.ok(start>0);assert.ok(!source.match(/BODY=.*\\"token\\"/));
    const token=crypto.randomBytes(32).toString('base64url'),body='{"id":"inert","hostname":"example"}';
    const script=[
      'curl() { case "$*" in *"$TOKEN"*) return 91;; esac; IFS= read -r header <&3; test "$header" = "Authorization: Bearer $TOKEN" || return 92; test "$(cat)" = "$BODY" || return 93; }',
      dispatch
    ].join('\n');
    const env={...process.env,TOKEN:token,HUB:'https://unused.invalid',BODY:body,DM_REPORT_PIPE:'0'};
    const result=cp.spawnSync(bash,['-c',script],{env,encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    const piped=cp.spawnSync(bash,['-c',dispatch],{env:{...env,DM_REPORT_PIPE:'1'},encoding:'utf8',windowsHide:true});
    assert.equal(piped.stdout.trim(),body);
  }
});
test('case-distinct legacy files keep their own untagged rows on case-sensitive storage',t=>{
  const dir=temp(t),location=path.join(dir,'history');fs.mkdirSync(location);
  const minute=Math.floor(Date.now()/60000)*60000;
  fs.writeFileSync(path.join(location,'Rack.ndjson'),JSON.stringify({t:minute,cpu:12})+'\n');
  const sensitive=!fs.existsSync(path.join(location,'rack.ndjson'));
  if(sensitive)fs.writeFileSync(path.join(location,'rack.ndjson'),JSON.stringify({t:minute,cpu:55})+'\n');
  const h=new HistoryStore(dir,['Rack','rack']);
  if(sensitive){assert.equal(h.minutes.get('Rack')[0].cpu,12);assert.equal(h.minutes.get('rack')[0].cpu,55);}
  else{assert.ok(fs.existsSync(path.join(location,'Rack.ndjson.unassigned')));}
});
test('a healthy stream can receive a legitimate event larger than the backlog budget',async t=>{
  const {h}=await fixture(t);
  const peer=await new Promise((ok,no)=>http.get({host:'127.0.0.1',port:h.port,path:'/api/stream',headers:{Authorization:'Bearer '+h.localKey}},ok).on('error',no));
  const data=new Promise((ok,no)=>{let pending='';peer.setEncoding('utf8');peer.on('error',no);peer.on('data',c=>{pending+=c;
    let end;while((end=pending.indexOf('\n\n'))>=0){const msg=JSON.parse(pending.slice(6,end));pending=pending.slice(end+2);if(msg.type==='report')ok(msg);}
  });});
  const text='界'.repeat(200);
  try{
    h.seedReport({id:'wide',temps:Array(256).fill({name:text,parent:text,value:42}),fans:Array(64).fill({name:text,rpm:500}),disks:Array(64).fill({name:text,label:text,total:1}),
      ai:Array(8).fill({app:text,models:Array(16).fill({name:text,kind:text,size:1})})});
    const event=await data;assert.ok(Buffer.byteLength(JSON.stringify(event))>256*1024);assert.equal(event.id,'wide');
  }finally{peer.destroy();}
});
test('revocation while a body is arriving prevents the pending settings mutation',async t=>{
  const {h,call,invite,base}=await fixture(t);
  const {token}=await call('/api/session',{method:'POST',key:await invite('browser',null,base)}).then(r=>r.json());
  const payload=JSON.stringify({region:'custom',currency:'USD',rate:10});
  let req;
  const result=new Promise((ok,no)=>{req=http.request({host:'127.0.0.1',port:h.port,path:'/api/energy/settings',method:'PUT',
    headers:{Authorization:'Bearer '+token,'Content-Length':Buffer.byteLength(payload)}},r=>{r.resume();ok(r.statusCode);});req.on('error',no);req.write(payload.slice(0,-1));});
  await new Promise(ok=>setTimeout(ok,20));
  await call('/api/sessions/revoke',{method:'POST',key:h.localKey});
  req.end(payload.slice(-1));assert.equal(await result,401);
  assert.equal(await call('/api/energy/settings',{key:h.localKey}).then(r=>r.json()),null);
});

test('updater startup tolerates a locked prior installer and source builds offer no dead action',async t=>{
  const dir=temp(t);fs.writeFileSync(path.join(dir,'dm-abcd.exe'),'inert');
  const mockFs=Object.create(fs);
  mockFs.rmSync=()=>{throw Object.assign(Error('in use'),{code:'EBUSY'});};
  const keys=crypto.generateKeyPairSync('ed25519');
  let m;
  const {Updater,signedPayload}=loadModule('updater.js',{fs:mockFs},{process:{platform:'win32'},fetch:async()=>new Response(JSON.stringify(m))});
  const data=Buffer.from('inert');
  m={platform:'windows',version:'2.0.0',file:'fixture.exe',size:data.length,sha256:crypto.hash('sha256',data)};
  m.signature=crypto.sign(null,Buffer.from(signedPayload(m)),keys.privateKey).toString('base64');
  const updater=new Updater({app:{getVersion:()=> '1.0.0'},hubUrl:()=> 'https://unused.invalid',dir,publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}),canInstall:()=>false,manualDownload:()=>false,log:()=>{}});
  assert.equal((await updater.check()).state,'source-release');assert.equal(updater.readyFile,undefined);
});
