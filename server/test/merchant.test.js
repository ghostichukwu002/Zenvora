import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { newKey, startApp, validDelivery, validUser } from './helpers.js';

const CODES = {
  'm-sample-kitchen': 'kitchen-test-claim-code-0001',
  'm-sample-market': 'market-test-claim-code-0002',
  'm-sample-tech': 'tech-test-claim-code-0003',
};

let app;
let counter = 0;

beforeEach(async () => {
  app = await startApp({ merchantClaimCodes: CODES });
});
afterEach(() => app.close());

async function signedIn(prefix = 'user') {
  counter += 1;
  const c = app.client();
  const res = await c.request('POST', '/api/auth/register', validUser({ email: `${prefix}${counter}@example.com` }));
  assert.equal(res.status, 201);
  return c;
}

// A signed-in staff account for one store.
async function staffFor(merchantId) {
  const c = await signedIn('staff');
  const res = await c.request('POST', '/api/merchant/claim', { merchantId, code: CODES[merchantId] });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return c;
}

// A customer orders from a store. Returns the placed order.
async function customerOrder(productId, quantity = 1, area = 'Ikoyi') {
  const c = await signedIn('buyer');
  await c.request('POST', '/api/cart/items', { productId, quantity });
  await c.request('PUT', '/api/cart/delivery-area', { area });
  const res = await c.request('POST', '/api/orders', {
    idempotencyKey: newKey(),
    paymentMethod: 'cash_on_delivery',
    delivery: validDelivery(),
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.order;
}

const statusPath = (merchantId, orderId) => `/api/merchant/${merchantId}/orders/${orderId}`;

// ---------- Claiming a store ----------

test('claiming a store needs a signed-in account', async () => {
  const res = await app.client().request('POST', '/api/merchant/claim', {
    merchantId: 'm-sample-kitchen',
    code: CODES['m-sample-kitchen'],
  });
  assert.equal(res.status, 401);
});

test('a wrong claim code is refused and grants nothing', async () => {
  const c = await signedIn();
  const res = await c.request('POST', '/api/merchant/claim', { merchantId: 'm-sample-kitchen', code: 'guess' });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'claim_invalid');
  assert.deepEqual((await c.request('GET', '/api/merchant/memberships')).json.items, []);
});

test('a store with no claim code configured cannot be claimed', async () => {
  const bare = await startApp({ merchantClaimCodes: {} });
  try {
    const c = bare.client();
    await c.request('POST', '/api/auth/register', validUser({ email: 'nocode@example.com' }));
    const res = await c.request('POST', '/api/merchant/claim', { merchantId: 'm-sample-kitchen', code: 'anything' });
    assert.equal(res.status, 403);
  } finally {
    await bare.close();
  }
});

test('an unknown store is reported as not found', async () => {
  const c = await signedIn();
  const res = await c.request('POST', '/api/merchant/claim', { merchantId: 'm-nope', code: 'x' });
  assert.equal(res.status, 404);
});

test('the right code grants access to that store only', async () => {
  const c = await staffFor('m-sample-kitchen');
  const list = await c.request('GET', '/api/merchant/memberships');
  assert.deepEqual(list.json.items, [{ id: 'm-sample-kitchen', name: 'Sample Kitchen (demo)' }]);
  assert.equal((await c.request('GET', '/api/merchant/m-sample-market/orders')).status, 404);
});

test('the claim code is never returned by the API', async () => {
  const c = await staffFor('m-sample-kitchen');
  const everything = JSON.stringify([
    await c.request('GET', '/api/merchant/memberships'),
    await c.request('GET', '/api/merchant/m-sample-kitchen/products'),
  ]);
  assert.equal(everything.includes(CODES['m-sample-kitchen']), false);
});

test('a non-member gets "not found" on every merchant route', async () => {
  const outsider = await signedIn('outsider');
  const checks = [
    ['GET', '/api/merchant/m-sample-kitchen/orders'],
    ['GET', '/api/merchant/m-sample-kitchen/products'],
    ['PATCH', '/api/merchant/m-sample-kitchen/products/p-chicken-wrap', { stock: 1 }],
    ['PATCH', '/api/merchant/m-sample-kitchen/orders/ZV-0000000000', { status: 'accepted' }],
  ];
  for (const [method, path, body] of checks) {
    const res = await outsider.request(method, path, body);
    assert.equal(res.status, 404, `${method} ${path}`);
  }
});

test('anonymous visitors cannot use merchant routes', async () => {
  const res = await app.client().request('GET', '/api/merchant/m-sample-kitchen/orders');
  assert.equal(res.status, 401);
});

// ---------- Orders ----------

test("a store sees its own orders, never another store's", async () => {
  await customerOrder('p-chicken-wrap');
  const kitchen = await staffFor('m-sample-kitchen');
  const market = await staffFor('m-sample-market');

  const mine = await kitchen.request('GET', '/api/merchant/m-sample-kitchen/orders');
  assert.equal(mine.json.items.length, 1);
  assert.equal(mine.json.items[0].delivery.phone, '+2348031234567');

  const theirs = await market.request('GET', '/api/merchant/m-sample-market/orders');
  assert.equal(theirs.json.items.length, 0);
});

test("a store cannot change an order that belongs to another store", async () => {
  const order = await customerOrder('p-chicken-wrap');
  const market = await staffFor('m-sample-market');
  const res = await market.request('PATCH', statusPath('m-sample-market', order.id), { status: 'accepted' });
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'order_not_found');
});

