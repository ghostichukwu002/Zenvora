import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { normalizeNigerianPhone } from '../src/auth.js';
import { startApp, validUser } from './helpers.js';

let app;
before(async () => {
  app = await startApp();
});
after(() => app.close());

test('Nigerian phone numbers normalise to +234 format', () => {
  assert.equal(normalizeNigerianPhone('0803 123 4567'), '+2348031234567');
  assert.equal(normalizeNigerianPhone('+234 803 123 4567'), '+2348031234567');
  assert.equal(normalizeNigerianPhone('2348031234567'), '+2348031234567');
  assert.equal(normalizeNigerianPhone('0901-234-5678'), '+2349012345678');
});

test('invalid phone numbers are rejected', () => {
  for (const bad of ['', '12345', '0603 123 4567', '+1 415 555 0100', '080312345', 'abc', null, 8031234567]) {
    assert.equal(normalizeNigerianPhone(bad), null, `${bad} should be invalid`);
  }
});

test('registering creates an account and signs the user in with an httpOnly cookie', async () => {
  const c = app.client();
  const res = await c.request('POST', '/api/auth/register', validUser({ email: 'reg1@example.com' }));
  assert.equal(res.status, 201);
  assert.equal(res.json.user.email, 'reg1@example.com');
  assert.equal(res.json.user.phone, '+2348031234567');
  assert.equal(res.json.user.role, 'customer');
  assert.equal('password' in res.json.user, false);
  assert.equal('password_hash' in res.json.user, false);

  const authCookie = res.setCookies.find((l) => l.startsWith('zv_auth='));
  assert.ok(authCookie, 'auth cookie is set');
  assert.match(authCookie, /HttpOnly/);
  assert.match(authCookie, /SameSite=Lax/);

  const me = await c.request('GET', '/api/auth/me');
  assert.equal(me.json.user.email, 'reg1@example.com');
});

test('passwords are stored hashed, never in plain text', async () => {
  const c = app.client();
  await c.request('POST', '/api/auth/register', validUser({ email: 'hash@example.com', password: 'my plain secret 99' }));
  const row = app.db.prepare('SELECT password_hash FROM users WHERE email = ?').get('hash@example.com');
  assert.match(row.password_hash, /^scrypt\$/);
  assert.equal(row.password_hash.includes('my plain secret 99'), false);
});

test('session tokens are stored hashed, so a leaked database cannot be replayed', async () => {
  const c = app.client();
  await c.request('POST', '/api/auth/register', validUser({ email: 'tok@example.com' }));
  const token = c.jar.get('zv_auth');
  const rows = app.db.prepare('SELECT token_hash FROM sessions').all();
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.token_hash !== token));
});

test('registration validates email, password, name and phone', async () => {
  const cases = [
    [{ email: 'not-an-email' }, 'email_invalid'],
    [{ password: 'short' }, 'password_invalid'],
    [{ fullName: ' ' }, 'name_invalid'],
    [{ phone: '123' }, 'phone_invalid'],
  ];
  for (const [override, code] of cases) {
    const res = await app.client().request('POST', '/api/auth/register', validUser({ email: 'v@example.com', ...override }));
    assert.equal(res.status, 422, code);
    assert.equal(res.json.error.code, code);
  }
});

test('a duplicate email is refused, ignoring letter case', async () => {
  const first = await app.client().request('POST', '/api/auth/register', validUser({ email: 'dupe@example.com' }));
  assert.equal(first.status, 201);
  const second = await app.client().request('POST', '/api/auth/register', validUser({ email: 'DUPE@Example.com' }));
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'email_taken');
});

test('login works, and wrong password and unknown email look identical', async () => {
  await app.client().request('POST', '/api/auth/register', validUser({ email: 'login@example.com' }));

  const ok = await app.client().request('POST', '/api/auth/login', { email: 'login@example.com', password: 'correct horse battery' });
  assert.equal(ok.status, 200);

  const wrong = await app.client().request('POST', '/api/auth/login', { email: 'login@example.com', password: 'wrong password!' });
  const unknown = await app.client().request('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'wrong password!' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.json, unknown.json);
});

test('logout ends the session on the server, not just in the browser', async () => {
  const c = app.client();
  await c.request('POST', '/api/auth/register', validUser({ email: 'out@example.com' }));
  const stolen = c.jar.get('zv_auth');

  const out = await c.request('POST', '/api/auth/logout', {});
  assert.equal(out.status, 200);
  assert.equal((await c.request('GET', '/api/auth/me')).json.user, null);

  // Replaying the old cookie must not work.
  const replay = app.client();
  replay.jar.set('zv_auth', stolen);
  assert.equal((await replay.request('GET', '/api/auth/me')).json.user, null);
});

test('an expired session is rejected', async () => {
  const c = app.client();
  await c.request('POST', '/api/auth/register', validUser({ email: 'exp@example.com' }));
  app.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await c.request('GET', '/api/auth/me')).json.user, null);
});

