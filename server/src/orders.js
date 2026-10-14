// Order placement. Nothing the browser sends about money is trusted:
// prices, stock, delivery fee and the delivery area are all re-checked here.
//
// Supported payment method in this release: cash on delivery only.
// Orders start as "placed" with payment "cod_pending" (cash is collected on delivery).
// They are never marked paid or delivered here. Those need verified later events
// (merchant acceptance, a rider handover, cash collection) that do not exist yet.

import { randomBytes } from 'node:crypto';
import { transaction } from './db.js';
import { assertDeliverable, CartError, priceCart } from './cart.js';
import { normalizeNigerianPhone } from './auth.js';
import { HttpError } from './router.js';

export const PAYMENT_METHODS = ['cash_on_delivery'];

// Statuses a store can set. "delivered" is deliberately absent: it needs a verified handover
// from a rider, which does not exist yet, so a store cannot mark an order delivered by itself.
export const MERCHANT_TRANSITIONS = {
  placed: ['accepted', 'rejected'],
  accepted: ['preparing', 'rejected'],
  preparing: ['ready'],
  ready: [],
  rejected: [],
};

function cleanText(value, { min, max, field }) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (text.length < min || text.length > max) {
    throw new HttpError(422, `${field}_invalid`, `Check the ${field.replace('_', ' ')} and try again.`);
  }
  return text;
}

function validateDelivery(input, cart, merchant) {
  const d = input && typeof input === 'object' ? input : {};
  const name = cleanText(d.name, { min: 2, max: 100, field: 'name' });
  const phone = normalizeNigerianPhone(d.phone);
  if (!phone) {
    throw new HttpError(422, 'phone_invalid', 'Enter a valid Nigerian mobile number, for example 0803 123 4567.');
  }
  const address = cleanText(d.address, { min: 5, max: 300, field: 'address' });
  let notes = null;
  if (d.notes !== undefined && d.notes !== null && d.notes !== '') {
    notes = cleanText(d.notes, { min: 1, max: 300, field: 'notes' });
  }
  // Area, city and state come from the server's own data (the cart's validated area and the
  // store's location), never from the browser, so they cannot disagree with where the store delivers.
  return { name, phone, state: merchant.state, city: merchant.city, area: cart.deliveryArea, address, notes };
}

function newOrderId() {
  return `ZV-${randomBytes(5).toString('hex').toUpperCase()}`;
}

export function serializeOrder(db, row) {
  const items = db
    .prepare('SELECT product_id, name, variant_json, quantity, unit_kobo, line_kobo FROM order_items WHERE order_id = ? ORDER BY id')
    .all(row.id);
  return {
    id: row.id,
    status: row.status,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    merchant: { id: row.merchant_id, name: row.merchant_name },
    items: items.map((i) => ({
      productId: i.product_id,
      name: i.name,
      variantChoice: JSON.parse(i.variant_json),
      quantity: i.quantity,
      unitKobo: i.unit_kobo,
      lineKobo: i.line_kobo,
    })),
    subtotalKobo: row.subtotal_kobo,
    deliveryFeeKobo: row.delivery_fee_kobo,
    totalKobo: row.total_kobo,
    delivery: {
      name: row.delivery_name,
      phone: row.delivery_phone,
      state: row.delivery_state,
      city: row.delivery_city,
      area: row.delivery_area,
      address: row.delivery_address,
      notes: row.delivery_notes,
    },
    createdAt: row.created_at,
  };
}

