import { test } from 'node:test';
import assert from 'node:assert/strict';
import { departments } from '../src/category-tree.js';
import { startApp, validUser } from './helpers.js';

const leafWithSubs = departments.flatMap((d) => d.categories.map((c) => ({ d, c }))).find(({ c }) => c.subcategories.length > 0);
const leaf = departments.flatMap((d) => d.categories.map((c) => ({ d, c }))).find(({ c }) => c.subcategories.length === 0);

test('category tree has unique ids and a three-level structure', () => {
  assert.equal(departments.length, 10);
  const ids = [];
  for (const d of departments) {
    ids.push(d.id);
    for (const c of d.categories) {
      ids.push(c.id);
      for (const s of c.subcategories) ids.push(s.id);
    }
  }
  assert.equal(new Set(ids).size, ids.length, 'every id is unique');
  assert.ok(leafWithSubs && leaf, 'tree has categories with and without subcategories');
});

test('moderator places a product in the category tree and invalid combinations are refused', async () => {
  const app = await startApp({ moderatorEmails: ['shelf@example.com'] });
  try {
    const staff = app.client();
    assert.equal((await staff.request('POST', '/api/auth/register', validUser({ email: 'shelf@example.com' }))).status, 201);

    const tree = await staff.request('GET', '/api/catalogue/departments');
    assert.equal(tree.status, 200);
    assert.equal(tree.json.departments.length, 10);

    const sub = leafWithSubs.c.subcategories[0];
    const ok = await staff.request('PATCH', '/api/moderator/products/p-chicken-wrap', {
      placement: { departmentId: leafWithSubs.d.id, categoryId: leafWithSubs.c.id, subcategoryId: sub.id },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.product.placement.subcategoryId, sub.id);
    assert.match(ok.json.product.placementLabel, /›/);

    const wrongDept = await staff.request('PATCH', '/api/moderator/products/p-chicken-wrap', {
      placement: { departmentId: leaf.d.id === leafWithSubs.d.id ? departments[0].id : leaf.d.id, categoryId: leafWithSubs.c.id, subcategoryId: sub.id },
    });
    assert.equal(wrongDept.status, 422);
    assert.equal(wrongDept.json.error.code, 'category_invalid');

    const missingSub = await staff.request('PATCH', '/api/moderator/products/p-chicken-wrap', {
      placement: { departmentId: leafWithSubs.d.id, categoryId: leafWithSubs.c.id, subcategoryId: null },
    });
    assert.equal(missingSub.status, 422);
    assert.equal(missingSub.json.error.code, 'subcategory_required');

    const cleared = await staff.request('PATCH', '/api/moderator/products/p-chicken-wrap', { placement: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.product.placement, null);
  } finally {
    await app.close();
  }
});
