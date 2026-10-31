// Web sessions live in one tab and origin (including port). Native dashboards
// use a bundled origin; their main process authenticates data requests.
const nativeDashboard = location.protocol === 'dmapp:';
function hubFetch(resource, options = {}) {
  const url = new URL(resource, location.href);
  if (url.protocol !== location.protocol || url.host !== location.host || !url.pathname.startsWith('/api/')) throw new Error('Invalid dashboard request');
  const headers = new Headers(options.headers);
  if (!nativeDashboard) {
    const token = sessionStorage.getItem('dm.session');
    if (token) headers.set('Authorization', 'Bearer ' + token);
  }
  return fetch(url, { ...options, headers, redirect:'error', credentials:'omit', cache:'no-store' }).then(res => {
    if (res.status === 401 && !nativeDashboard) { sessionStorage.removeItem('dm.session'); location.replace('/unlock'); }
    return res;
  });
}
class HubEvents {
  constructor() {
    this.controller = new AbortController();
    addEventListener('pagehide', () => this.controller.abort(), { once:true });
    queueMicrotask(() => this.read());
  }
  async read() {
    const signal = this.controller.signal;
    try {
      const response = await hubFetch('/api/stream', {signal});
      if (!response.ok) throw new Error('Stream unavailable');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let pending = '';
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, {stream:true});
          if (pending.length > 48 * 1024 * 1024) throw new Error('Snapshot too large');
          let end;
          while ((end = pending.indexOf('\n\n')) !== -1) {
            const frame = pending.slice(0, end); pending = pending.slice(end + 2);
            if (frame.startsWith('data: ')) this.onmessage?.({ data:frame.slice(6) });
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
    } catch {}
    if (!signal.aborted) { this.onerror?.(); setTimeout(() => { if (!signal.aborted) this.read(); }, 3000); }
  }
}
