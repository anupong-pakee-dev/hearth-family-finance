/**
 * Invite links work without e-mail (sign in or create an account, then join), and e-mail features are
 * shown disabled when the server cannot send mail.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, Client } from './helpers.ts';
import { config } from '../src/config.ts';

let app: Awaited<ReturnType<typeof startApp>>;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

async function ownerWithInvite(email: string) {
  const owner = new Client(app.base);
  await owner.register(email);
  await owner.post('/household', { name: 'Baan', display_name: 'Owner' }, '/household');
  const hh = /action="\/household\/([0-9a-f-]{36})\/invite"/.exec((await owner.get('/household')).text)![1];
  const r = await owner.post(`/household/${hh}/invite`, { role: 'member' }, '/household');
  const token = /invite=([\w-]+)/.exec(r.location!)![1];
  return { owner, token };
}

test('invite: without mail the form is link-only and the link points to /invite', async () => {
  const { owner, token } = await ownerWithInvite('inv-owner1@hearth.test');
  const page = (await owner.get('/household')).text;
  assert.ok(!/name="email" type="email"/.test(page), 'no e-mail field when mail is off');
  const created = (await owner.get(`/household?invite=${token}`)).text;
  assert.match(created, new RegExp(`/invite\\?token=${token}`));
});

test('invite: a new person opens the link, creates an account and joins', async () => {
  const { owner, token } = await ownerWithInvite('inv-owner2@hearth.test');
  const guest = new Client(app.base);
  const landing = await guest.get(`/invite?token=${token}`);
  assert.equal(landing.status, 200);
  assert.match(landing.text, /Baan/);
  assert.match(landing.text, new RegExp(`href="/register\\?invite=${token}"`));
  assert.match(landing.text, /href="\/login\?next=%2Fhousehold%2Fjoin%3Ftoken%3D/);

  const csrf = await guest.csrf(`/register?invite=${token}`);
  const reg = await guest.req('POST', '/register', { _csrf: csrf, invite: token, email: 'newbie@hearth.test', password: 'lantern-river-mango-42', name: 'Newbie' });
  assert.equal(reg.location, `/household/join?token=${token}`);
  await guest.post('/household/join', { token, display_name: 'Newbie' }, `/household/join?token=${token}`);
  assert.match((await owner.get('/household')).text, /Newbie/);
});

test('invite: an existing user signs in from the link and lands on the join page', async () => {
  const { token } = await ownerWithInvite('inv-owner3@hearth.test');
  const existing = new Client(app.base);
  await existing.register('existing@hearth.test');
  assert.equal((await existing.get(`/invite?token=${token}`)).location, `/household/join?token=${token}`);
  // Signed-out login page reached from the invite keeps the invite on "create account".
  const login = await new Client(app.base).get(`/login?next=${encodeURIComponent(`/household/join?token=${token}`)}`);
  assert.match(login.text, new RegExp(`href="/register\\?invite=${token}"`));
});

test('invite: bad or used token shows an error page', async () => {
  const r = await new Client(app.base).get('/invite?token=' + 'x'.repeat(32));
  assert.equal(r.status, 404);
});

test('mail off: forgot password is disabled, mail on: it is a link', async () => {
  const guest = new Client(app.base);
  let login = (await guest.get('/login')).text;
  assert.match(login, /class="link-disabled" aria-disabled="true"/);
  assert.ok(!login.includes('href="/forgot"'));
  assert.match((await guest.get('/forgot')).text, /send e-mail yet/);

  const saved = { mailTransport: config.mailTransport, resendApiKey: config.resendApiKey };
  Object.assign(config, { mailTransport: 'resend', resendApiKey: 're_test' });
  try {
    login = (await guest.get('/login')).text;
    assert.ok(login.includes('href="/forgot"'));
  } finally { Object.assign(config, saved); }
});

test('mail off: registering an existing e-mail says to sign in instead of "check your e-mail"', async () => {
  await new Client(app.base).register('dupe@hearth.test');
  const c = new Client(app.base);
  const csrf = await c.csrf('/register');
  const r = await c.req('POST', '/register', { _csrf: csrf, email: 'dupe@hearth.test', password: 'lantern-river-mango-42', name: 'Dupe' });
  assert.equal(r.location, '/login?err=account_exists');
});
