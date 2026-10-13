import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addItem,
  CartError,
  emptyCart,
  lineKey,
  priceCart,
  removeItem,
  setDeliveryArea,
  unitPriceKobo,
  updateQuantity,
} from '../src/cart.js';
import { categories, merchants, products } from '../src/catalogue.js';

const catalogue = { categories, merchants, products };
const byId = (id) => products.find((p) => p.id === id);

async function expectCartError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CartError, `expected CartError, got ${err}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected CartError with code "${code}"`);
}

test('lineKey is stable regardless of variant key order', () => {
  assert.equal(lineKey('p', { b: '2', a: '1' }), lineKey('p', { a: '1', b: '2' }));
});

test('unit price uses the promotional price when one exists', () => {
  assert.equal(unitPriceKobo(byId('p-chicken-wrap'), {}), 150000);
  assert.equal(unitPriceKobo(byId('p-rice-5kg'), {}), 890000);
});

test('variant price deltas are added to the base price', () => {
  // Jollof base 2,600.00 naira; "Large" adds 800.00 naira.
  assert.equal(unitPriceKobo(byId('p-jollof-combo'), { portion: 'Regular' }), 260000);
  assert.equal(unitPriceKobo(byId('p-jollof-combo'), { portion: 'Large' }), 340000);
});

test('a required variant must be chosen', () => {
  assert.throws(() => unitPriceKobo(byId('p-jollof-combo'), {}), { code: 'variant_required' });
});

test('an unoffered variant option is rejected', () => {
  assert.throws(() => unitPriceKobo(byId('p-jollof-combo'), { portion: 'Family' }), {
    code: 'variant_invalid',
  });
});

test('a variant the product does not have is rejected', () => {
  assert.throws(() => unitPriceKobo(byId('p-rice-5kg'), { size: 'XL' }), {
    code: 'variant_unknown',
  });
});

test('adding the same line twice increases its quantity instead of duplicating it', () => {
  let cart = addItem(emptyCart(), { productId: 'p-chicken-wrap', quantity: 1 }, catalogue);
  cart = addItem(cart, { productId: 'p-chicken-wrap', quantity: 2 }, catalogue);
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].quantity, 3);
});

test('different variant choices are separate cart lines', () => {
  let cart = addItem(emptyCart(), { productId: 'p-jollof-combo', variantChoice: { portion: 'Regular' } }, catalogue);
  cart = addItem(cart, { productId: 'p-jollof-combo', variantChoice: { portion: 'Large' } }, catalogue);
  assert.equal(cart.items.length, 2);
});

test('out-of-stock products cannot be added', () => {
  assert.throws(
    () => addItem(emptyCart(), { productId: 'p-cooking-oil', quantity: 1 }, catalogue),
    { code: 'out_of_stock', status: 409 },
  );
});

test('quantity cannot exceed available stock', () => {
  // Power bank has 3 in stock.
  assert.throws(
    () => addItem(emptyCart(), { productId: 'p-power-bank', quantity: 4 }, catalogue),
    { code: 'insufficient_stock', status: 409 },
  );
  const cart = addItem(emptyCart(), { productId: 'p-power-bank', quantity: 3 }, catalogue);
  assert.equal(cart.items[0].quantity, 3);
});

test('stock is checked against the combined quantity of repeated adds', () => {
  let cart = addItem(emptyCart(), { productId: 'p-power-bank', quantity: 2 }, catalogue);
  assert.throws(() => addItem(cart, { productId: 'p-power-bank', quantity: 2 }, catalogue), {
    code: 'insufficient_stock',
  });
});

test('quantities must be whole numbers from 1 to the per-line maximum', () => {
  for (const quantity of [0, -1, 21, 1.5, '2', null]) {
    assert.throws(
      () => addItem(emptyCart(), { productId: 'p-chicken-wrap', quantity }, catalogue),
      { code: 'quantity_invalid' },
      `quantity ${JSON.stringify(quantity)} should be rejected`,
    );
  }
});

