// Passkeys (FR-AUTH-05): sign in on /login, register on /settings/security. Loaded only on those pages.
const csrf = document.querySelector('input[name="_csrf"]');
const status = document.querySelector('[data-passkey-status]');
const say = (m) => { if (status) status.textContent = m; };

const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf ? csrf.value : '' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const supported = 'PublicKeyCredential' in window && typeof navigator.credentials?.get === 'function';

const loginBtn = document.querySelector('[data-passkey-login]');
if (loginBtn && supported) {
  loginBtn.hidden = false;
  loginBtn.addEventListener('click', async () => {
    try {
      const { data: o } = await post('/webauthn/login/options');
      const cred = await navigator.credentials.get({ publicKey: { challenge: fromB64u(o.challenge), rpId: o.rpId, userVerification: o.userVerification, timeout: o.timeout, allowCredentials: [] } });
      const r = cred.response;
      const res = await post('/webauthn/login/verify', {
        id: cred.id,
        response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), userHandle: r.userHandle ? toB64u(r.userHandle) : null },
      });
      if (res.ok && res.data.redirect) location.assign(res.data.redirect);
      else say(`✕ ${res.data.error || res.status}`);
    } catch (e) { say(`✕ ${e && e.name ? e.name : ''}`); }
  });
}

const regBtn = document.querySelector('[data-passkey-register]');
if (regBtn && supported) {
  regBtn.hidden = false;
  regBtn.addEventListener('click', async () => {
    try {
      const opt = await post('/api/v1/webauthn/register/options');
      if (opt.status === 401 && opt.data.reauth) { location.assign(opt.data.reauth); return; }
      const o = opt.data;
      const cred = await navigator.credentials.create({ publicKey: {
        ...o,
        challenge: fromB64u(o.challenge),
        user: { ...o.user, id: fromB64u(o.user.id) },
        excludeCredentials: o.excludeCredentials.map((c) => ({ ...c, id: fromB64u(c.id) })),
      } });
      const r = cred.response;
      const res = await post('/api/v1/webauthn/register/verify', {
        id: cred.id,
        name: navigator.userAgentData?.platform || '',
        response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] },
      });
      if (res.ok) location.reload(); else say(`✕ ${res.data.error || res.status}`);
    } catch (e) { say(`✕ ${e && e.name ? e.name : ''}`); }
  });
}
