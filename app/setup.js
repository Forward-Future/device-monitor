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
  if (r.needCode) { $('codeRow').hidden = false; $('code').focus(); }
}
$('hostBtn').onclick = () => go({ mode: 'host' }, 'Starting hub… approve the Windows prompt to let other devices connect.');
const connect = hubUrl => go({ mode: 'client', hubUrl, code: $('codeRow').hidden ? undefined : $('code').value }, 'Connecting…');
$('connectBtn').onclick = () => connect($('addr').value);
for (const id of ['addr', 'code']) $(id).addEventListener('keydown', e => { if (e.key === 'Enter') $('connectBtn').click(); });

async function scan() {
  const hubs = await api.discover();
  const box = $('found');
  if (!hubs.length) { box.innerHTML = '<span class="hint">No hubs found automatically — enter the address below.</span>'; return; }
  box.innerHTML = '';
  for (const h of hubs) {
    // Discovery replies come from the network: build with textContent, never innerHTML.
    const b = document.createElement('button');
    const name = document.createElement('span'); name.textContent = h.name;
    const where = document.createElement('small'); where.textContent = h.url;
    b.append(name, where);
    b.onclick = () => { $('addr').value = h.url; connect(h.url); };
    box.appendChild(b);
  }
}
scan();
