import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { newKey, startApp, validDelivery, validUser } from './helpers.js';

let app;
beforeEach(async () => {
  app = await startApp();
});
afterEach(() => app.close());

let counter = 0;
async function signedInClient(email) {
  counter += 1;
  const c = app.client();
  const res = await c.request('POST', '/api/auth/register', validUser({ email: email ?? `buyer${counter}@example.com` }));
  assert.equal(res.status, 201);
  return c;
}

async function cartWith(c, items, area = 'Ikoyi') {
  for (const item of items) {
    const res = await c.request('POST', '/api/cart/items', item);
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }
  if (area) {
    const res = await c.request('PUT', '/api/cart/delivery-area', { area });
    assert.equal(res.status, 200, JSON.stringify(res.json));
  }
}

const wrap = (quantity = 1) => ({ productId: 'p-chicken-wrap', quantity });
const checkout = (c, overrides = {}) =>
  c.request('POST', '/api/orders', {
    idempotencyKey: newKey(),
    paymentMethod: 'cash_on_delivery',
    delivery: validDelivery(),
    ...overrides,
  });

test('checkout needs a signed-in user', async () => {
  const c = app.client();
  await cartWith(c, [wrap()]);
  const res = await checkout(c);
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'auth_required');
});

test('a cash-on-delivery order is placed with server-computed totals', async () => {
  const c = await signedInClient();
  await cartWith(c, [wrap(2)]);
  const res = await checkout(c);

  assert.equal(res.status, 201);
  const { order } = res.json;
  assert.match(order.id, /^ZV-[0-9A-F]{10}$/);
  assert.equal(order.subtotalKobo, 150000 * 2); // promotional price, not the 1,800.00 list price
  assert.equal(order.deliveryFeeKobo, 80000);
  assert.equal(order.totalKobo, 380000);
  assert.equal(order.merchant.name, 'Sample Kitchen (demo)');
  assert.equal(order.delivery.phone, '+2348031234567');
  assert.equal(order.delivery.area, 'Ikoyi');
});

test('a new order is never marked paid or delivered', async () => {
  const c = await signedInClient();
  await cartWith(c, [wrap()]);
  const { order } = (await checkout(c)).json;
  assert.equal(order.status, 'placed');
  assert.equal(order.paymentStatus, 'cod_pending');
});

test('values sent by the browser cannot change what is charged', async () => {
  const c = await signedInClient();
  await cartWith(c, [wrap()]);
  const res = await checkout(c, { totalKobo: 1, subtotalKobo: 1, deliveryFeeKobo: 0, paymentStatus: 'paid', status: 'delivered' });
  assert.equal(res.status, 201);
  assert.equal(res.json.order.totalKobo, 150000 + 80000);
  assert.equal(res.json.order.paymentStatus, 'cod_pending');
  assert.equal(res.json.order.status, 'placed');
});

test('placing an order empties the cart', async () => {
  const c = await signedInClient();
  await cartWith(c, [wrap()]);
  await checkout(c);
  const cart = await c.request('GET', '/api/cart');
  assert.equal(cart.json.itemCount, 0);
});

test('retrying the same submission returns the same order and creates no second one', async () => {
  const c = await signedInClient();
  await cartWith(c, [{ productId: 'p-power-bank', quantity: 1 }], 'Yaba');
  const key = newKey();

  const first = await checkout(c, { idempotencyKey: key });
  const second = await checkout(c, { idempotencyKey: key });

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json.replayed, true);
  assert.equal(second.json.order.id, first.json.order.id);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  // Stock was taken once: power bank started at 3.
  assert.equal(app.catalogue.products.find((p) => p.id === 'p-power-bank').stock, 2);
});

test('two submissions sent at the same moment still create one order', async () => {
  const c = await signedInClient();
  await cartWith(c, [{ productId: 'p-power-bank', quantity: 1 }], 'Yaba');
  const key = newKey();
  const [a, b] = await Promise.all([checkout(c, { idempotencyKey: key }), checkout(c, { idempotencyKey: key })]);
  assert.equal(a.json.order.id, b.json.order.id);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  assert.equal(app.catalogue.products.find((p) => p.id === 'p-power-bank').stock, 2);
});

test('an idempotency key is required and must look valid', async () => {
  const c = await signedInClient();
  await cartWith(c, [wrap()]);
  for (const key of [undefined, '', 'short', 'has spaces and is long enough here', 12345]) {
    const res = await checkout(c, { idempotencyKey: key });
    assert.equal(res.status, 400, `key ${JSON.stringify(key)}`);
    assert.equal(res.json.error.code, 'idempotency_key_required');
  }
});

test('only cash on delivery is accepted for now', async () => {
  const c = await signedInClient();
  await cartWith(c, [wrap()]);
  for (const method of ['card', 'bank_transfer', 'paid', undefined]) {
    const res = await checkout(c, { paymentMethod: method });
    assert.equal(res.status, 422, `method ${method}`);
    assert.equal(res.json.error.code, 'payment_method_unsupported');
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
});

test('an empty cart cannot be checked out', async () => {
  const c = await signedInClient();
  const res = await checkout(c);
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'cart_empty');
});