test('a cart holds items from one merchant only', () => {
  const cart = addItem(emptyCart(), { productId: 'p-chicken-wrap' }, catalogue);
  assert.throws(() => addItem(cart, { productId: 'p-earbuds', variantChoice: { colour: 'Black' } }, catalogue), {
    code: 'merchant_conflict',
    status: 409,
  });
});

test('unknown products are rejected', () => {
  assert.throws(() => addItem(emptyCart(), { productId: 'p-does-not-exist' }, catalogue), {
    code: 'product_not_found',
    status: 404,
  });
});

test('delivery area must be one the merchant serves', () => {
  const cart = addItem(emptyCart(), { productId: 'p-chicken-wrap' }, catalogue);
  assert.throws(() => setDeliveryArea(cart, 'Wuse', catalogue), { code: 'area_not_served', status: 422 });
  const ok = setDeliveryArea(cart, 'Ikoyi', catalogue);
  assert.equal(ok.deliveryArea, 'Ikoyi');
});

test('delivery fee is charged only once a served delivery area is chosen', () => {
  let cart = addItem(emptyCart(), { productId: 'p-chicken-wrap' }, catalogue);
  let priced = priceCart(cart, catalogue);
  assert.equal(priced.deliveryFeeKobo, 0);
  assert.equal(priced.deliveryAreaRequired, true);

  cart = setDeliveryArea(cart, 'Lagos Island', catalogue);
  priced = priceCart(cart, catalogue);
  assert.equal(priced.deliveryFeeKobo, 80000);
  assert.equal(priced.deliveryAreaRequired, false);
  assert.equal(priced.totalKobo, priced.subtotalKobo + 80000);
});

test('totals are computed on the server from catalogue prices', () => {
  let cart = emptyCart();
  cart = addItem(cart, { productId: 'p-jollof-combo', variantChoice: { portion: 'Large' }, quantity: 2 }, catalogue);
  cart = addItem(cart, { productId: 'p-chicken-wrap', quantity: 1 }, catalogue);
  cart = setDeliveryArea(cart, 'Ikoyi', catalogue);
  const priced = priceCart(cart, catalogue);

  assert.equal(priced.subtotalKobo, 340000 * 2 + 150000);
  assert.equal(priced.itemCount, 3);
  assert.equal(priced.totalKobo, priced.subtotalKobo + priced.deliveryFeeKobo);
  assert.ok(Number.isInteger(priced.totalKobo), 'totals are whole kobo');
});

test('a promotional line is flagged so the UI can show the saving', () => {
  const cart = addItem(emptyCart(), { productId: 'p-chicken-wrap' }, catalogue);
  assert.equal(priceCart(cart, catalogue).lines[0].onPromotion, true);
});

test('changing quantity to zero removes the line', () => {
  let cart = addItem(emptyCart(), { productId: 'p-chicken-wrap', quantity: 2 }, catalogue);
  const key = cart.items[0].key;
  cart = updateQuantity(cart, key, 0, catalogue);
  assert.equal(cart.items.length, 0);
});

test('updated quantities are re-checked against stock', () => {
  let cart = addItem(emptyCart(), { productId: 'p-power-bank', quantity: 1 }, catalogue);
  const key = cart.items[0].key;
  assert.throws(() => updateQuantity(cart, key, 5, catalogue), { code: 'insufficient_stock' });
});

test('removing the last item resets the merchant and delivery area', () => {
  let cart = addItem(emptyCart(), { productId: 'p-chicken-wrap' }, catalogue);
  cart = setDeliveryArea(cart, 'Ikoyi', catalogue);
  cart = removeItem(cart, cart.items[0].key);
  assert.equal(cart.merchantId, null);
  assert.equal(cart.deliveryArea, null);
});

test('removing an unknown line reports not found', () => {
  assert.throws(() => removeItem(emptyCart(), 'nope'), { code: 'line_not_found' });
});

test('CartError carries a status and code for the API layer', () => {
  const err = new CartError('x', 'msg', 418);
  assert.equal(err.status, 418);
  assert.equal(err.code, 'x');
});
