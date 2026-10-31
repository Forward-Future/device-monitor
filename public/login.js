const form = document.querySelector('form'), input = document.querySelector('#invite'), error = document.querySelector('#error');
async function unlock(link) {
  const url = new URL(link);
  const code = new URLSearchParams(url.hash.slice(1)).get('join');
  if (url.origin !== location.origin || url.pathname !== '/unlock' || url.username || url.password || !/^[A-Za-z0-9_-]{43}$/.test(code || '')) throw new Error('Open the complete dashboard invitation at its original address.');
  const res = await fetch('/api/session', {method:'POST', credentials:'omit', redirect:'error', headers:{Authorization:'Bearer ' + code}});
  const result = await res.json();
  if (!res.ok || !/^[A-Za-z0-9_-]{43}$/.test(result.token || '')) throw new Error('This invitation expired or was already used. Copy a new one from the hub.');
  sessionStorage.setItem('dm.session', result.token);
  location.replace('/');
}
function submit(link) { return unlock(link).catch(e => { error.textContent = e.message; }); }
form.addEventListener('submit', e => { e.preventDefault(); submit(input.value.trim()); input.value = ''; });
if (location.hash) { const link = location.href; history.replaceState(null, '', '/unlock'); submit(link); }
