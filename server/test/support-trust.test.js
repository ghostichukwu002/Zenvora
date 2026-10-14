import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { newKey, startApp, validDelivery, validUser } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { createTrust } from '../src/trust.js';
import { categories, merchants, products } from '../src/catalogue.js';
import { createSupport } from '../src/support.js';

const CODES = { 'm-sample-kitchen': 'kitchen-test-claim-code-0001' };

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
  return { c, user: res.json.user };
}

async function adminClient() {
  const { c, user } = await signedIn('admin');
  app.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  return c;
}

async function riderClient() {
  const { c } = await signedIn('rider');
  const applied = await c.request('POST', '/api/rider/apply', { vehicle: 'motorcycle', phone: '08031234567', areas: ['Ikoyi'] });
  assert.equal(applied.status, 201);
  const admin = await adminClient();
  const res = await admin.request('PATCH', `/api/admin/riders/${applied.json.rider.userId}`, { status: 'approved' });
  assert.equal(res.status, 200);
  return { c, userId: applied.json.rider.userId, admin };
}

// A customer places a cash order from the kitchen. Returns the customer client and order id.
async function placeOrder() {
  const { c } = await signedIn('buyer');
  await c.request('POST', '/api/cart/items', { productId: 'p-chicken-wrap', quantity: 1 });
  await c.request('PUT', '/api/cart/delivery-area', { area: 'Ikoyi' });
  const res = await c.request('POST', '/api/orders', {
    idempotencyKey: newKey(),
    paymentMethod: 'cash_on_delivery',
    delivery: validDelivery(),
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { buyer: c, orderId: res.json.order.id };
}

// ----- Customer care -----

test('a signed-out visitor cannot send a support request', async () => {
  const res = await app.client().request('POST', '/api/support', { topic: 'other', message: 'Hello there, help please' });
  assert.equal(res.status, 401);
});

test('a support request needs a known topic and a real message', async () => {
  const { c } = await signedIn('care');
  const badTopic = await c.request('POST', '/api/support', { topic: 'weather', message: 'Hello there, help please' });
  assert.equal(badTopic.status, 422);
  const short = await c.request('POST', '/api/support', { topic: 'other', message: 'help' });
  assert.equal(short.status, 422);
  const long = await c.request('POST', '/api/support', { topic: 'other', message: 'x'.repeat(1001) });
  assert.equal(long.status, 422);
});

test('a customer can send a request and see its status in their list', async () => {
  const { c } = await signedIn('care');
  const res = await c.request('POST', '/api/support', { topic: 'account', message: 'I cannot update my phone number' });
  assert.equal(res.status, 201);
  assert.match(res.json.request.id, /^SR-[0-9A-F]{8}$/);
  assert.equal(res.json.request.status, 'open');
  assert.equal(res.json.request.reply, null);

  const mine = await c.request('GET', '/api/support/mine');
  assert.equal(mine.json.items.length, 1);
  assert.equal(mine.json.items[0].message, 'I cannot update my phone number');
});

test('a customer can only attach their own orders to a request', async () => {
  const { orderId } = await placeOrder();
  const { c: stranger } = await signedIn('stranger');
  const res = await stranger.request('POST', '/api/support', {
    topic: 'order',
    orderId,
    message: 'Where is my food, it has not arrived',
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, 'order_not_yours');
});

test('an order number is accepted in any letter case when it is the customer’s own', async () => {
  const { buyer, orderId } = await placeOrder();
  const res = await buyer.request('POST', '/api/support', {
    topic: 'order',
    orderId: orderId.toLowerCase(),
    message: 'The wrap arrived cold, can I get a refund?',
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.request.orderId, orderId);
});

test('a customer with five open requests must wait for replies before sending more', async () => {
  const { c } = await signedIn('busy');
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await c.request('POST', '/api/support', { topic: 'other', message: `Question number ${i} here` })).status, 201);
  }
  const sixth = await c.request('POST', '/api/support', { topic: 'other', message: 'One more question please' });
  assert.equal(sixth.status, 409);
});

test('administrators see every request and can reply and close it', async () => {
  const { c, user } = await signedIn('asker');
  const sent = await c.request('POST', '/api/support', { topic: 'payment', message: 'My card was charged twice' });
  const requestId = sent.json.request.id;

  const admin = await adminClient();
  const queue = await admin.request('GET', '/api/admin/support?status=open');
  assert.equal(queue.status, 200);
  const item = queue.json.items.find((r) => r.id === requestId);
  assert.ok(item, 'request appears in the open queue');
  assert.equal(item.customer.email, user.email);

  const answered = await admin.request('PATCH', `/api/admin/support/${requestId}`, {
    status: 'answered',
    reply: '  We have reversed the second charge.  ',
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.json.request.status, 'answered');
  assert.equal(answered.json.request.reply, 'We have reversed the second charge.');

  const seen = await c.request('GET', '/api/support/mine');
  assert.equal(seen.json.items[0].reply, 'We have reversed the second charge.');
  assert.ok(seen.json.items[0].repliedAt);

  const closed = await admin.request('PATCH', `/api/admin/support/${requestId}`, { status: 'closed' });
  assert.equal(closed.json.request.status, 'closed');
  assert.equal(closed.json.request.reply, 'We have reversed the second charge.', 'a status change keeps the reply');

  const audit = app.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'support.respond'").get();
  assert.equal(audit.n, 2);
});

test('support replies are rejected for anyone who is not an administrator', async () => {
  const { c } = await signedIn('nosy');
  const sent = await c.request('POST', '/api/support', { topic: 'other', message: 'Please look at my request' });
  const res = await c.request('PATCH', `/api/admin/support/${sent.json.request.id}`, { status: 'closed' });
  assert.equal(res.status, 403);
  assert.equal((await c.request('GET', '/api/admin/support')).status, 403);
});

test('support status must be a known value', async () => {
  const admin = await adminClient();
  const { c } = await signedIn('bad');
  const sent = await c.request('POST', '/api/support', { topic: 'other', message: 'Something is not right here' });
  const res = await admin.request('PATCH', `/api/admin/support/${sent.json.request.id}`, { status: 'deleted' });
  assert.equal(res.status, 422);
});

test('the support service rejects replies longer than 2000 characters', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO users (id, email, password_hash, full_name, role, created_at) VALUES ('u1','a@example.com','x','A','customer','2026-01-01')").run();
  const support = createSupport(db);
  const req = support.create({ id: 'u1' }, { topic: 'other', message: 'A long enough message' });
  assert.throws(() => support.respond('u1', req.id, { status: 'answered', reply: 'x'.repeat(2001) }), /under 2000/);
});

// ----- Verification -----

test('administrators can verify and unverify a store, and the storefront shows it', async () => {
  const admin = await adminClient();
  const before = await app.client().request('GET', '/api/products/p-chicken-wrap');
  assert.equal(before.json.merchant.verified, false);

  const on = await admin.request('PATCH', '/api/admin/stores/m-sample-kitchen', { verified: true });
  assert.equal(on.status, 200);
  assert.equal(on.json.store.verified, true);
  assert.ok(on.json.store.verifiedAt);

  const after = await app.client().request('GET', '/api/products/p-chicken-wrap');
  assert.equal(after.json.merchant.verified, true);

  const off = await admin.request('PATCH', '/api/admin/stores/m-sample-kitchen', { verified: false });
  assert.equal(off.json.store.verified, false);
  assert.equal(off.json.store.verifiedAt, null);
});

test('store verification needs a yes or no and a real store', async () => {
  const admin = await adminClient();
  assert.equal((await admin.request('PATCH', '/api/admin/stores/m-sample-kitchen', { verified: 'yes' })).status, 422);
  assert.equal((await admin.request('PATCH', '/api/admin/stores/m-nowhere', { verified: true })).status, 404);
});

test('store verification is restricted to administrators and listed for them', async () => {
  const { c } = await signedIn('shopper');
  assert.equal((await c.request('PATCH', '/api/admin/stores/m-sample-kitchen', { verified: true })).status, 403);
  const admin = await adminClient();
  const list = await admin.request('GET', '/api/admin/stores');
  assert.equal(list.json.items.length, merchants.length);
});

test('a verified store stays verified after a restart', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO store_verifications (merchant_id, verified_at, verified_by) VALUES ('m-sample-kitchen', '2026-01-01T00:00:00.000Z', 'x')").run();
  const catalogue = structuredClone({ categories, merchants, products });
  createTrust(db, { catalogue });
  assert.equal(catalogue.merchants.find((m) => m.id === 'm-sample-kitchen').verified, true);
  assert.notEqual(catalogue.merchants.find((m) => m.id !== 'm-sample-kitchen').verified, true);
});

