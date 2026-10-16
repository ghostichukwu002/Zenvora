import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { categories, merchants, products } from '../src/catalogue.js';
import { startApp, validUser } from './helpers.js';

test('moderator can edit catalogue values and edits survive app restart', async () => {
  const app = await startApp({ moderatorEmails: ['catalogue@example.com'] });
  try {
    const staff = app.client();
    const registered = await staff.request('POST', '/api/auth/register', validUser({ email: 'catalogue@example.com' }));
    assert.equal(registered.status, 201);
    assert.equal(registered.json.user.role, 'moderator');

    const updated = await staff.request('PATCH', '/api/moderator/products/p-chicken-wrap', {
      name: 'Updated Chicken Wrap',
      description: 'Freshly updated product details.',
      priceKobo: 450000,
      promoPriceKobo: 400000,
      stock: 24,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.product.name, 'Updated Chicken Wrap');
    assert.equal(app.catalogue.products.find((p) => p.id === 'p-chicken-wrap').stock, 24);

    const dbRow = app.db.prepare('SELECT name, stock, price_kobo, promo_price_kobo FROM product_overrides WHERE product_id = ?')
      .get('p-chicken-wrap');
    assert.deepEqual(dbRow, {
      name: 'Updated Chicken Wrap',
      stock: 24,
      price_kobo: 450000,
      promo_price_kobo: 400000,
    });

    const restartedCatalogue = structuredClone({ categories, merchants, products });
    const restartedServer = createServer(createApp({ catalogue: restartedCatalogue, db: app.db }));
    await new Promise((resolve) => restartedServer.listen(0, '127.0.0.1', resolve));
    try {
      assert.equal(restartedCatalogue.products.find((p) => p.id === 'p-chicken-wrap').name, 'Updated Chicken Wrap');
      assert.equal(restartedCatalogue.products.find((p) => p.id === 'p-chicken-wrap').priceKobo, 450000);
    } finally {
      await new Promise((resolve) => restartedServer.close(resolve));
    }
  } finally {
    await app.close();
  }
});

test('ordinary customers cannot access moderator catalogue endpoints', async () => {
  const app = await startApp();
  try {
    const customer = app.client();
    const registered = await customer.request('POST', '/api/auth/register', validUser());
    assert.equal(registered.status, 201);
    assert.equal(registered.json.user.role, 'customer');

    const list = await customer.request('GET', '/api/moderator/products');
    assert.equal(list.status, 403);
    const edit = await customer.request('PATCH', '/api/moderator/products/p-chicken-wrap', { priceKobo: 1 });
    assert.equal(edit.status, 403);
  } finally {
    await app.close();
  }
});
