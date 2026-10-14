import { AUTH_COOKIE, createAuth, createRateLimiter, publicUser } from './auth.js';
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

function listProducts(query, catalogue) {
  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase().slice(0, 100) : '';
  const category = typeof query.category === 'string' ? query.category : null;
  const merchant = typeof query.merchant === 'string' ? query.merchant : null;
  const sort = ['newest', 'price-asc', 'price-desc'].includes(query.sort) ? query.sort : 'newest';
  const area = typeof query.area === 'string' ? query.area.slice(0, 100) : null;
  const promoOnly = query.promo === '1';
  const limit = parseIntParam(query.limit, 12, 1, 50);
  const offset = parseIntParam(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  let results = catalogue.products.map((p) => serializeProduct(p, catalogue));

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
}) {
  const allowed = new Set(allowedOrigins);
  const router = createRouter();
  const auth = createAuth(db, { sendResetEmail, adminEmails });
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
  const orders = createOrders(db);
  const merchantAccess = createMerchantAccess(db, { claimCodes: merchantClaimCodes });
  const dispatch = createDispatch(db, { catalogue });
  const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: rateLimits.authMax ?? 30 });
  const loginEmailLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: rateLimits.loginPerEmailMax ?? 8 });

  router.get('/api/health', () => ({ status: 200, body: { ok: true } }));

  router.get('/api/categories', (ctx) => {
    const counts = new Map();
    for (const p of catalogue.products) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    return {
      status: 200,
      body: {
        items: catalogue.categories.map((c) => ({ ...c, productCount: counts.get(c.id) ?? 0 })),
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
    return { status: 200, body: { order: orders.get(user.id, ctx.params.id) } };
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

  // ---------- Administration ----------
  // Admin access is checked here on the server, for every route. Admin accounts are granted
  // from the command line (server/scripts/grant-role.js), never by sign-up or a hardcoded login.

  const requireAdmin = (ctx) => {
    const user = requireUser(ctx);
    if (user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only administrators can do that.');
    return user;
  };

  router.get('/api/admin/overview', (ctx) => {
    requireAdmin(ctx);
    return { status: 200, body: dispatch.adminOverview() };
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
