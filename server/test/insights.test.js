import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { newKey, startApp, validDelivery, validUser } from './helpers.js';

let app;
beforeEach(async () => { app = await startApp({}); });
afterEach(() => app.close());

async function adminClient() {
  const c = app.client();
  const res = await c.request('POST', '/api/auth/register', validUser({ email: `boss${Math.random().toString(36).slice(2, 8)}@example.com` }));
  app.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(res.json.user.id);
  return c;
}

async function orderFrom(productId, areaName = 'Ikoyi') {
  const c = app.client();
  await c.request('POST', '/api/auth/register', validUser({ email: `shopper${Math.random().toString(36).slice(2, 8)}@example.com` }));
  await c.request('POST', '/api/cart/items', { productId, quantity: 1 });
  await c.request('PUT', '/api/cart/delivery-area', { area: areaName });
  const res = await c.request('POST', '/api/orders', { idempotencyKey: newKey(), paymentMethod: 'cash_on_delivery', delivery: validDelivery() });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.order;
}

test('insights are for administrators only', async () => {
  const c = app.client();
  await c.request('POST', '/api/auth/register', validUser({ email: 'plain@example.com' }));
  assert.equal((await c.request('GET', '/api/admin/insights')).status, 403);
  assert.equal((await app.client().request('GET', '/api/admin/insights')).status, 401);
});

test('an empty shop reports zeros and fourteen days of trend', async () => {
  const admin = await adminClient();
  const res = await admin.request('GET', '/api/admin/insights');
  assert.equal(res.status, 200);
  assert.equal(res.json.days.length, 14);
  assert.equal(res.json.today.orders, 0);
  assert.equal(res.json.last14Days.revenueKobo, 0);
  assert.deepEqual(res.json.topProducts, []);
});

test('orders are counted once, by storefront, and rejected orders are left out of money', async () => {
  const admin = await adminClient();
  const shopOrder = await orderFrom('p-chicken-wrap');
  const puffOrder = await orderFrom('p-cigar-pack');

  const res = await admin.request('GET', '/api/admin/insights');
  assert.equal(res.json.today.orders, 2);
  assert.equal(res.json.today.revenueKobo, shopOrder.totalKobo + puffOrder.totalKobo);
  assert.equal(res.json.sections.shop.orders, 1);
  assert.equal(res.json.sections.shop.revenueKobo, shopOrder.totalKobo);
  assert.equal(res.json.sections.puff.orders, 1);
  assert.equal(res.json.sections.puff.revenueKobo, puffOrder.totalKobo);
  assert.equal(res.json.statuses.placed, 2);
  assert.equal(res.json.topProducts.length, 2);
  assert.ok(res.json.topProducts.every((p) => p.quantity === 1));

  app.db.prepare("UPDATE orders SET status = 'rejected' WHERE id = ?").run(puffOrder.id);
  const after = await admin.request('GET', '/api/admin/insights');
  assert.equal(after.json.today.orders, 1);
  assert.equal(after.json.sections.puff.orders, 0);
  assert.equal(after.json.statuses.rejected, 1);
});
