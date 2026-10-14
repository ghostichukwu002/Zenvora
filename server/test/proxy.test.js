import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

// Login attempts count against the limit whatever they contain, so an empty body is enough.
async function attempt(app, forwardedFor) {
  const c = app.client();
  const headers = forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {};
  return (await c.request('POST', '/api/auth/login', {}, headers)).status;
}

test('behind a trusted proxy, each visitor gets their own limit', async () => {
  const app = await startApp({ trustProxy: true, rateLimits: { authMax: 2, loginPerEmailMax: 1000 } });
  try {
    assert.notEqual(await attempt(app, '203.0.113.1'), 429);
    assert.notEqual(await attempt(app, '203.0.113.1'), 429);
    assert.equal(await attempt(app, '203.0.113.1'), 429, 'the third attempt from one visitor is limited');
    assert.notEqual(await attempt(app, '203.0.113.2'), 429, 'a different visitor is not affected');
  } finally {
    await app.close();
  }
});

test('the address the proxy appended is used, not one the client claims', async () => {
  const app = await startApp({ trustProxy: true, rateLimits: { authMax: 2, loginPerEmailMax: 1000 } });
  try {
    // A client forging a new address on every request still lands in one bucket.
    assert.notEqual(await attempt(app, '10.0.0.1, 203.0.113.9'), 429);
    assert.notEqual(await attempt(app, '10.0.0.2, 203.0.113.9'), 429);
    assert.equal(await attempt(app, '10.0.0.3, 203.0.113.9'), 429);
  } finally {
    await app.close();
  }
});

test('without a trusted proxy, forwarded headers are ignored', async () => {
  const app = await startApp({ rateLimits: { authMax: 2, loginPerEmailMax: 1000 } });
  try {
    assert.notEqual(await attempt(app, '203.0.113.1'), 429);
    assert.notEqual(await attempt(app, '203.0.113.2'), 429);
    assert.equal(await attempt(app, '203.0.113.3'), 429, 'all of these came from one connection');
  } finally {
    await app.close();
  }
});