test('a delivery area must be chosen first', async () => {
  const c = await signedInClient();
  await cartWith(c, [wrap()], null);
  const res = await checkout(c);
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'area_required');
});

test('delivery details are validated', async () => {
  const c = await signedInClient();
  await cartWith(c, [wrap()]);
  const cases = [
    [{ name: '' }, 'name_invalid'],
    [{ phone: '12345' }, 'phone_invalid'],
    [{ address: 'abc' }, 'address_invalid'],
    [{ state: '' }, 'state_invalid'],
    [{ city: '' }, 'city_invalid'],
  ];
  for (const [override, code] of cases) {
    const res = await checkout(c, { delivery: validDelivery(override) });
    assert.equal(res.status, 422, code);
    assert.equal(res.json.error.code, code);
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
});

test('stock is re-checked at checkout and nothing is created if it ran out', async () => {
  const slow = await signedInClient();
  const fast = await signedInClient();
  await cartWith(slow, [{ productId: 'p-power-bank', quantity: 3 }], 'Yaba');
  await cartWith(fast, [{ productId: 'p-power-bank', quantity: 3 }], 'Yaba');

  assert.equal((await checkout(fast)).status, 201); // takes all 3
  const res = await checkout(slow);
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'out_of_stock');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  // The unsuccessful buyer keeps their cart.
  assert.equal((await slow.request('GET', '/api/cart')).json.itemCount, 3);
});

test('stock is reduced by the quantity ordered', async () => {
  const c = await signedInClient();
  await cartWith(c, [{ productId: 'p-power-bank', quantity: 2 }], 'Yaba');
  await checkout(c);
  assert.equal(app.catalogue.products.find((p) => p.id === 'p-power-bank').stock, 1);
});

test('made-to-order items do not touch stock', async () => {
  const c = await signedInClient();
  await cartWith(c, [wrap(3)]);
  assert.equal((await checkout(c)).status, 201);
  assert.equal(app.catalogue.products.find((p) => p.id === 'p-chicken-wrap').stock, null);
});

test('order lines keep the price paid, even if the catalogue changes later', async () => {
  const c = await signedInClient();
  await cartWith(c, [wrap()]);
  const { order } = (await checkout(c)).json;
  app.catalogue.products.find((p) => p.id === 'p-chicken-wrap').promoPriceKobo = 99999;
  const again = await c.request('GET', `/api/orders/${order.id}`);
  assert.equal(again.json.order.items[0].unitKobo, 150000);
  assert.equal(again.json.order.totalKobo, 230000);
});

test('variant choices are stored on the order', async () => {
  const c = await signedInClient();
  await cartWith(c, [{ productId: 'p-jollof-combo', variantChoice: { portion: 'Large' }, quantity: 1 }]);
  const { order } = (await checkout(c)).json;
  assert.deepEqual(order.items[0].variantChoice, { portion: 'Large' });
  assert.equal(order.items[0].unitKobo, 340000);
});

test('customers see their own orders, newest first', async () => {
  const c = await signedInClient();
  await cartWith(c, [wrap()]);
  const first = (await checkout(c)).json.order;
  await cartWith(c, [{ productId: 'p-jollof-combo', variantChoice: { portion: 'Regular' } }]);
  const second = (await checkout(c)).json.order;
  const list = await c.request('GET', '/api/orders');
  assert.deepEqual(list.json.items.map((o) => o.id), [second.id, first.id]);
});

test("a customer cannot read another customer's order", async () => {
  const alice = await signedInClient();
  const bob = await signedInClient();
  await cartWith(alice, [wrap()]);
  const { order } = (await checkout(alice)).json;

  const peek = await bob.request('GET', `/api/orders/${order.id}`);
  assert.equal(peek.status, 404);
  assert.equal(peek.json.error.code, 'order_not_found');
  assert.equal((await bob.request('GET', '/api/orders')).json.items.length, 0);
  assert.equal((await alice.request('GET', `/api/orders/${order.id}`)).status, 200);
});

test('order endpoints require login', async () => {
  const anon = app.client();
  assert.equal((await anon.request('GET', '/api/orders')).status, 401);
  assert.equal((await anon.request('GET', '/api/orders/ZV-0000000000')).status, 401);
});

test('an idempotency key from one user cannot return another user\'s order', async () => {
  const alice = await signedInClient();
  const bob = await signedInClient();
  await cartWith(alice, [wrap()]);
  const key = newKey();
  const a = await checkout(alice, { idempotencyKey: key });

  await cartWith(bob, [wrap()]);
  const b = await checkout(bob, { idempotencyKey: key });
  assert.equal(b.status, 201);
  assert.notEqual(b.json.order.id, a.json.order.id);
});
