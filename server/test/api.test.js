import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { categories, merchants, products } from '../src/catalogue.js';

let server;
let base;

before(async () => {
  server = createServer(createApp({ catalogue: { categories, merchants, products } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Minimal cookie jar: keeps the session cookie from the first response.
function session() {
  let cookie = null;
  return {
    async request(method, path, body) {
      const headers = {};
      if (cookie) headers.Cookie = cookie;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
    },
  };
}

test('health endpoint responds', async () => {
  const res = await session().request('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
});

test('product search matches name and returns only the requested page', async () => {
  const res = await session().request('GET', '/api/products?q=wrap&limit=1');
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 1);
  assert.equal(res.json.items[0].id, 'p-chicken-wrap');
});

test('a broader search returns every match and pages correctly', async () => {
  const all = await session().request('GET', '/api/products?q=rice&limit=50');
  assert.equal(all.json.total, 2);
  const pageTwo = await session().request('GET', '/api/products?q=rice&limit=1&offset=1');
  assert.equal(pageTwo.json.items.length, 1);
  assert.notEqual(pageTwo.json.items[0].id, all.json.items[0].id);
});

test('category filter narrows products', async () => {
  const res = await session().request('GET', '/api/products?category=electronics');
  assert.equal(res.json.total, 2);
  assert.ok(res.json.items.every((p) => p.category.id === 'electronics'));
});

test('price sorting uses the effective (promotional) price', async () => {
  const res = await session().request('GET', '/api/products?sort=price-asc&limit=50');
  const prices = res.json.items.map((p) => p.effectivePriceKobo);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});

test('public product data never exposes exact stock counts', async () => {
  const res = await session().request('GET', '/api/products/p-power-bank');
  assert.equal(res.status, 200);
  assert.equal('stock' in res.json, false);
  assert.equal(res.json.availability, 'low_stock');
});

test('out-of-stock items are reported as unavailable, not hidden', async () => {
  const res = await session().request('GET', '/api/products/p-cooking-oil');
  assert.equal(res.json.availability, 'out_of_stock');
});

test('unknown product returns 404 with a structured error', async () => {
  const res = await session().request('GET', '/api/products/nope');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'product_not_found');
});

test('every API response is marked no-store and nosniff', async () => {
  const res = await session().request('GET', '/api/categories');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('a visitor gets a session cookie that is httpOnly and SameSite=Lax', async () => {
  const res = await fetch(`${base}/api/cart`);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /^zv_sid=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
});

test('add to cart, then read the priced cart back', async () => {
  const s = session();
  const add = await s.request('POST', '/api/cart/items', {
    productId: 'p-jollof-combo',
    variantChoice: { portion: 'Large' },
    quantity: 2,
  });
  assert.equal(add.status, 201);
  assert.equal(add.json.subtotalKobo, 680000);

  const cart = await s.request('GET', '/api/cart');
  assert.equal(cart.json.itemCount, 2);
});

test('carts are isolated between sessions', async () => {
  const alice = session();
  const bob = session();
  await alice.request('POST', '/api/cart/items', { productId: 'p-chicken-wrap' });
  const bobCart = await bob.request('GET', '/api/cart');
  assert.equal(bobCart.json.lines.length, 0);
});

test('a client cannot set its own price: the posted price is ignored', async () => {
  const s = session();
  const add = await s.request('POST', '/api/cart/items', {
    productId: 'p-chicken-wrap',
    priceKobo: 1,
    promoPriceKobo: 1,
    quantity: 1,
  });
  assert.equal(add.json.subtotalKobo, 150000);
});

test('cart update, delivery area and removal work through the API', async () => {
  const s = session();
  const add = await s.request('POST', '/api/cart/items', { productId: 'p-chicken-wrap' });
  const key = add.json.lines[0].key;

  const updated = await s.request('PATCH', `/api/cart/items/${encodeURIComponent(key)}`, { quantity: 3 });
  assert.equal(updated.json.itemCount, 3);

  const area = await s.request('PUT', '/api/cart/delivery-area', { area: 'Ikoyi' });
  assert.equal(area.json.deliveryFeeKobo, 80000);

  const removed = await s.request('DELETE', `/api/cart/items/${encodeURIComponent(key)}`);
  assert.equal(removed.json.lines.length, 0);
  assert.equal(removed.json.deliveryArea, null);
});

test('a delivery area the merchant does not serve is refused', async () => {
  const s = session();
  await s.request('POST', '/api/cart/items', { productId: 'p-chicken-wrap' });
  const res = await s.request('PUT', '/api/cart/delivery-area', { area: 'Maitama' });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, 'area_not_served');
});

test('a second merchant is refused with a clear conflict message', async () => {
  const s = session();
  await s.request('POST', '/api/cart/items', { productId: 'p-chicken-wrap' });
  const res = await s.request('POST', '/api/cart/items', {
    productId: 'p-earbuds',
    variantChoice: { colour: 'White' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'merchant_conflict');
});

test('clearing the cart empties it', async () => {
  const s = session();
  await s.request('POST', '/api/cart/items', { productId: 'p-chicken-wrap' });
  const res = await s.request('DELETE', '/api/cart');
  assert.equal(res.json.itemCount, 0);
});

test('malformed JSON is a 400 with a readable message', async () => {
  const res = await fetch(`${base}/api/cart/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error.code, 'bad_request');
});

test('a JSON array body is rejected', async () => {
  const res = await session().request('POST', '/api/cart/items', []);
  assert.equal(res.status, 400);
});

test('an oversized body is rejected with 413', async () => {
  const res = await session().request('POST', '/api/cart/items', { productId: 'x'.repeat(20000) });
  assert.equal(res.status, 413);
  assert.equal(res.json.error.code, 'body_too_large');
});

test('unknown endpoints return 404 JSON', async () => {
  const res = await session().request('GET', '/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'not_found');
});

test('wrong method on a known path returns 405', async () => {
  const res = await session().request('POST', '/api/categories');
  assert.equal(res.status, 405);
});

test('areas endpoint lists every delivery area once, sorted', async () => {
  const res = await session().request('GET', '/api/areas');
  const names = res.json.items.map((a) => a.name);
  assert.deepEqual(names, [...new Set(names)].sort((a, b) => a.localeCompare(b)));
  assert.ok(names.includes('Ikoyi'));
  assert.ok(names.includes('Maitama'));
});

test('area filter only returns products from merchants that deliver there', async () => {
  const res = await session().request('GET', '/api/products?area=Maitama&limit=50');
  assert.ok(res.json.items.length > 0);
  assert.ok(res.json.items.every((p) => p.merchant.serviceAreas.includes('Maitama')));
});

test('promo filter returns only products with a promotional price', async () => {
  const res = await session().request('GET', '/api/products?promo=1&limit=50');
  assert.ok(res.json.items.length > 0);
  assert.ok(res.json.items.every((p) => p.promoPriceKobo !== null));
});

test('non-API paths are not served when no web root is configured', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 404);
});
