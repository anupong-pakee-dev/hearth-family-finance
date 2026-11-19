// Hearth — progressive enhancement only. The app works fully without JavaScript.
// Trusted Types policy (NFR-SEC-20): the only sink we use is the service-worker URL.
const policy = window.trustedTypes ? window.trustedTypes.createPolicy('hearth', {
  createScriptURL: (u) => { if (u === '/sw.js') return u; throw new TypeError('blocked script URL'); },
}) : null;

if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register(policy ? policy.createScriptURL('/sw.js') : '/sw.js', { scope: '/' }).catch(() => {});
  });
  // NFR-UX-02: replay transactions queued while offline
  const flush = () => { if (navigator.onLine) navigator.serviceWorker.controller?.postMessage('flush'); };
  addEventListener('online', flush);
  addEventListener('load', flush);
}

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t instanceof HTMLSelectElement && t.hasAttribute('data-autosubmit') && t.form) t.form.requestSubmit();
});

document.addEventListener('submit', (e) => {
  const f = e.target;
  if (!(f instanceof HTMLFormElement)) return;
  // signing out wipes the offline queue and the cached form from this device
  if (f.getAttribute('action') === '/logout') navigator.serviceWorker?.controller?.postMessage('logout');
  const msg = f.getAttribute('data-confirm');
  if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
  // prevent double submits (e.g. duplicate transactions)
  const b = e.submitter || f.querySelector('button[type=submit],button:not([type])');
  // …but not when a script handled the submit in the page (e.g. the calculator), or the button would stay dead
  if (b instanceof HTMLButtonElement) setTimeout(() => { if (!e.defaultPrevented) b.disabled = true; }, 0);
}, true);

document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (t.closest('[data-print]')) window.print();
  const c = t.closest('input.copy');
  if (c instanceof HTMLInputElement) { c.select(); navigator.clipboard?.writeText(c.value).catch(() => {}); }
});

// Re-enable buttons when navigating back from bfcache.
addEventListener('pageshow', () => { for (const b of document.querySelectorAll('button:disabled')) b.disabled = false; });
