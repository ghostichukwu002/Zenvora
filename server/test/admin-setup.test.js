import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, validUser } from './helpers.js';

test('an account on the admin list is an administrator when it registers', async () => {
  const app = await startApp({ adminEmails: ['boss@example.com'] });
  try {
    const boss = app.client();
    const res = await boss.request('POST', '/api/auth/register', validUser({ email: '  Boss@Example.com ' }));
    assert.equal(res.status, 201);
    assert.equal(res.json.user.role, 'admin');
    assert.equal((await boss.request('GET', '/api/admin/overview')).status, 200);

    const other = app.client();
    const plain = await other.request('POST', '/api/auth/register', validUser({ email: 'someone@example.com' }));
    assert.equal(plain.json.user.role, 'customer');
    assert.equal((await other.request('GET', '/api/admin/overview')).status, 403);
  } finally {
    await app.close();
  }
});

test('existing accounts on the admin list are upgraded at startup, with an audit entry', async () => {
  // First run: the account exists as a customer.
  const first = await startApp();
  const user = validUser({ email: 'later@example.com' });
  await first.client().request('POST', '/api/auth/register', user);
  await first.close();

  // Restart with the same database and the admin list.
  const db = first.db;
  const second = await startApp({ db, adminEmails: ['later@example.com'] });
  try {
    const row = db.prepare("SELECT role FROM users WHERE email = 'later@example.com'").get();
    assert.equal(row.role, 'admin');
    const audit = db.prepare("SELECT detail_json FROM audit_log WHERE action = 'account.role_changed'").get();
    assert.ok(audit, 'the change is recorded');
    assert.equal(JSON.parse(audit.detail_json).via, 'ZENVORA_ADMIN_EMAILS');
    const c = second.client();
    const login = await c.request('POST', '/api/auth/login', { email: user.email, password: user.password });
    assert.equal(login.status, 200);
    assert.equal((await c.request('GET', '/api/admin/overview')).status, 200);
  } finally {
    await second.close();
  }
});

test('removing an email from the list does not demote the account', async () => {
  const app = await startApp({ adminEmails: [] });
  try {
    const user = validUser({ email: 'stays@example.com' });
    await app.client().request('POST', '/api/auth/register', user);
    app.db.prepare("UPDATE users SET role = 'admin' WHERE email = 'stays@example.com'").run();
    const second = await startApp({ db: app.db, adminEmails: [] });
    try {
      const row = app.db.prepare("SELECT role FROM users WHERE email = 'stays@example.com'").get();
      assert.equal(row.role, 'admin');
    } finally {
      await second.close();
    }
  } finally {
    await app.close();
  }
});
