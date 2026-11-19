// Service worker
//  - NFR-PERF-13: caches the immutable app-shell assets
//  - NFR-UX-02: the "add transaction" form works offline; submissions are queued in IndexedDB and replayed
//  - FR-NOTI-01: Web Push notifications
// Financial pages are never cached, except the transaction form (accounts/categories only) for offline entry.
const CACHE = 'hearth-static-v2';
const FORM_CACHE = 'hearth-form-v1';
const FORM_URL = '/transactions/new';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FORM_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const page = (title, text) => new Response(`<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Hearth</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:1rem;text-align:center"><h1>${title}</h1>${text}<p><a href="/transactions/new">+</a> · <a href="/">Hearth</a></p></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });

const OFFLINE = () => page('ออฟไลน์ / Offline', '<p>ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ — You are offline.</p>');
const QUEUED = () => page('บันทึกไว้แล้ว / Saved offline', '<p>รายการถูกเก็บไว้ในเครื่อง และจะส่งอัตโนมัติเมื่อกลับมาออนไลน์</p><p lang="en">Stored on this device and sent automatically when you are back online.</p>');

// ───── IndexedDB outbox ─────
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('hearth-outbox', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('q', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('q', mode);
    const out = fn(t.objectStore('q'));
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
  });
}
const enqueue = (item) => tx('readwrite', (s) => s.add(item));
const all = () => tx('readonly', (s) => s.getAll());
const remove = (id) => tx('readwrite', (s) => s.delete(id));
const clear = () => tx('readwrite', (s) => s.clear());

async function flush() {
  const items = (await all()) || [];
  for (const it of items) {
    try {
      const res = await fetch(it.url, { method: 'POST', body: it.body, headers: { 'content-type': it.type }, credentials: 'same-origin', redirect: 'manual' });
      // 303 = saved; 403 = expired session/CSRF (cannot be replayed safely) → drop to avoid loops
      if (res.status === 303 || res.status === 0 || res.ok || res.status === 403 || res.status === 422) await remove(it.id);
    } catch { return; } // still offline
  }
}

self.addEventListener('sync', (e) => { if (e.tag === 'hearth-outbox') e.waitUntil(flush()); });
self.addEventListener('message', (e) => {
  if (e.data === 'flush') e.waitUntil(flush());
  if (e.data === 'logout') e.waitUntil(Promise.all([clear(), caches.delete(FORM_CACHE)]));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.method === 'POST' && url.pathname === '/transactions') {
    e.respondWith((async () => {
      const copy = req.clone();
      try {
        return await fetch(req);
      } catch {
        const type = copy.headers.get('content-type') || 'application/x-www-form-urlencoded';
        await enqueue({ url: url.pathname, type, body: await copy.arrayBuffer(), at: Date.now() });
        try { await self.registration.sync.register('hearth-outbox'); } catch { /* no Background Sync: flushed on next visit */ }
        return QUEUED();
      }
    })());
    return;
  }
  if (req.method !== 'GET') return;

  if (url.pathname.startsWith('/static/')) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (req.mode === 'navigate') {
    if (url.pathname === FORM_URL) {
      e.respondWith(fetch(req).then(async (res) => {
        if (res.ok && res.headers.get('content-type')?.startsWith('text/html')) (await caches.open(FORM_CACHE)).put(FORM_URL, res.clone());
        return res;
      }).catch(async () => (await caches.match(FORM_URL)) || OFFLINE()));
      return;
    }
    e.respondWith(fetch(req).catch(OFFLINE));
  }
});

// ───── Web Push ─────
self.addEventListener('push', (e) => {
  let data = { title: 'Hearth', body: '', url: '/' };
  try { data = { ...data, ...e.data.json() }; } catch { /* plain text */ }
  e.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/icon.svg', badge: '/icon.svg', data: { url: data.url }, lang: 'th' }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data && e.notification.data.url ? e.notification.data.url : '/', location.origin);
  if (target.origin !== location.origin) return;
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => {
    for (const c of list) if (c.url.startsWith(location.origin) && 'focus' in c) { c.navigate(target.href); return c.focus(); }
    return self.clients.openWindow(target.href);
  }));
});