test('an order moves forward one allowed step at a time', async () => {
  const order = await customerOrder('p-chicken-wrap');
  const kitchen = await staffFor('m-sample-kitchen');
  const path = statusPath('m-sample-kitchen', order.id);

  const skip = await kitchen.request('PATCH', path, { status: 'ready' });
  assert.equal(skip.status, 409);
  assert.equal(skip.json.error.code, 'invalid_transition');

  for (const next of ['accepted', 'preparing', 'ready']) {
    const res = await kitchen.request('PATCH', path, { status: next });
    assert.equal(res.status, 200, next);
    assert.equal(res.json.order.status, next);
  }
});

test("a store cannot mark an order delivered, and cannot mark it paid", async () => {
  const order = await customerOrder('p-chicken-wrap');
  const kitchen = await staffFor('m-sample-kitchen');
  const path = statusPath('m-sample-kitchen', order.id);
  for (const next of ['accepted', 'preparing', 'ready']) {
    await kitchen.request('PATCH', path, { status: next });
  }
  const res = await kitchen.request('PATCH', path, { status: 'delivered' });
  assert.equal(res.status, 409);

  const stored = (await kitchen.request('GET', '/api/merchant/m-sample-kitchen/orders')).json.items[0];
  assert.equal(stored.status, 'ready');
  assert.equal(stored.paymentStatus, 'cod_pending');
});

test('a status change to an unknown value is refused', async () => {
  const order = await customerOrder('p-chicken-wrap');
  const kitchen = await staffFor('m-sample-kitchen');
  const res = await kitchen.request('PATCH', statusPath('m-sample-kitchen', order.id), { status: 'paid' });
  assert.equal(res.status, 409);
});

test('rejecting an order returns its reserved stock to the catalogue', async () => {
  // Power bank (Sample Tech) starts with 3. The order reserves 2.
  const order = await customerOrder('p-power-bank', 2, 'Yaba');
  assert.equal(app.catalogue.products.find((p) => p.id === 'p-power-bank').stock, 1);

  const tech = await staffFor('m-sample-tech');
  const res = await tech.request('PATCH', statusPath('m-sample-tech', order.id), { status: 'rejected' });
  assert.equal(res.status, 200);
  assert.equal(app.catalogue.products.find((p) => p.id === 'p-power-bank').stock, 3);

  // Once rejected, it cannot be reopened.
  const reopen = await tech.request('PATCH', statusPath('m-sample-tech', order.id), { status: 'accepted' });
  assert.equal(reopen.status, 409);
  assert.equal(app.catalogue.products.find((p) => p.id === 'p-power-bank').stock, 3, 'stock is not returned twice');
});

