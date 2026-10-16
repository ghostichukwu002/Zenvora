// SQLite via Node's built-in node:sqlite (no npm packages).
// Pass ':memory:' for tests, or a file path for development data.
// node:sqlite is still marked experimental in Node 22, so it prints a one-time warning.

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL,
    phone         TEXT,
    role          TEXT NOT NULL DEFAULT 'customer',
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS product_overrides (
    product_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    stock INTEGER,
    price_kobo INTEGER NOT NULL,
    promo_price_kobo INTEGER,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS moderator_products (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '',
    price_kobo INTEGER NOT NULL,
    promo_price_kobo INTEGER,
    stock INTEGER,
    specifications_json TEXT NOT NULL DEFAULT '{}',
    images_json TEXT NOT NULL DEFAULT '[]',
    variants_json TEXT NOT NULL DEFAULT '[]',
    added_at TEXT NOT NULL,
    created_by TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL REFERENCES users(id),
    merchant_id        TEXT NOT NULL,
    merchant_name      TEXT NOT NULL,
    status             TEXT NOT NULL,
    payment_method     TEXT NOT NULL,
    payment_status     TEXT NOT NULL,
    subtotal_kobo      INTEGER NOT NULL,
    delivery_fee_kobo  INTEGER NOT NULL,
    total_kobo         INTEGER NOT NULL,
    delivery_name      TEXT NOT NULL,
    delivery_phone     TEXT NOT NULL,
    delivery_state     TEXT NOT NULL,
    delivery_city      TEXT NOT NULL,
    delivery_area      TEXT NOT NULL,
    delivery_address   TEXT NOT NULL,
    delivery_notes     TEXT,
    idempotency_key    TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    UNIQUE (user_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id   TEXT NOT NULL,
    name         TEXT NOT NULL,
    variant_json TEXT NOT NULL,
    quantity     INTEGER NOT NULL,
    unit_kobo    INTEGER NOT NULL,
    line_kobo    INTEGER NOT NULL
  );

  -- Which accounts may act for which store. Granted by a claim code (see merchant.js).
  CREATE TABLE IF NOT EXISTS merchant_members (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_id TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, merchant_id)
  );

  -- Delivery partners. A rider can only take work once an administrator has approved them.
  CREATE TABLE IF NOT EXISTS riders (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,            -- pending | approved | suspended
    vehicle     TEXT NOT NULL,
    phone       TEXT NOT NULL,
    areas_json  TEXT NOT NULL,            -- delivery areas the rider covers
    available   INTEGER NOT NULL DEFAULT 0,
    admin_note  TEXT,
    created_at  TEXT NOT NULL,
    approved_at TEXT
  );

  -- One active assignment per order. Rows are removed when a rider declines before pickup.
  CREATE TABLE IF NOT EXISTS deliveries (
    order_id       TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
    rider_user_id  TEXT NOT NULL REFERENCES users(id),
    status         TEXT NOT NULL,         -- assigned | picked_up | delivered | failed
    assigned_at    TEXT NOT NULL,
    picked_up_at   TEXT,
    completed_at   TEXT,
    proof_note     TEXT,
    failure_reason TEXT
  );

  -- Record of staff and rider actions that change orders, riders or access.
  CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id TEXT NOT NULL,
    action       TEXT NOT NULL,
    target       TEXT NOT NULL,
    detail_json  TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  -- Stores an administrator has verified. Survives restarts; loaded into the catalogue at startup.
  CREATE TABLE IF NOT EXISTS store_verifications (
    merchant_id TEXT PRIMARY KEY,
    verified_at TEXT NOT NULL,
    verified_by TEXT NOT NULL
  );

  -- Customer care requests from signed-in customers.
  CREATE TABLE IF NOT EXISTS support_requests (
    id          TEXT PRIMARY KEY,
    user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    topic       TEXT NOT NULL,
    order_id    TEXT,
    message     TEXT NOT NULL,
    status      TEXT NOT NULL,            -- open | answered | closed
    reply       TEXT,
    replied_at  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_deliveries_rider ON deliveries(rider_user_id, status);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_support_status ON support_requests(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_support_user ON support_requests(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;

export function openDatabase(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

// Runs fn inside a transaction. Rolls back and rethrows if fn throws.
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
