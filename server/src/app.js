import { randomUUID } from 'node:crypto';
import { AUTH_COOKIE, createAuth, createRateLimiter, normalizeNigerianPhone, publicUser } from './auth.js';
import {
  addItem,
  CartError,
  emptyCart,
  priceCart,
  removeItem,
  setDeliveryArea,
  updateQuantity,
} from './cart.js';
import { createCartStore, readCookie, SESSION_COOKIE } from './cart-store.js';
import { openDatabase } from './db.js';
import { createOrders } from './orders.js';
import { createMerchantAccess, serializeMerchantProduct, updateMerchantProduct } from './merchant.js';
import { createDispatch } from './dispatch.js';
import { createSupport } from './support.js';
import { createTrust } from './trust.js';
import { createRouter, HttpError, readJsonBody, sendError, sendJson } from './router.js';
import { serveStatic } from './static.js';

const LOW_STOCK_THRESHOLD = 5;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function availabilityOf(product) {
  if (product.stock === null) return 'made_to_order';
  if (product.stock === 0) return 'out_of_stock';
  if (product.stock <= LOW_STOCK_THRESHOLD) return 'low_stock';
  return 'in_stock';
}

// Shapes a product for the public API. Internal fields are not exposed,
// and exact stock counts are withheld: customers only see a stock level.
function serializeProduct(product, catalogue) {
  const merchant = catalogue.merchants.find((m) => m.id === product.merchantId);
  const category = catalogue.categories.find((c) => c.id === product.category);
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    category: { id: category.id, name: category.name },
    merchant: {
      id: merchant.id,
      name: merchant.name,
      city: merchant.city,
      state: merchant.state,
      serviceAreas: merchant.serviceAreas,
      prepMinutes: merchant.prepMinutes,
      section: merchant.section,
      verified: merchant.verified === true,
    },
    priceKobo: product.priceKobo,
    promoPriceKobo: product.promoPriceKobo,
    effectivePriceKobo: product.promoPriceKobo ?? product.priceKobo,
    availability: availabilityOf(product),
    // Price deltas are public: the storefront shows how a choice changes the price.
    variants: product.variants.map((v) => ({
      id: v.id,
      label: v.label,
      options: v.options,
      priceDeltaKobo: v.priceDeltaKobo,
    })),
    addedAt: product.addedAt,
  };
}