test('a rejected order is not counted in sales figures', async () => {
  const order = await customerOrder('p-chicken-wrap');
  const kitchen = await staffFor('m-sample-kitchen');
  const before = (await kitchen.request('GET', '/api/merchant/m-sample-kitchen/orders')).json.summary;
  assert.equal(before.allTime.orders, 1);
  assert.equal(before.allTime.valueKobo, 230000);

  await kitchen.request('PATCH', statusPath('m-sample-kitchen', order.id), { status: 'rejected' });
  const after = (await kitchen.request('GET', '/api/merchant/m-sample-kitchen/orders')).json.summary;
  assert.equal(after.allTime.orders, 0);
  assert.equal(after.last7Days.valueKobo, 0);
  assert.equal(after.byStatus.rejected, 1);
});

// ---------- Products ----------

test('a store lists only its own products', async () => {
  const kitchen = await staffFor('m-sample-kitchen');
  const res = await kitchen.request('GET', '/api/merchant/m-sample-kitchen/products');
  assert.ok(res.json.items.length > 0);
  assert.ok(res.json.items.every((p) => p.id.startsWith('p-jollof') || p.id.startsWith('p-chicken')));
});

test('a store can see exact stock for its own products', async () => {
  const market = await staffFor('m-sample-market');
  const rice = (await market.request('GET', '/api/merchant/m-sample-market/products')).json.items.find((p) => p.id === 'p-rice-5kg');
  assert.equal(rice.stock, 24);
});

test('a store can change stock, and an empty stock value means made-to-order', async () => {
  const market = await staffFor('m-sample-market');
  const path = '/api/merchant/m-sample-market/products/p-rice-5kg';
  const set = await market.request('PATCH', path, { stock: 30 });
  assert.equal(set.status, 200);
  assert.equal(set.json.product.stock, 30);
  assert.equal(app.catalogue.products.find((p) => p.id === 'p-rice-5kg').stock, 30);

  const madeToOrder = await market.request('PATCH', path, { stock: null });
  assert.equal(madeToOrder.json.product.stock, null);
});

test('a store cannot change another store\'s product', async () => {
  const market = await staffFor('m-sample-market');
  const res = await market.request('PATCH', '/api/merchant/m-sample-market/products/p-earbuds', { stock: 1 });
  assert.equal(res.status, 404);
  assert.equal(app.catalogue.products.find((p) => p.id === 'p-earbuds').stock, 8);
});

test('invalid stock values are refused and change nothing', async () => {
  const market = await staffFor('m-sample-market');
  const path = '/api/merchant/m-sample-market/products/p-rice-5kg';
  for (const bad of [-1, 1.5, '12', 1e9]) {
    const res = await market.request('PATCH', path, { stock: bad });
    assert.equal(res.status, 422, JSON.stringify(bad));
  }
  assert.equal(app.catalogue.products.find((p) => p.id === 'p-rice-5kg').stock, 24);
});

test('an offer price must be lower than the regular price', async () => {
  const market = await staffFor('m-sample-market');
  const path = '/api/merchant/m-sample-market/products/p-cooking-oil';
  const bad = await market.request('PATCH', path, { promoPriceKobo: 800000 }); // regular is 7,200.00
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, 'promo_invalid');

  const good = await market.request('PATCH', path, { promoPriceKobo: 600000 });
  assert.equal(good.status, 200);
  assert.equal(good.json.product.promoPriceKobo, 600000);
});

test('a price change is checked together with the offer price already set', async () => {
  const market = await staffFor('m-sample-market');
  // Cooking oil has an offer at 6,500.00. Lowering the regular price to 6,000.00 would leave the offer above it.
  const res = await market.request('PATCH', '/api/merchant/m-sample-market/products/p-cooking-oil', { priceKobo: 600000 });
  assert.equal(res.status, 422);
  assert.equal(app.catalogue.products.find((p) => p.id === 'p-cooking-oil').priceKobo, 720000, 'nothing was written');
});
