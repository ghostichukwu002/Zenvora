// Cart rules. Pure functions only: no I/O, so they are easy to test.
// The server is the source of truth for prices, stock, and delivery fees.
// The browser may display totals, but it never decides them.
//
// Initial-release constraint: a cart can contain items from ONE merchant.
// Multi-merchant checkout (separate merchant orders under one session) is a
// later slice. Mixing merchants is rejected explicitly rather than merged silently.

export const MAX_QUANTITY_PER_LINE = 20;

export class CartError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CartError';
    this.code = code;
    this.status = status;
  }
}

export function emptyCart() {
  return { items: [], merchantId: null, deliveryArea: null };
}

// A line is identified by product plus the chosen variant options,
// so "Jollof Regular" and "Jollof Large" are separate lines.
export function lineKey(productId, variantChoice) {
  const parts = Object.keys(variantChoice)
    .sort()
    .map((k) => `${k}=${variantChoice[k]}`);
  return [productId, ...parts].join('|');
}

// Resolves a product's unit price in kobo for the chosen variants.
// Throws CartError if a variant choice is missing or not offered.
export function unitPriceKobo(product, variantChoice) {
  const base = product.promoPriceKobo ?? product.priceKobo;
  let delta = 0;
  for (const variant of product.variants) {
    const chosen = variantChoice[variant.id];
    if (chosen === undefined) {
      throw new CartError('variant_required', `Choose a ${variant.label.toLowerCase()}.`);
    }
    const index = variant.options.indexOf(chosen);
    if (index === -1) {
      throw new CartError('variant_invalid', `"${chosen}" is not an option for ${variant.label.toLowerCase()}.`);
    }
    delta += variant.priceDeltaKobo[index];
  }
  // Reject choices for variants the product does not have.
  for (const key of Object.keys(variantChoice)) {
    if (!product.variants.some((v) => v.id === key)) {
      throw new CartError('variant_unknown', `This product has no "${key}" option.`);
    }
  }
  return base + delta;
}

function assertQuantity(quantity) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_LINE) {
    throw new CartError(
      'quantity_invalid',
      `Quantity must be a whole number from 1 to ${MAX_QUANTITY_PER_LINE}.`,
    );
  }
}

// Checks that the requested quantity fits current stock.
// stock === null means made-to-order (not stock-tracked).
function assertInStock(product, quantity) {
  if (product.stock === null) return;
  if (product.stock === 0) {
    throw new CartError('out_of_stock', `${product.name} is currently unavailable.`, 409);
  }
  if (quantity > product.stock) {
    throw new CartError(
      'insufficient_stock',
      `Only ${product.stock} of ${product.name} left.`,
      409,
    );
  }
}

// Confirms the chosen delivery area is one the merchant actually serves.
export function assertDeliverable(merchant, deliveryArea) {
  if (!deliveryArea) {
    throw new CartError('area_required', 'Choose a delivery area.');
  }
  if (!merchant.serviceAreas.includes(deliveryArea)) {
    throw new CartError(
      'area_not_served',
      `${merchant.name} does not deliver to ${deliveryArea}.`,
      422,
    );
  }
}

export function addItem(cart, { productId, variantChoice = {}, quantity = 1 }, catalogue) {
  assertQuantity(quantity);
  const product = catalogue.products.find((p) => p.id === productId);
  if (!product) {
    throw new CartError('product_not_found', 'That product is no longer available.', 404);
  }
  if (cart.merchantId && cart.merchantId !== product.merchantId) {
    throw new CartError(
      'merchant_conflict',
      'Your cart has items from another store. Clear the cart to start a new order.',
      409,
    );
  }

  const key = lineKey(productId, variantChoice);
  const existing = cart.items.find((i) => i.key === key);
  const nextQuantity = (existing?.quantity ?? 0) + quantity;
  if (nextQuantity > MAX_QUANTITY_PER_LINE) {
    throw new CartError('quantity_invalid', `You can add up to ${MAX_QUANTITY_PER_LINE} of one item.`);
  }
  unitPriceKobo(product, variantChoice); // validates variant choices
  assertInStock(product, nextQuantity);

  const items = existing
    ? cart.items.map((i) => (i.key === key ? { ...i, quantity: nextQuantity } : i))
    : [...cart.items, { key, productId, variantChoice, quantity }];

  return { ...cart, items, merchantId: product.merchantId };
}

export function updateQuantity(cart, key, quantity, catalogue) {
  if (quantity === 0) return removeItem(cart, key);
  assertQuantity(quantity);
  const line = cart.items.find((i) => i.key === key);
  if (!line) throw new CartError('line_not_found', 'That item is not in your cart.', 404);
  const product = catalogue.products.find((p) => p.id === line.productId);
  assertInStock(product, quantity);
  return {
    ...cart,
    items: cart.items.map((i) => (i.key === key ? { ...i, quantity } : i)),
  };
}

export function removeItem(cart, key) {
  const items = cart.items.filter((i) => i.key !== key);
  if (items.length === cart.items.length) {
    throw new CartError('line_not_found', 'That item is not in your cart.', 404);
  }
  // An emptied cart forgets its merchant and delivery area, so the next order starts clean.
  return {
    ...cart,
    items,
    merchantId: items.length ? cart.merchantId : null,
    deliveryArea: items.length ? cart.deliveryArea : null,
  };
}

export function setDeliveryArea(cart, deliveryArea, catalogue) {
  if (cart.merchantId) {
    const merchant = catalogue.merchants.find((m) => m.id === cart.merchantId);
    assertDeliverable(merchant, deliveryArea);
  }
  return { ...cart, deliveryArea };
}

// Builds the priced cart the customer sees. Every number comes from the catalogue here.
export function priceCart(cart, catalogue) {
  const lines = cart.items.map((item) => {
    const product = catalogue.products.find((p) => p.id === item.productId);
    const unitKobo = unitPriceKobo(product, item.variantChoice);
    return {
      key: item.key,
      productId: product.id,
      section: catalogue.merchants.find((m) => m.id === product.merchantId)?.section ?? 'shop',
      name: product.name,
      variantChoice: item.variantChoice,
      quantity: item.quantity,
      unitKobo,
      lineKobo: unitKobo * item.quantity,
      onPromotion: product.promoPriceKobo !== null,
      stockWarning: product.stock !== null && item.quantity > product.stock,
    };
  });

  const subtotalKobo = lines.reduce((sum, l) => sum + l.lineKobo, 0);
  const merchant = cart.merchantId
    ? catalogue.merchants.find((m) => m.id === cart.merchantId)
    : null;
  const deliveryFeeKobo = merchant && cart.deliveryArea ? merchant.deliveryFeeKobo : 0;
  const section = merchant?.section ?? 'shop';

  return {
    section,
    merchantId: cart.merchantId,
    merchantName: merchant?.name ?? null,
    merchantServiceAreas: merchant?.serviceAreas ?? [],
    deliveryArea: cart.deliveryArea,
    lines,
    itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    subtotalKobo,
    deliveryFeeKobo,
    totalKobo: subtotalKobo + deliveryFeeKobo,
    deliveryAreaRequired: merchant !== null && !cart.deliveryArea,
  };
}