export function createOrders(db, { now = () => new Date() } = {}) {
  return {
    // Returns { order, replayed }. A repeated idempotency key returns the original order untouched.
    place({ userId, cart, catalogue, idempotencyKey, delivery, paymentMethod }) {
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
        throw new HttpError(400, 'idempotency_key_required', 'Checkout could not be started. Please reload and try again.');
      }
      if (!PAYMENT_METHODS.includes(paymentMethod)) {
        throw new HttpError(422, 'payment_method_unsupported', 'That payment method is not available yet. Choose cash on delivery.');
      }

      // A retried submission returns the order that was already created.
      const existing = db
        .prepare('SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?')
        .get(userId, idempotencyKey);
      if (existing) return { order: serializeOrder(db, existing), replayed: true };

      if (!cart.items.length || !cart.merchantId) {
        throw new CartError('cart_empty', 'Your cart is empty.', 409);
      }
      const merchant = catalogue.merchants.find((m) => m.id === cart.merchantId);
      assertDeliverable(merchant, cart.deliveryArea);
      const deliveryDetails = validateDelivery(delivery, cart, merchant);

      // Re-check stock for every line against the current catalogue before taking anything.
      for (const line of cart.items) {
        const product = catalogue.products.find((p) => p.id === line.productId);
        if (!product) throw new CartError('product_not_found', 'An item in your cart is no longer available.', 409);
        if (product.stock !== null) {
          if (product.stock === 0) {
            throw new CartError('out_of_stock', `${product.name} is currently unavailable.`, 409);
          }
          if (line.quantity > product.stock) {
            throw new CartError('insufficient_stock', `Only ${product.stock} of ${product.name} left.`, 409);
          }
        }
      }

      const priced = priceCart(cart, catalogue);
      const id = newOrderId();
      const createdAt = now().toISOString();

      try {
        transaction(db, () => {
          db.prepare(
            `INSERT INTO orders (id, user_id, merchant_id, merchant_name, status, payment_method, payment_status,
               subtotal_kobo, delivery_fee_kobo, total_kobo, delivery_name, delivery_phone, delivery_state,
               delivery_city, delivery_area, delivery_address, delivery_notes, idempotency_key, created_at)
             VALUES (?, ?, ?, ?, 'placed', ?, 'cod_pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id, userId, merchant.id, merchant.name, paymentMethod,
            priced.subtotalKobo, priced.deliveryFeeKobo, priced.totalKobo,
            deliveryDetails.name, deliveryDetails.phone, deliveryDetails.state, deliveryDetails.city,
            deliveryDetails.area, deliveryDetails.address, deliveryDetails.notes, idempotencyKey, createdAt,
          );
          const insertItem = db.prepare(
            `INSERT INTO order_items (order_id, product_id, name, variant_json, quantity, unit_kobo, line_kobo)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          );
          for (const l of priced.lines) {
            insertItem.run(id, l.productId, l.name, JSON.stringify(l.variantChoice), l.quantity, l.unitKobo, l.lineKobo);
          }
        });
      } catch (err) {
        // Two identical submissions racing: the UNIQUE constraint lets one win, the other replays it.
        const raced = db
          .prepare('SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?')
          .get(userId, idempotencyKey);
        if (raced) return { order: serializeOrder(db, raced), replayed: true };
        throw err;
      }

      // Take the stock only after the order is safely stored.
      for (const line of cart.items) {
        const product = catalogue.products.find((p) => p.id === line.productId);
        if (product.stock !== null) product.stock -= line.quantity;
      }

      const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      return { order: serializeOrder(db, row), replayed: false };
    },

    // Only the owner can read an order. Anyone else gets "not found", never "forbidden".
    get(userId, orderId) {
      const row = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, userId);
      if (!row) throw new HttpError(404, 'order_not_found', 'Order not found.');
      return serializeOrder(db, row);
    },

    listForMerchant(merchantId) {
      const rows = db
        .prepare('SELECT * FROM orders WHERE merchant_id = ? ORDER BY created_at DESC, id DESC LIMIT 200')
        .all(merchantId);
      return rows.map((r) => serializeOrder(db, r));
    },

    // Rejected orders are excluded from sales figures. Totals include delivery fees.
    summaryForMerchant(merchantId) {
      const since = new Date(now().getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const sales = (sinceIso) =>
        db
          .prepare(
            `SELECT COUNT(*) AS orders, COALESCE(SUM(total_kobo), 0) AS valueKobo FROM orders
             WHERE merchant_id = ? AND status != 'rejected' AND created_at >= ?`,
          )
          .get(merchantId, sinceIso);
      const byStatus = db
        .prepare('SELECT status, COUNT(*) AS n FROM orders WHERE merchant_id = ? GROUP BY status')
        .all(merchantId);
      return {
        allTime: sales('1970-01-01T00:00:00.000Z'),
        last7Days: sales(since),
        byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      };
    },

    // Moves an order one allowed step. Rejecting returns the reserved stock to the catalogue.
    setMerchantStatus({ merchantId, orderId, nextStatus, catalogue }) {
      const row = db.prepare('SELECT * FROM orders WHERE id = ? AND merchant_id = ?').get(orderId, merchantId);
      if (!row) throw new HttpError(404, 'order_not_found', 'Order not found.');

      if (!(MERCHANT_TRANSITIONS[row.status] ?? []).includes(nextStatus)) {
        throw new HttpError(409, 'invalid_transition', `An order that is ${row.status} can't be set to ${nextStatus}.`);
      }

      transaction(db, () => {
        // Conditional update: if another request changed the status first, this changes nothing.
        const result = db
          .prepare('UPDATE orders SET status = ? WHERE id = ? AND status = ?')
          .run(nextStatus, orderId, row.status);
        if (result.changes !== 1) {
          throw new HttpError(409, 'status_changed', 'This order was just updated. Refresh and try again.');
        }
      });

      if (nextStatus === 'rejected') {
        const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(orderId);
        for (const item of items) {
          const product = catalogue.products.find((p) => p.id === item.product_id);
          if (product && product.stock !== null) product.stock += item.quantity;
        }
      }

      return serializeOrder(db, db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
    },

    list(userId) {
      const rows = db
        .prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50')
        .all(userId);
      return rows.map((r) => serializeOrder(db, r));
    },
  };
}
