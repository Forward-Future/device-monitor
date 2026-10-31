const params = new URLSearchParams(location.search);
const hub = params.get('hub');
const repair = params.get('repair') === '1';
if (hub) document.getElementById('msg').textContent = repair
  ? 'This hub no longer accepts the enrollment or its TLS identity changed. Choose Change setup and paste a fresh desktop invitation.'
  : hub + ' is unavailable. Check its connection and HTTPS configuration.';
if (!repair) setTimeout(() => window.deviceMonitorApp.retry(), 10000);
document.getElementById('retry').addEventListener('click', () => window.deviceMonitorApp.retry());
document.getElementById('change').addEventListener('click', () => window.deviceMonitorApp.changeSetup());
