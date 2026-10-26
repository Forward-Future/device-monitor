const hub = new URLSearchParams(location.search).get('hub');
  if (hub) document.getElementById('msg').textContent = `${hub} isn't responding. The PC hosting the dashboard may be off or asleep.`;
  setTimeout(() => window.deviceMonitorApp.retry(), 10000);
document.getElementById('retry').addEventListener('click', () => window.deviceMonitorApp.retry());
document.getElementById('change').addEventListener('click', () => window.deviceMonitorApp.changeSetup());
