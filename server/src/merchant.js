// Merchant access. A store's staff account can act only for stores it has been granted.
//
// Granting works by a claim code per store, set by you in the server environment
// (ZENVORA_MERCHANT_CLAIM_CODES). That stands in for admin approval until the admin panel exists.
// Codes are compared as hashes in constant time, and are never stored or returned.

import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from './router.js';

function sameSecret(given, expected) {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function createMerchantAccess(db, { claimCodes = {}, now = () => new Date() } = {}) {
  function isMember(userId, merchantId) {
    return Boolean(
      db.prepare('SELECT 1 FROM merchant_members WHERE user_id = ? AND merchant_id = ?').get(userId, merchantId),
    );
  }

  return {
    memberships(userId) {
      return db
        .prepare('SELECT merchant_id AS id FROM merchant_members WHERE user_id = ? ORDER BY created_at')
        .all(userId);
    },

    // Unknown store and not-a-member both answer "not found", so store ids cannot be probed.
    requireMember(userId, merchantId) {
      if (!isMember(userId, merchantId)) throw new HttpError(404, 'not_found', 'Not found.');
    },

    claim(userId, merchantId, code) {
      const expected = claimCodes[merchantId];
      if (!expected || typeof code !== 'string' || !sameSecret(code, expected)) {
        throw new HttpError(403, 'claim_invalid', 'That code is not valid for this store.');
      }
      db.prepare('INSERT OR IGNORE INTO merchant_members (user_id, merchant_id, created_at) VALUES (?, ?, ?)')
        .run(userId, merchantId, now().toISOString());
    },
  };
}

const PRICE_MIN = 100; // N1.00 in kobo
const PRICE_MAX = 100_000_000; // N1,000,000.00 in kobo
const STOCK_MAX = 100_000;

function isMoney(value) {
  return Number.isInteger(value) && value >= PRICE_MIN && value <= PRICE_MAX;
}

// Changes a product this merchant owns. Every value is validated before anything is written,
// so a rejected request leaves the product exactly as it was.
export function updateMerchantProduct(catalogue, merchantId, productId, patch) {
  const product = catalogue.products.find((p) => p.id === productId && p.merchantId === merchantId);
  if (!product) throw new HttpError(404, 'product_not_found', 'Product not found.');

  const next = {
    stock: product.stock,
    priceKobo: product.priceKobo,
    promoPriceKobo: product.promoPriceKobo,
  };

  if (patch.stock !== undefined) {
    if (patch.stock !== null && (!Number.isInteger(patch.stock) || patch.stock < 0 || patch.stock > STOCK_MAX)) {
      throw new HttpError(422, 'stock_invalid', 'Stock must be a whole number. Leave it empty for made-to-order.');
    }
    next.stock = patch.stock;
  }
  if (patch.priceKobo !== undefined) {
    if (!isMoney(patch.priceKobo)) throw new HttpError(422, 'price_invalid', 'Enter a valid price in naira.');
    next.priceKobo = patch.priceKobo;
  }
  if (patch.promoPriceKobo !== undefined) {
    if (patch.promoPriceKobo !== null && !isMoney(patch.promoPriceKobo)) {
      throw new HttpError(422, 'promo_invalid', 'Enter a valid offer price in naira, or leave it empty.');
    }
    next.promoPriceKobo = patch.promoPriceKobo;
  }
  if (next.promoPriceKobo !== null && next.promoPriceKobo >= next.priceKobo) {
    throw new HttpError(422, 'promo_invalid', 'The offer price must be lower than the regular price.');
  }

  Object.assign(product, next);
  return product;
}

export function serializeMerchantProduct(product) {
  return {
    id: product.id,
    name: product.name,
    priceKobo: product.priceKobo,
    promoPriceKobo: product.promoPriceKobo,
    stock: product.stock,
    variants: product.variants.map((v) => ({ id: v.id, label: v.label, options: v.options })),
  };
}
