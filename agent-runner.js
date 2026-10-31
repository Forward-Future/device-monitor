// Packaged collectors write NDJSON over a private pipe. Only this process
// receives credentials or connects to the enrolled hub.
const { spawn } = require('child_process');
const path = require('path');
const { hubJson } = require('./transport');

function startAgent({ hub, token, pin, trust, deviceId, scriptDir, appVersion = '', log = console.log }) {
  let child, timer, stopped = false, sending = false;
  let request;
  function report(line) {
    if (stopped || sending || !line.length) return;
    let body;
    try { body = JSON.parse(line); } catch { return; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return;
    if (deviceId) body.id = deviceId;
    sending = true;
    request = new AbortController();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
    hubJson(hub, '/api/report', { method: 'POST', token, pin, trust, body: JSON.stringify(body), signal })
      .catch(() => {}).finally(() => { sending = false; request = null; });
  }
  function run() {
    const win = process.platform === 'win32';
    const script = win ? 'agent.ps1' : process.platform === 'darwin' ? 'agent-macos.sh' : 'agent.sh';
    const args = win ? ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(scriptDir, script),'-ParentPid',String(process.pid)] : [path.join(scriptDir, script)];
    child = spawn(win ? 'powershell.exe' : '/bin/bash', args, { stdio: ['ignore','pipe','ignore'], windowsHide: true,
      env: { ...process.env, TOKEN: '', DM_TOKEN: '', DM_REPORT_PIPE: '1', DM_APP_VERSION: appVersion, PARENT_PID: String(process.pid) } });
    child.stdout.setEncoding('utf8');
    let pending = '', discard = false;
    child.stdout.on('data', text => {
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (!discard) { pending += parts[i]; if (pending.length > 1e6) { pending = ''; discard = true; } }
        if (i < parts.length - 1) { if (!discard) report(pending); pending = ''; discard = false; }
      }
    });
    child.on('error', e => log('Agent failed: ' + e.message));
    child.on('close', () => { if (!stopped) timer = setTimeout(run, 5000); });
  }
  function stop() {
    stopped = true; clearTimeout(timer); request?.abort(); child?.kill(); process.removeListener('exit', stop);
  }
  process.once('exit', stop); run();
  return { stop };
}
module.exports = { startAgent };