test('profile updates require login and are validated', async () => {
  const anon = await app.client().request('PATCH', '/api/auth/profile', { fullName: 'X Y' });
  assert.equal(anon.status, 401);

  const c = app.client();
  await c.request('POST', '/api/auth/register', validUser({ email: 'prof@example.com' }));
  const ok = await c.request('PATCH', '/api/auth/profile', { fullName: 'Ada Nwosu', phone: '07012345678' });
  assert.equal(ok.json.user.fullName, 'Ada Nwosu');
  assert.equal(ok.json.user.phone, '+2347012345678');
  const bad = await c.request('PATCH', '/api/auth/profile', { fullName: 'Ada Nwosu', phone: '999' });
  assert.equal(bad.status, 422);
});

test('forgot-password answers the same for known and unknown emails', async () => {
  await app.client().request('POST', '/api/auth/register', validUser({ email: 'forgot@example.com' }));
  const known = await app.client().request('POST', '/api/auth/forgot-password', { email: 'forgot@example.com' });
  const unknown = await app.client().request('POST', '/api/auth/forgot-password', { email: 'ghost@example.com' });
  assert.equal(known.status, 200);
  assert.deepEqual(known.json, unknown.json);
  assert.equal(JSON.stringify(known.json).includes('token'), false, 'the token is never returned by the API');
});

test('password reset: token works once, changes the password, and signs out other sessions', async () => {
  const c = app.client();
  await c.request('POST', '/api/auth/register', validUser({ email: 'reset@example.com' }));
  app.resetTokens.length = 0;
  await app.client().request('POST', '/api/auth/forgot-password', { email: 'reset@example.com' });
  const { token } = app.resetTokens.at(-1);

  const done = await app.client().request('POST', '/api/auth/reset-password', { token, password: 'a brand new password' });
  assert.equal(done.status, 200);

  assert.equal((await c.request('GET', '/api/auth/me')).json.user, null, 'old session is signed out');
  const login = await app.client().request('POST', '/api/auth/login', { email: 'reset@example.com', password: 'a brand new password' });
  assert.equal(login.status, 200);
  const oldLogin = await app.client().request('POST', '/api/auth/login', { email: 'reset@example.com', password: 'correct horse battery' });
  assert.equal(oldLogin.status, 401);

  const again = await app.client().request('POST', '/api/auth/reset-password', { token, password: 'another password 1' });
  assert.equal(again.status, 400);
  assert.equal(again.json.error.code, 'reset_invalid');
});

test('an expired or made-up reset token is refused', async () => {
  await app.client().request('POST', '/api/auth/register', validUser({ email: 'late@example.com' }));
  app.resetTokens.length = 0;
  await app.client().request('POST', '/api/auth/forgot-password', { email: 'late@example.com' });
  const { token } = app.resetTokens.at(-1);
  app.db.prepare("UPDATE password_resets SET expires_at = '2000-01-01T00:00:00.000Z'").run();

  const expired = await app.client().request('POST', '/api/auth/reset-password', { token, password: 'new password 123' });
  assert.equal(expired.status, 400);
  const fake = await app.client().request('POST', '/api/auth/reset-password', { token: 'nope', password: 'new password 123' });
  assert.equal(fake.status, 400);
});

test('a reset token is stored hashed', async () => {
  await app.client().request('POST', '/api/auth/register', validUser({ email: 'hashreset@example.com' }));
  app.resetTokens.length = 0;
  await app.client().request('POST', '/api/auth/forgot-password', { email: 'hashreset@example.com' });
  const { token } = app.resetTokens.at(-1);
  const rows = app.db.prepare('SELECT token_hash FROM password_resets').all();
  assert.ok(rows.every((r) => r.token_hash !== token));
});

test('cross-site writes are blocked', async () => {
  const status = await new Promise((resolve, reject) => {
    const url = new URL(app.base);
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ email: 'a@b.co', password: 'x' }));
  });
  assert.equal(status, 403);
});

test('writes that are not JSON are refused', async () => {
  const res = await fetch(`${app.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'email=a@b.co&password=x',
  });
  assert.equal(res.status, 415);
});

test('login attempts are rate limited per IP', async () => {
  const limited = await startApp({ rateLimits: { authMax: 3, loginPerEmailMax: 1000 } });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await limited.client().request('POST', '/api/auth/login', { email: 'a@example.com', password: 'wrong password' });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  } finally {
    await limited.close();
  }
});

test('login attempts are rate limited per email, so one account cannot be guessed at', async () => {
  const limited = await startApp({ rateLimits: { authMax: 1000, loginPerEmailMax: 2 } });
  try {
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await limited.client().request('POST', '/api/auth/login', { email: 'target@example.com', password: 'guess guess' });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [401, 401, 429, 429]);
  } finally {
    await limited.close();
  }
});
