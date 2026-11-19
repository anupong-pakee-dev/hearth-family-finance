// Web Push opt-in for this device (FR-NOTI-01). Loaded only on the settings page.
const ui = document.querySelector('[data-push-ui]');
const status = document.querySelector('[data-push-status]');
const csrf = document.querySelector('input[name="_csrf"]');

const b64ToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json', 'x-csrf-token': csrf ? csrf.value : '' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

const say = (msg) => { if (status) status.textContent = msg; };

if (ui && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) {
  ui.hidden = false;
  const reg = await navigator.serviceWorker.ready;
  const current = await reg.pushManager.getSubscription();
  say(current ? '✓' : '');
  ui.addEventListener('click', async (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-push]') : null;
    if (!btn) return;
    try {
      if (btn.getAttribute('data-push') === 'on') {
        if ((await Notification.requestPermission()) !== 'granted') { say('✕'); return; }
        const { publicKey } = await api('/api/v1/push/key');
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
        await api('/api/v1/push/subscribe', sub.toJSON());
        say('✓');
      } else {
        const sub = await reg.pushManager.getSubscription();
        if (sub) { await api('/api/v1/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
        say('');
      }
    } catch (err) {
      say(`✕ ${err && err.message ? err.message : ''}`);
    }
  });
}