function parseIntParam(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Which storefront a request is for. Anything unknown means the main shop.
function sectionParam(query) {
  return query?.section === 'puff' ? 'puff' : 'shop';
}

function listProducts(query, catalogue) {
  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase().slice(0, 100) : '';
  const category = typeof query.category === 'string' ? query.category : null;
  const merchant = typeof query.merchant === 'string' ? query.merchant : null;
  const sort = ['newest', 'price-asc', 'price-desc'].includes(query.sort) ? query.sort : 'newest';
  const area = typeof query.area === 'string' ? query.area.slice(0, 100) : null;
  const promoOnly = query.promo === '1';
  const limit = parseIntParam(query.limit, 12, 1, 50);
  const offset = parseIntParam(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  // Each storefront only lists its own merchants: Shop n Delight never shows Puff & Sip stock.
  let results = catalogue.products
    .map((p) => serializeProduct(p, catalogue))
    .filter((p) => p.merchant.section === sectionParam(query));

  if (category) results = results.filter((p) => p.category.id === category);
  if (merchant) results = results.filter((p) => p.merchant.id === merchant);
  // Only products from merchants that actually deliver to the chosen area.
  if (area) results = results.filter((p) => p.merchant.serviceAreas.includes(area));
  if (promoOnly) results = results.filter((p) => p.promoPriceKobo !== null);
  if (q) {
    results = results.filter((p) =>
      [p.name, p.description, p.merchant.name, p.category.name]
        .some((field) => field.toLowerCase().includes(q)),
    );
  }

  if (sort === 'newest') {
    results.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  } else {
    const dir = sort === 'price-asc' ? 1 : -1;
    results.sort((a, b) => dir * (a.effectivePriceKobo - b.effectivePriceKobo));
  }

  return {
    total: results.length,
    limit,
    offset,
    items: results.slice(offset, offset + limit),
  };
}

// The address rate limits are keyed on. Behind a reverse proxy the socket address is the proxy
// itself, so every visitor would share one limit. When the proxy is trusted, the address it appended
// to X-Forwarded-For is used. That is the last entry: anything a client sends before it is ignored.
export function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for'];
    if (typeof header === 'string') {
      const last = header.split(',').pop().trim();
      if (last && last.length <= 45) return last;
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

// Builds the request handler. Pass it to http.createServer().
// webRoot is optional. When given, non-API paths serve the browser app from that folder.
// db, sendResetEmail and rateLimits can be injected, which tests rely on.
export function createApp({
  catalogue,
  store = createCartStore(),
  webRoot = null,
  db = openDatabase(':memory:'),
  sendResetEmail,
  rateLimits = {},
  merchantClaimCodes = {},
  trustProxy = false,
  // Other sites allowed to send writes, as full origins (for example https://your-frontend.example).
  // Only needed when the browser app is served from a different domain that forwards to this server.
  allowedOrigins = [],
  // Emails that become administrators: at registration, and for existing accounts at startup.
  adminEmails = [],
  moderatorEmails = [],
}) {
  const allowed = new Set(allowedOrigins);
  const router = createRouter();
  const auth = createAuth(db, { sendResetEmail, adminEmails, moderatorEmails });
  // Accounts named in ZENVORA_ADMIN_EMAILS are made administrators at startup, for accounts that
  // already exist. This only grants access. Removing an email from the list does not demote anyone;
  // use scripts/grant-role.js for that.
  for (const email of adminEmails) {
    const changed = db.prepare("UPDATE users SET role = 'admin' WHERE email = ? AND role != 'admin'").run(email).changes;
    if (changed) {
      db.prepare('INSERT INTO audit_log (actor_user_id, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('system', 'account.role_changed', email, JSON.stringify({ role: 'admin', via: 'ZENVORA_ADMIN_EMAILS' }), new Date().toISOString());
    }
  }
  // Existing accounts listed in ZENVORA_MODERATOR_EMAILS receive catalogue-only access.
  // Admins stay admins; removing an email from this list never silently demotes an account.
  for (const email of moderatorEmails) {
    const changed = db.prepare("UPDATE users SET role = 'moderator' WHERE email = ? AND role = 'customer'").run(email).changes;
    if (changed) {
      db.prepare('INSERT INTO audit_log (actor_user_id, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('system', 'account.role_changed', email, JSON.stringify({ role: 'moderator', via: 'ZENVORA_MODERATOR_EMAILS' }), new Date().toISOString());
    }
  }

  // Persisted catalogue edits survive restarts and are applied before public product routes run.
  const savedOverrides = db.prepare('SELECT product_id, name, description, stock, price_kobo, promo_price_kobo FROM product_overrides').all();
  for (const saved of savedOverrides) {
    const product = catalogue.products.find((item) => item.id === saved.product_id);
    if (product) Object.assign(product, {
      name: saved.name,
      description: saved.description,
      stock: saved.stock,
      priceKobo: saved.price_kobo,
      promoPriceKobo: saved.promo_price_kobo,
    });
  }

  const orders = createOrders(db);
  const merchantAccess = createMerchantAccess(db, { claimCodes: merchantClaimCodes });
  const dispatch = createDispatch(db, { catalogue });
  const support = createSupport(db);
  const trust = createTrust(db, { catalogue });
  const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: rateLimits.authMax ?? 30 });
  const loginEmailLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: rateLimits.loginPerEmailMax ?? 8 });

  router.get('/api/health', () => ({ status: 200, body: { ok: true } }));

  router.get('/api/categories', (ctx) => {
    const counts = new Map();
    const section = sectionParam(ctx.query);
    for (const p of catalogue.products) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    return {
      status: 200,
      body: {
        items: catalogue.categories
          .filter((c) => c.section === section)
          .map((c) => ({ id: c.id, name: c.name, glyph: c.glyph, productCount: counts.get(c.id) ?? 0 })),
      },
    };
  });

  router.get('/api/areas', () => {
    // Every delivery area any merchant serves, de-duplicated and sorted.
    const seen = new Map();
    for (const m of catalogue.merchants) {
      for (const name of m.serviceAreas) {
        if (!seen.has(name)) seen.set(name, { name, city: m.city, state: m.state });
      }
    }
    const items = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { status: 200, body: { items } };
  });

  router.get('/api/products', (ctx) => ({ status: 200, body: listProducts(ctx.query, catalogue) }));

  router.get('/api/products/:id', (ctx) => {
    const product = catalogue.products.find((p) => p.id === ctx.params.id);
    if (!product) throw new CartError('product_not_found', 'Product not found.', 404);
    return { status: 200, body: serializeProduct(product, catalogue) };
  });

  router.get('/api/cart', (ctx) => ({ status: 200, body: priceCart(store.get(ctx.sid), catalogue) }));

  router.post('/api/cart/items', (ctx) => {
    const body = ctx.body;
    if (typeof body.productId !== 'string' || body.productId.length > 100) {
      throw new CartError('product_invalid', 'A product is required.');
    }
    const variantChoice = body.variantChoice ?? {};
    if (typeof variantChoice !== 'object' || variantChoice === null || Array.isArray(variantChoice)) {
      throw new CartError('variant_invalid', 'Variant choices are invalid.');
    }
    const next = addItem(
      store.get(ctx.sid),
      { productId: body.productId, variantChoice, quantity: body.quantity ?? 1 },
      catalogue,
    );
    store.set(ctx.sid, next);
    return { status: 201, body: priceCart(next, catalogue) };
  });

  router.patch('/api/cart/items/:key', (ctx) => {
    const next = updateQuantity(store.get(ctx.sid), ctx.params.key, ctx.body.quantity, catalogue);
    store.set(ctx.sid, next);
    return { status: 200, body: priceCart(next, catalogue) };
  });

  router.delete('/api/cart/items/:key', (ctx) => {
    const next = removeItem(store.get(ctx.sid), ctx.params.key);
    store.set(ctx.sid, next);
    return { status: 200, body: priceCart(next, catalogue) };
  });

  router.put('/api/cart/delivery-area', (ctx) => {
    const area = typeof ctx.body.area === 'string' ? ctx.body.area.slice(0, 100) : null;
    const next = setDeliveryArea(store.get(ctx.sid), area, catalogue);
    store.set(ctx.sid, next);
    return { status: 200, body: priceCart(next, catalogue) };
  });

  router.delete('/api/cart', (ctx) => {
    const cleared = { items: [], merchantId: null, deliveryArea: null };
    store.set(ctx.sid, cleared);
    return { status: 200, body: priceCart(cleared, catalogue) };
  });

  // ---------- Accounts ----------

  const authCookie = (token, maxAgeSeconds, secure) =>
    `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;

  function requireUser(ctx) {
    if (!ctx.user) throw new HttpError(401, 'auth_required', 'Log in to continue.');
    return ctx.user;
  }

  function limit(limiter, key) {
    const wait = limiter.check(key);
    if (wait > 0) {
      const minutes = Math.max(1, Math.ceil(wait / 60));
      throw new HttpError(429, 'rate_limited', `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }
  }

  router.post('/api/auth/register', async (ctx) => {
    limit(authLimiter, `auth:${ctx.ip}`);
    const { user, session } = await auth.register(ctx.body);
    return {
      status: 201,
      body: { user },
      cookies: [authCookie(session.token, session.maxAgeSeconds, ctx.secure)],
    };
  });

  router.post('/api/auth/login', async (ctx) => {
    limit(authLimiter, `auth:${ctx.ip}`);
    if (typeof ctx.body.email === 'string') limit(loginEmailLimiter, `login:${ctx.body.email.trim().toLowerCase()}`);
    const { user, session } = await auth.login(ctx.body);
    return {
      status: 200,
      body: { user },
      cookies: [authCookie(session.token, session.maxAgeSeconds, ctx.secure)],
    };
  });

  router.post('/api/auth/logout', (ctx) => {
    auth.logout(ctx.authToken);
    return { status: 200, body: { ok: true }, cookies: [authCookie('', 0, ctx.secure)] };
  });

  router.get('/api/auth/me', (ctx) => ({
    status: 200,
    body: { user: ctx.user ? publicUser(ctx.user) : null },
  }));

  router.patch('/api/auth/profile', (ctx) => {
    const user = requireUser(ctx);
    return { status: 200, body: { user: auth.updateProfile(user.id, ctx.body) } };
  });

  // Customer tools are stored server-side and scoped to the authenticated account.
  router.get('/api/account/wishlist', (ctx) => {
    const user = requireUser(ctx);
    const rows = db.prepare('SELECT product_id, created_at FROM wishlists WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
    const items = rows.map((row) => catalogue.products.find((p) => p.id === row.product_id))
      .filter(Boolean).map((product) => serializeProduct(product, catalogue));
    return { status: 200, body: { items } };
  });

  router.post('/api/account/wishlist/:productId', (ctx) => {
    const user = requireUser(ctx);
    const product = catalogue.products.find((p) => p.id === ctx.params.productId);
    if (!product) throw new CartError('product_not_found', 'That product is no longer available.', 404);
    db.prepare('INSERT OR IGNORE INTO wishlists (user_id, product_id, created_at) VALUES (?, ?, ?)')
      .run(user.id, product.id, new Date().toISOString());
    return { status: 201, body: { ok: true, productId: product.id } };
  });

  router.delete('/api/account/wishlist/:productId', (ctx) => {
    const user = requireUser(ctx);
    db.prepare('DELETE FROM wishlists WHERE user_id = ? AND product_id = ?').run(user.id, ctx.params.productId);
    return { status: 200, body: { ok: true } };
  });

  router.get('/api/account/addresses', (ctx) => {
    const user = requireUser(ctx);
    const items = db.prepare('SELECT id, label, recipient_name AS recipientName, phone, address, area, city, state FROM saved_addresses WHERE user_id = ? ORDER BY created_at DESC')
      .all(user.id);
    return { status: 200, body: { items } };
  });

  router.post('/api/account/addresses', (ctx) => {
    const user = requireUser(ctx);
    const body = ctx.body ?? {};
    const clean = (value, min, max, field) => {
      const result = typeof value === 'string' ? value.trim().replace(/\\s+/g, ' ') : '';
      if (result.length < min || result.length > max) {
        throw new HttpError(422, 'address_invalid', `Check the ${field} and try again.`);
      }
      return result;
    };
    const current = db.prepare('SELECT COUNT(*) AS count FROM saved_addresses WHERE user_id = ?').get(user.id).count;
    if (current >= 10) throw new HttpError(409, 'address_limit', 'You can save up to 10 delivery addresses.');
    const row = {
      id: randomUUID(),
      label: clean(body.label || 'Home', 1, 40, 'label'),
      recipientName: clean(body.recipientName, 2, 100, 'recipient name'),
      phone: normalizeNigerianPhone(clean(body.phone, 7, 24, 'phone number')) || (() => { throw new HttpError(422, 'phone_invalid', 'Enter a valid Nigerian mobile number.'); })(),
      address: clean(body.address, 5, 300, 'street address'),
      area: clean(body.area, 2, 100, 'delivery area'),
      city: clean(body.city, 2, 100, 'city'),
      state: clean(body.state, 2, 100, 'state'),
      createdAt: new Date().toISOString(),
    };
    db.prepare('INSERT INTO saved_addresses (id, user_id, label, recipient_name, phone, address, area, city, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, user.id, row.label, row.recipientName, row.phone, row.address, row.area, row.city, row.state, row.createdAt);
    return { status: 201, body: { address: { id: row.id, label: row.label, recipientName: row.recipientName, phone: row.phone, address: row.address, area: row.area, city: row.city, state: row.state } } };
  });

  router.delete('/api/account/addresses/:id', (ctx) => {
    const user = requireUser(ctx);
    db.prepare('DELETE FROM saved_addresses WHERE id = ? AND user_id = ?').run(ctx.params.id, user.id);
    return { status: 200, body: { ok: true } };
  });

  // Same response whether or not the email has an account, so it cannot be used to find accounts.
  router.post('/api/auth/forgot-password', async (ctx) => {
    limit(authLimiter, `auth:${ctx.ip}`);
    await auth.requestPasswordReset(ctx.body.email);
    return {
      status: 200,
      body: { ok: true, message: 'If an account exists for that email, a reset link has been sent.' },
    };
  });

  router.post('/api/auth/reset-password', async (ctx) => {
    limit(authLimiter, `auth:${ctx.ip}`);
    await auth.resetPassword(ctx.body.token, ctx.body.password);
    return { status: 200, body: { ok: true } };
  });

  // ---------- Orders ----------

  router.post('/api/orders', (ctx) => {
    const user = requireUser(ctx);
    const { order, replayed } = orders.place({
      userId: user.id,
      cart: store.get(ctx.sid),
      catalogue,
      idempotencyKey: ctx.body.idempotencyKey,
      delivery: ctx.body.delivery,
      paymentMethod: ctx.body.paymentMethod,
    });
    // A new order empties the cart. A replay leaves it alone, since the first submission already did.
    if (!replayed) store.set(ctx.sid, emptyCart());
    return { status: replayed ? 200 : 201, body: { order, replayed } };
  });

  router.get('/api/orders', (ctx) => {
    const user = requireUser(ctx);
    return { status: 200, body: { items: orders.list(user.id) } };
  });

  router.get('/api/orders/:id', (ctx) => {
    const user = requireUser(ctx);
    const order = orders.get(user.id, ctx.params.id);
    return { status: 200, body: { order: { ...order, rider: dispatch.publicRiderFor(order.id) } } };
  });

  // ---------- Merchant workspace ----------
  // Every route checks store membership on the server. The screens only hide what is not allowed.

  const requireMerchant = (ctx) => {
    const user = requireUser(ctx);
    merchantAccess.requireMember(user.id, ctx.params.merchantId);
    return user;
  };

  router.get('/api/merchant/memberships', (ctx) => {
    const user = requireUser(ctx);
    const items = merchantAccess.memberships(user.id).map(({ id }) => ({
      id,
      name: catalogue.merchants.find((m) => m.id === id)?.name ?? id,
    }));
    return { status: 200, body: { items } };
  });

  router.post('/api/merchant/claim', (ctx) => {
    const user = requireUser(ctx);
    limit(authLimiter, `claim:${ctx.ip}`);
    const merchantId = typeof ctx.body.merchantId === 'string' ? ctx.body.merchantId : '';
    if (!catalogue.merchants.some((m) => m.id === merchantId)) {
      throw new HttpError(404, 'merchant_not_found', 'Store not found.');
    }
    merchantAccess.claim(user.id, merchantId, ctx.body.code);
    return { status: 201, body: { ok: true, merchantId } };
  });

  router.get('/api/merchant/:merchantId/orders', (ctx) => {
    requireMerchant(ctx);
    return {
      status: 200,
      body: {
        items: orders.listForMerchant(ctx.params.merchantId),
        summary: orders.summaryForMerchant(ctx.params.merchantId),
      },
    };
  });

  router.patch('/api/merchant/:merchantId/orders/:orderId', (ctx) => {
    requireMerchant(ctx);
    const order = orders.setMerchantStatus({
      merchantId: ctx.params.merchantId,
      orderId: ctx.params.orderId,
      nextStatus: ctx.body.status,
      catalogue,
    });
    return { status: 200, body: { order } };
  });

  router.get('/api/merchant/:merchantId/products', (ctx) => {
    requireMerchant(ctx);
    const items = catalogue.products
      .filter((p) => p.merchantId === ctx.params.merchantId)
      .map(serializeMerchantProduct);
    return { status: 200, body: { items } };
  });

  router.patch('/api/merchant/:merchantId/products/:productId', (ctx) => {
    requireMerchant(ctx);
    const product = updateMerchantProduct(catalogue, ctx.params.merchantId, ctx.params.productId, ctx.body);
    return { status: 200, body: { product: serializeMerchantProduct(product) } };
  });

  // ---------- Riders ----------
  // Riders apply, wait for approval, then take only the jobs an administrator assigns to them.

  router.get('/api/rider/me', (ctx) => {
    const user = requireUser(ctx);
    return { status: 200, body: { rider: dispatch.riderProfile(user.id) } };
  });

  router.post('/api/rider/apply', (ctx) => {
    const user = requireUser(ctx);
    return { status: 201, body: { rider: dispatch.applyAsRider(user.id, ctx.body) } };
  });

  router.patch('/api/rider/me', (ctx) => {
    const user = requireUser(ctx);
    return { status: 200, body: { rider: dispatch.setAvailability(user.id, ctx.body.available) } };
  });

  router.get('/api/rider/jobs', (ctx) => {
    const user = requireUser(ctx);
    return { status: 200, body: dispatch.riderJobs(user.id) };
  });

  router.post('/api/rider/jobs/:orderId/pickup', (ctx) => {
    const user = requireUser(ctx);
    return { status: 200, body: { job: dispatch.pickUp(user.id, ctx.params.orderId) } };
  });

  router.post('/api/rider/jobs/:orderId/complete', (ctx) => {
    const user = requireUser(ctx);
    return { status: 200, body: { job: dispatch.complete(user.id, ctx.params.orderId, ctx.body) } };
  });

  router.post('/api/rider/jobs/:orderId/fail', (ctx) => {
    const user = requireUser(ctx);
    return { status: 200, body: { job: dispatch.fail(user.id, ctx.params.orderId, ctx.body) } };
  });

  router.post('/api/rider/jobs/:orderId/decline', (ctx) => {
    const user = requireUser(ctx);
    return { status: 200, body: dispatch.decline(user.id, ctx.params.orderId) };
  });

  // ---------- Customer care ----------

  router.post('/api/support', (ctx) => {
    const user = requireUser(ctx);
    return { status: 201, body: { request: support.create(user, ctx.body) } };
  });

  router.get('/api/support/mine', (ctx) => {
    const user = requireUser(ctx);
    return { status: 200, body: { items: support.listMine(user.id) } };
  });

  // ---------- Administration ----------
  // Admin access is checked here on the server, for every route. Admin accounts are granted
  // from the command line (server/scripts/grant-role.js), never by sign-up or a hardcoded login.

  const requireAdmin = (ctx) => {
    const user = requireUser(ctx);
    if (user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only administrators can do that.');
    return user;
  };

  const requireModerator = (ctx) => {
    const user = requireUser(ctx);
    if (!['admin', 'moderator'].includes(user.role)) {
      throw new HttpError(403, 'forbidden', 'Moderator access is required.');
    }
    return user;
  };

  // Moderators can update catalogue values across both storefronts, but cannot access
  // sales, riders, support, staff permissions, or other owner-only administration endpoints.
  router.get('/api/moderator/products', (ctx) => {
    requireModerator(ctx);
    const section = ctx.query.section === 'puff' ? 'puff' : ctx.query.section === 'shop' ? 'shop' : null;
    const items = catalogue.products
      .filter((product) => !section || catalogue.merchants.find((m) => m.id === product.merchantId)?.section === section)
      .map((product) => ({
        id: product.id, name: product.name, description: product.description,
        merchantId: product.merchantId,
        merchantName: catalogue.merchants.find((m) => m.id === product.merchantId)?.name ?? product.merchantId,
        section: catalogue.merchants.find((m) => m.id === product.merchantId)?.section ?? 'shop',
        priceKobo: product.priceKobo, promoPriceKobo: product.promoPriceKobo, stock: product.stock,
      }));
    return { status: 200, body: { items } };
  });

  router.patch('/api/moderator/products/:productId', (ctx) => {
    const user = requireModerator(ctx);
    const product = catalogue.products.find((item) => item.id === ctx.params.productId);
    if (!product) throw new HttpError(404, 'product_not_found', 'Product not found.');
    const body = ctx.body ?? {};
    const next = {
      name: product.name,
      description: product.description,
      stock: product.stock,
      priceKobo: product.priceKobo,
      promoPriceKobo: product.promoPriceKobo,
    };
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 140) {
        throw new HttpError(422, 'product_name_invalid', 'Product name must be between 2 and 140 characters.');
      }
      next.name = body.name.trim();
    }
    if (body.description !== undefined) {
      if (typeof body.description !== 'string' || body.description.trim().length > 2000) {
        throw new HttpError(422, 'product_description_invalid', 'Description must be 2,000 characters or fewer.');
      }
      next.description = body.description.trim();
    }
    if (body.stock !== undefined) {
      if (body.stock !== null && (!Number.isInteger(body.stock) || body.stock < 0 || body.stock > 100000)) {
        throw new HttpError(422, 'stock_invalid', 'Stock must be a whole number between 0 and 100,000, or null for made-to-order.');
      }
      next.stock = body.stock;
    }
    if (body.priceKobo !== undefined) {
      if (!Number.isInteger(body.priceKobo) || body.priceKobo < 100 || body.priceKobo > 100000000) {
        throw new HttpError(422, 'price_invalid', 'Price must be between ₦1 and ₦1,000,000, in kobo.');
      }
      next.priceKobo = body.priceKobo;
    }
    if (body.promoPriceKobo !== undefined) {
      if (body.promoPriceKobo !== null && (!Number.isInteger(body.promoPriceKobo) || body.promoPriceKobo < 100 || body.promoPriceKobo > 100000000)) {
        throw new HttpError(422, 'promo_invalid', 'Offer price must be valid or null to clear it.');
      }
      next.promoPriceKobo = body.promoPriceKobo;
    }
    if (next.promoPriceKobo !== null && next.promoPriceKobo >= next.priceKobo) {
      throw new HttpError(422, 'promo_invalid', 'Offer price must be lower than the regular price.');
    }

    const updatedAt = new Date().toISOString();
    db.prepare(`INSERT INTO product_overrides
      (product_id, name, description, stock, price_kobo, promo_price_kobo, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_id) DO UPDATE SET
      name = excluded.name, description = excluded.description, stock = excluded.stock,
      price_kobo = excluded.price_kobo, promo_price_kobo = excluded.promo_price_kobo,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(product.id, next.name, next.description, next.stock, next.priceKobo, next.promoPriceKobo, user.id, updatedAt);
    Object.assign(product, next);
    db.prepare('INSERT INTO audit_log (actor_user_id, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, 'catalogue.product_updated', product.id, JSON.stringify({ fields: Object.keys(body) }), updatedAt);
    return { status: 200, body: { product: {
      id: product.id, name: product.name, description: product.description, stock: product.stock,
      priceKobo: product.priceKobo, promoPriceKobo: product.promoPriceKobo,
    } } };
  });

  router.get('/api/admin/overview', (ctx) => {
    requireAdmin(ctx);
    return { status: 200, body: dispatch.adminOverview() };
  });

  router.get('/api/admin/insights', (ctx) => {
    requireAdmin(ctx);
    return { status: 200, body: dispatch.adminInsights() };
  });

  router.get('/api/admin/orders', (ctx) => {
    requireAdmin(ctx);
    return { status: 200, body: { items: dispatch.adminOrders() } };
  });

  router.post('/api/admin/orders/:orderId/assign', (ctx) => {
    const user = requireAdmin(ctx);
    return { status: 200, body: { order: dispatch.assignDelivery(user.id, ctx.params.orderId, ctx.body.riderUserId) } };
  });

  router.get('/api/admin/riders', (ctx) => {
    requireAdmin(ctx);
    return { status: 200, body: { items: dispatch.adminRiders() } };
  });

  router.patch('/api/admin/riders/:userId', (ctx) => {
    const user = requireAdmin(ctx);
    return { status: 200, body: { rider: dispatch.reviewRider(user.id, ctx.params.userId, ctx.body) } };
  });

  router.get('/api/admin/stores', (ctx) => {
    requireAdmin(ctx);
    return { status: 200, body: { items: trust.storesForAdmin() } };
  });

  router.patch('/api/admin/stores/:merchantId', (ctx) => {
    const user = requireAdmin(ctx);
    return { status: 200, body: { store: trust.setStoreVerified(user.id, ctx.params.merchantId, ctx.body.verified) } };
  });

  router.get('/api/admin/support', (ctx) => {
    requireAdmin(ctx);
    return { status: 200, body: { items: support.adminList(ctx.query.status) } };
  });

  router.patch('/api/admin/support/:requestId', (ctx) => {
    const user = requireAdmin(ctx);
    return { status: 200, body: { request: support.respond(user.id, ctx.params.requestId, ctx.body) } };
  });

  router.get('/api/admin/audit', (ctx) => {
    requireAdmin(ctx);
    return { status: 200, body: { items: dispatch.auditLog() } };
  });

  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const { pathname } = url;

      if (!pathname.startsWith('/api/') && pathname !== '/api') {
        if (webRoot) return await serveStatic(req, res, pathname, webRoot);
        return sendJson(res, 404, { error: { code: 'not_found', message: 'No such endpoint.' } });
      }

      const match = router.match(req.method, pathname);
      if (!match.handler) {
        const status = match.pathMatched ? 405 : 404;
        const code = match.pathMatched ? 'method_not_allowed' : 'not_found';
        return sendJson(res, status, { error: { code, message: 'No such endpoint.' } });
      }

      const isWrite = req.method !== 'GET' && req.method !== 'HEAD';

      // Cross-site request protection. Browsers send Origin on cross-site writes; if it names
      // a different host, refuse. Writes must also be JSON, which a plain cross-site form cannot send.
      if (isWrite) {
        const origin = req.headers.origin;
        if (origin && origin !== 'null') {
          let originHost = null;
          try {
            originHost = new URL(origin).host;
          } catch {
            originHost = null;
          }
          if (originHost !== req.headers.host && !allowed.has(origin)) {
            return sendJson(res, 403, { error: { code: 'cross_origin', message: 'Request blocked.' } });
          }
        } else if (origin === 'null') {
          return sendJson(res, 403, { error: { code: 'cross_origin', message: 'Request blocked.' } });
        }
        const hasBody = req.method !== 'DELETE';
        if (hasBody && !String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          return sendJson(res, 415, { error: { code: 'unsupported_media_type', message: 'Send JSON.' } });
        }
      }

      // Every visitor gets a server-issued session id, so the cart lives on the server.
      const cookies = [];
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      let sid = readCookie(req.headers.cookie, SESSION_COOKIE);
      if (!sid || sid.length > 100) {
        sid = store.newSessionId();
        cookies.push(
          `${SESSION_COOKIE}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; ` +
            `Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`,
        );
      }

      // Who is signed in, if anyone. Checked against the database on every request.
      const authToken = readCookie(req.headers.cookie, AUTH_COOKIE);
      const user = authToken ? auth.userForToken(authToken) : null;

      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJsonBody(req);

      const result = await match.handler({
        params: match.params,
        query: Object.fromEntries(url.searchParams),
        body,
        sid,
        user,
        authToken,
        ip: clientAddress(req, trustProxy),
        secure,
      });
      if (result.cookies) cookies.push(...result.cookies);
      return sendJson(res, result.status, result.body, cookies.length ? { 'Set-Cookie': cookies } : {});
    } catch (err) {
      if (err instanceof URIError) {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'The URL is malformed.' } });
      }
      return sendError(res, err);
    }
  };
}
