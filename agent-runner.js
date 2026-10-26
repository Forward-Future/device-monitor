// Runs this machine's metrics agent as a hidden child process and restarts it if it dies.
// Windows: agent.ps1 · macOS: agent-macos.sh · Linux: agent.sh
const { spawn } = require('child_process');
const path = require('path');

function agentCommand(scriptDir, hub, token) {
  switch (process.platform) {
    case 'win32':
      return ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptDir, 'agent.ps1'),
        '-Hub', hub, '-ParentPid', String(process.pid)]];
    case 'darwin':
      return ['/bin/bash', [path.join(scriptDir, 'agent-macos.sh')]];
    default:
      return ['/bin/bash', [path.join(scriptDir, 'agent.sh')]];
  }
}

function startAgent({ hub, token, scriptDir, appVersion = '', log = console.log }) {
  let child = null, stopped = false, timer = null;
  const run = () => {
    const [cmd, args] = agentCommand(scriptDir, hub, token);
    // Hub/token go via the environment (not argv, which other local users can list).
    // PARENT_PID lets the shell agents exit if the app is killed.
    child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, env: { ...process.env, HUB: hub, TOKEN: token, DM_TOKEN: token, DM_APP_VERSION: appVersion, PARENT_PID: String(process.pid) } });
    child.on('error', e => log(`agent failed to start: ${e.message}`));
    child.on('exit', code => {
      if (stopped) return;
      log(`agent exited (${code}), restarting in 5s`);
      timer = setTimeout(run, 5000);
    });
  };
  const stop = () => { stopped = true; clearTimeout(timer); if (child) child.kill(); };
  process.on('exit', stop);
  run();
  return { stop };
}

module.exports = { startAgent };
