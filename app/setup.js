const api = window.deviceMonitorApp;
const $ = id => document.getElementById(id);
const err = m => { $('err').textContent = m || ''; };
const busy = (on, label) => {
  for (const b of document.querySelectorAll('button')) b.disabled = on;
  if (label) $('err').textContent = label;
};
async function go(opts, label) {
  busy(true, label); $('err').style.color = 'var(--text-secondary)';
  const r = await api.setup(opts);
  busy(false); $('err').style.color = '';
  if (!r.ok) err(r.error);
}
$('hostBtn').onclick = () => go({ mode: 'host' }, 'Starting hub… approve the Windows prompt to let other devices connect.');
const connect = () => go({ mode:'client', hubUrl:$('addr').value }, 'Verifying the hub…');
$('connectBtn').onclick = connect;
$('addr').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
