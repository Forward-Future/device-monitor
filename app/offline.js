const params = new URLSearchParams(location.search);
const hub = params.get('hub');
const repair = params.get('repair') === '1';
if (hub) document.getElementById('msg').textContent = repair
  ? 'The verified hub no longer accepts this enrollment. Choose Change setup and paste a fresh desktop invitation.'
  : 'Could not connect to ' + hub + ' and verify its identity. Retrying automatically.';
if (!repair) setTimeout(() => window.deviceMonitorApp.retry(), 10000);
document.getElementById('retry').addEventListener('click', () => window.deviceMonitorApp.retry());
document.getElementById('change').addEventListener('click', () => window.deviceMonitorApp.changeSetup());
