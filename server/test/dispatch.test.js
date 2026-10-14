import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { newKey, startApp, validDelivery, validUser } from './helpers.js';

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

// An administrator is an ordinary account whose role was granted on the server (see scripts/grant-role.js).
async function adminClient() {
  const { c, user } = await signedIn('admin');
  app.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  return c;
}

async function riderClient(areas = ['Ikoyi'], { approve = true } = {}) {
  const { c } = await signedIn('rider');
  const applied = await c.request('POST', '/api/rider/apply', { vehicle: 'motorcycle', phone: '08031234567', areas });
  assert.equal(applied.status, 201, JSON.stringify(applied.json));
  if (approve) {
    const admin = await adminClient();
    const res = await admin.request('PATCH', `/api/admin/riders/${applied.json.rider.userId}`, { status: 'approved' });
    assert.equal(res.status, 200, JSON.stringify(res.json));
  }
  return { c, userId: applied.json.rider.userId };
}

async function kitchenStaff() {
  const { c } = await signedIn('staff');
  const res = await c.request('POST', '/api/merchant/claim', { merchantId: 'm-sample-kitchen', code: CODES['m-sample-kitchen'] });
  assert.equal(res.status, 201);
  return c;
}

// A customer orders from the kitchen. Returns the order id.
async function placeOrder(area = 'Ikoyi') {
  const { c } = await signedIn('buyer');
  await c.request('POST', '/api/cart/items', { productId: 'p-chicken-wrap', quantity: 1 });
  await c.request('PUT', '/api/cart/delivery-area', { area });
  const res = await c.request('POST', '/api/orders', {
    idempotencyKey: newKey(),
    paymentMethod: 'cash_on_delivery',
    delivery: validDelivery(),
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { buyer: c, orderId: res.json.order.id };
}

// Moves a placed order to ready for pickup, the way the kitchen does.
async function readyOrder(staff, orderId) {
  for (const status of ['accepted', 'preparing', 'ready']) {
    const res = await staff.request('PATCH', `/api/merchant/m-sample-kitchen/orders/${orderId}`, { status });
    assert.equal(res.status, 200, JSON.stringify(res.json));
  }
}

const dispatchOrder = (admin, orderId, riderUserId) =>
  admin.request('POST', `/api/admin/orders/${orderId}/assign`, { riderUserId });

// ----- Riders -----

test('applying as a rider needs a valid vehicle, phone and covered areas', async () => {
  const { c } = await signedIn('applicant');
  const bad = [
    { vehicle: 'tricycle', phone: '08031234567', areas: ['Ikoyi'] },
    { vehicle: 'car', phone: '12345', areas: ['Ikoyi'] },
    { vehicle: 'car', phone: '08031234567', areas: [] },
    { vehicle: 'car', phone: '08031234567', areas: ['Mars Colony'] },
  ];
  for (const body of bad) {
    const res = await c.request('POST', '/api/rider/apply', body);
    assert.equal(res.status, 422, JSON.stringify(body));
  }
});

test('a rider application starts pending, and only once', async () => {
  const { c } = await signedIn('applicant');
  const res = await c.request('POST', '/api/rider/apply', { vehicle: 'bicycle', phone: '08031234567', areas: ['Ikoyi', 'Yaba'] });
  assert.equal(res.status, 201);
  assert.equal(res.json.rider.status, 'pending');
  assert.equal(res.json.rider.available, false);

  const again = await c.request('POST', '/api/rider/apply', { vehicle: 'car', phone: '08031234567', areas: ['Ikoyi'] });
  assert.equal(again.status, 409);
});

test('an unapproved rider cannot go online or see jobs', async () => {
  const { c } = await riderClient(['Ikoyi'], { approve: false });
  assert.equal((await c.request('PATCH', '/api/rider/me', { available: true })).status, 403);
  assert.equal((await c.request('GET', '/api/rider/jobs')).status, 403);
});

test('an approved rider can go online and offline', async () => {
  const { c } = await riderClient();
  const on = await c.request('PATCH', '/api/rider/me', { available: true });
  assert.equal(on.status, 200);
  assert.equal(on.json.rider.available, true);
  const off = await c.request('PATCH', '/api/rider/me', { available: false });
  assert.equal(off.json.rider.available, false);
});

// ----- Administration -----

test('administration is refused to customers and to anonymous visitors', async () => {
  const { c } = await signedIn('plain');
  assert.equal((await c.request('GET', '/api/admin/overview')).status, 403);
  assert.equal((await app.client().request('GET', '/api/admin/riders')).status, 401);
  assert.equal((await c.request('GET', '/api/admin/audit')).status, 403);
});

test('an administrator can approve, suspend and review riders with a note', async () => {
  const { c, userId } = await riderClient(['Ikoyi'], { approve: false });
  const admin = await adminClient();
  const approved = await admin.request('PATCH', `/api/admin/riders/${userId}`, { status: 'approved', adminNote: 'Checked licence' });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.rider.status, 'approved');
  assert.equal(approved.json.rider.adminNote, 'Checked licence');

  const bad = await admin.request('PATCH', `/api/admin/riders/${userId}`, { status: 'vip' });
  assert.equal(bad.status, 422);

  const suspended = await admin.request('PATCH', `/api/admin/riders/${userId}`, { status: 'suspended' });
  assert.equal(suspended.json.rider.status, 'suspended');
  assert.equal((await c.request('GET', '/api/rider/jobs')).status, 403);
});

test('riders cannot see the admin note about themselves', async () => {
  const { c, userId } = await riderClient(['Ikoyi'], { approve: false });
  const admin = await adminClient();
  await admin.request('PATCH', `/api/admin/riders/${userId}`, { status: 'approved', adminNote: 'private note' });
  const me = await c.request('GET', '/api/rider/me');
  assert.equal(me.json.rider.status, 'approved');
  assert.equal('adminNote' in me.json.rider, false);
});

// ----- Dispatch -----

test('only orders that are ready can be assigned, and only to a rider who covers the area', async () => {
  const { orderId } = await placeOrder('Ikoyi');
  const admin = await adminClient();
  const { userId: yabaRider } = await riderClient(['Yaba']);
  const { userId: ikoyiRider } = await riderClient(['Ikoyi']);

  const notReady = await dispatchOrder(admin, orderId, ikoyiRider);
  assert.equal(notReady.status, 409);

  const staff = await kitchenStaff();
  await readyOrder(staff, orderId);

  const outside = await dispatchOrder(admin, orderId, yabaRider);
  assert.equal(outside.status, 409);
  assert.equal(outside.json.error.code, 'outside_rider_area');

  const ok = await dispatchOrder(admin, orderId, ikoyiRider);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

test('an unapproved or unknown rider cannot be assigned', async () => {
  const { orderId } = await placeOrder('Ikoyi');
  await readyOrder(await kitchenStaff(), orderId);
  const admin = await adminClient();
  const { userId: pending } = await riderClient(['Ikoyi'], { approve: false });
  assert.equal((await dispatchOrder(admin, orderId, pending)).status, 409);
  assert.equal((await dispatchOrder(admin, orderId, 'no-such-user')).status, 404);
});

test('a full delivery: assign, pick up, deliver with proof and cash', async () => {
  const { buyer, orderId } = await placeOrder('Ikoyi');
  const staff = await kitchenStaff();
  await readyOrder(staff, orderId);
  const admin = await adminClient();
  const { c: rider, userId } = await riderClient(['Ikoyi']);
  await dispatchOrder(admin, orderId, userId);

  const jobs = await rider.request('GET', '/api/rider/jobs');
  assert.equal(jobs.json.active.length, 1);
  assert.equal(jobs.json.active[0].deliveryStatus, 'assigned');
  assert.ok(jobs.json.active[0].cashToCollectKobo > 0);
  assert.equal(jobs.json.active[0].dropoff.phone, '+2348031234567');

  // Pickup moves the order onto the road.
  const picked = await rider.request('POST', `/api/rider/jobs/${orderId}/pickup`, {});
  assert.equal(picked.status, 200, JSON.stringify(picked.json));
  const onRoad = await buyer.request('GET', `/api/orders/${orderId}`);
  assert.equal(onRoad.json.order.status, 'out_for_delivery');

  // Delivery needs cash confirmed and proof.
  const noCash = await rider.request('POST', `/api/rider/jobs/${orderId}/complete`, { cashCollected: false, proofNote: 'Received by Ada' });
  assert.equal(noCash.status, 422);
  const noProof = await rider.request('POST', `/api/rider/jobs/${orderId}/complete`, { cashCollected: true, proofNote: '' });
  assert.equal(noProof.status, 422);

  const done = await rider.request('POST', `/api/rider/jobs/${orderId}/complete`, { cashCollected: true, proofNote: 'Received by Ada at the gate' });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.job.deliveryStatus, 'delivered');
  assert.equal(done.json.job.cashToCollectKobo, 0);

  const final = await buyer.request('GET', `/api/orders/${orderId}`);
  assert.equal(final.json.order.status, 'delivered');
  assert.equal(final.json.order.paymentStatus, 'cod_collected');

  // Completing twice is refused, not applied again.
  const again = await rider.request('POST', `/api/rider/jobs/${orderId}/complete`, { cashCollected: true, proofNote: 'Again' });
  assert.equal(again.status, 409);

  const history = await rider.request('GET', '/api/rider/jobs');
  assert.equal(history.json.active.length, 0);
  assert.equal(history.json.history[0].proofNote, 'Received by Ada at the gate');
});

test('only the assigned rider can act on a delivery', async () => {
  const { orderId } = await placeOrder('Ikoyi');
  await readyOrder(await kitchenStaff(), orderId);
  const admin = await adminClient();
  const { userId } = await riderClient(['Ikoyi']);
  const { c: other } = await riderClient(['Ikoyi']);
  await dispatchOrder(admin, orderId, userId);

  assert.equal((await other.request('POST', `/api/rider/jobs/${orderId}/pickup`, {})).status, 404);
  assert.equal((await other.request('POST', `/api/rider/jobs/${orderId}/decline`, {})).status, 404);
});

test('a rider can decline before pickup, and the order returns to the queue', async () => {
  const { orderId } = await placeOrder('Ikoyi');
  await readyOrder(await kitchenStaff(), orderId);
  const admin = await adminClient();
  const { c: rider, userId } = await riderClient(['Ikoyi']);
  await dispatchOrder(admin, orderId, userId);

  const declined = await rider.request('POST', `/api/rider/jobs/${orderId}/decline`, {});
  assert.equal(declined.status, 200);
  const queue = await admin.request('GET', '/api/admin/orders');
  const item = queue.json.items.find((o) => o.id === orderId);
  assert.equal(item.status, 'ready');
  assert.equal(item.dispatch.state, 'unassigned');

  // Once picked up, it can no longer be declined.
  await dispatchOrder(admin, orderId, userId);
  await rider.request('POST', `/api/rider/jobs/${orderId}/pickup`, {});
  assert.equal((await rider.request('POST', `/api/rider/jobs/${orderId}/decline`, {})).status, 409);
});

test('a failed delivery can be reassigned to another rider and completed', async () => {
  const { buyer, orderId } = await placeOrder('Ikoyi');
  await readyOrder(await kitchenStaff(), orderId);
  const admin = await adminClient();
  const { c: first, userId: firstId } = await riderClient(['Ikoyi']);
  const { c: second, userId: secondId } = await riderClient(['Ikoyi']);

  await dispatchOrder(admin, orderId, firstId);
  await first.request('POST', `/api/rider/jobs/${orderId}/pickup`, {});
  const failed = await first.request('POST', `/api/rider/jobs/${orderId}/fail`, { reason: 'Customer not reachable' });
  assert.equal(failed.status, 200, JSON.stringify(failed.json));
  assert.equal((await buyer.request('GET', `/api/orders/${orderId}`)).json.order.status, 'delivery_failed');

  const reassigned = await dispatchOrder(admin, orderId, secondId);
  assert.equal(reassigned.status, 200, JSON.stringify(reassigned.json));
  assert.equal(reassigned.json.order.status, 'ready');

  await second.request('POST', `/api/rider/jobs/${orderId}/pickup`, {});
  const done = await second.request('POST', `/api/rider/jobs/${orderId}/complete`, { cashCollected: true, proofNote: 'Left with the guard' });
  assert.equal(done.status, 200);
  assert.equal((await buyer.request('GET', `/api/orders/${orderId}`)).json.order.status, 'delivered');
});

test('the rider list shows applicants first, with their status and areas', async () => {
  const { userId } = await riderClient(['Ikoyi'], { approve: false });
  await riderClient(['Yaba']);
  const admin = await adminClient();
  const res = await admin.request('GET', '/api/admin/riders');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.items[0].status, 'pending');
  assert.ok(res.json.items.some((r) => r.userId === userId && r.areas.includes('Ikoyi')));
  assert.equal(res.json.items.find((r) => r.userId === userId).activeCount, 0);
});

test('suspending a rider returns their unpicked jobs to the queue', async () => {
  const { orderId } = await placeOrder('Ikoyi');
  await readyOrder(await kitchenStaff(), orderId);
  const admin = await adminClient();
  const { userId } = await riderClient(['Ikoyi']);
  await dispatchOrder(admin, orderId, userId);

  await admin.request('PATCH', `/api/admin/riders/${userId}`, { status: 'suspended' });
  const queue = await admin.request('GET', '/api/admin/orders');
  assert.equal(queue.json.items.find((o) => o.id === orderId).dispatch.state, 'unassigned');
});

test('merchants cannot mark an order delivered, even with a rider assigned', async () => {
  const { orderId } = await placeOrder('Ikoyi');
  const staff = await kitchenStaff();
  await readyOrder(staff, orderId);
  const res = await staff.request('PATCH', `/api/merchant/m-sample-kitchen/orders/${orderId}`, { status: 'delivered' });
  assert.equal(res.status, 409);
});

test('the overview and audit log reflect what happened', async () => {
  const { orderId } = await placeOrder('Ikoyi');
  await readyOrder(await kitchenStaff(), orderId);
  const admin = await adminClient();
  const { userId } = await riderClient(['Ikoyi']);
  await dispatchOrder(admin, orderId, userId);

  const overview = await admin.request('GET', '/api/admin/overview');
  assert.equal(overview.json.readyForPickup, 1);
  assert.equal(overview.json.unassigned, 0);

  const audit = await admin.request('GET', '/api/admin/audit');
  const actions = audit.json.items.map((i) => i.action);
  assert.ok(actions.includes('delivery.assigned'));
  assert.ok(actions.includes('rider.review'));
  assert.ok(actions.includes('rider.apply'));
  const assigned = audit.json.items.find((i) => i.action === 'delivery.assigned');
  assert.equal(assigned.target, orderId);
  assert.equal(assigned.actor.email, (await admin.request('GET', '/api/auth/me')).json.user.email);
});