// ----- Rider badge on orders -----

test('a customer sees the assigned rider as verified only once the rider is approved', async () => {
  const { buyer, orderId } = await placeOrder();
  const before = await buyer.request('GET', `/api/orders/${orderId}`);
  assert.equal(before.json.order.rider, null, 'no rider before dispatch');

  const rider = await riderClient();
  const staffRes = await (await staffClient()).request('PATCH', `/api/merchant/m-sample-kitchen/orders/${orderId}`, { status: 'accepted' });
  assert.equal(staffRes.status, 200);
  await (await staffClient()).request('PATCH', `/api/merchant/m-sample-kitchen/orders/${orderId}`, { status: 'preparing' });
  await (await staffClient()).request('PATCH', `/api/merchant/m-sample-kitchen/orders/${orderId}`, { status: 'ready' });

  const assigned = await rider.admin.request('POST', `/api/admin/orders/${orderId}/assign`, { riderUserId: rider.userId });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.json));

  const after = await buyer.request('GET', `/api/orders/${orderId}`);
  assert.equal(after.json.order.rider.verified, true);
  assert.equal(after.json.order.rider.vehicle, 'motorcycle');
  assert.ok(after.json.order.rider.firstName);
  assert.equal(after.json.order.rider.phone, undefined, 'the rider phone is not shown to customers');
});

async function staffClient() {
  const { c } = await signedIn('staff');
  const res = await c.request('POST', '/api/merchant/claim', { merchantId: 'm-sample-kitchen', code: CODES['m-sample-kitchen'] });
  assert.equal(res.status, 201);
  return c;
}
