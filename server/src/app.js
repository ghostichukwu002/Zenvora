import {
  addItem,
  CartError,
  priceCart,
  removeItem,
  setDeliveryArea,
  updateQuantity,
} from './cart.js';
import { createCartStore, readCookie, SESSION_COOKIE } from './cart-store.js';
import { createRouter, readJsonBody, sendError, sendJson } from './router.js';
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

// Builds the request handler. Pass it to http.createServer().
// webRoot is optional. When given, non-API paths serve the browser app from that folder.
export function createApp({ catalogue, store = createCartStore(), webRoot = null }) {
  const router = createRouter();

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

      // Every visitor gets a server-issued session id, so the cart lives on the server.
      let sid = readCookie(req.headers.cookie, SESSION_COOKIE);
      const headers = {};
      if (!sid || sid.length > 100) {
        sid = store.newSessionId();
        const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
        headers['Set-Cookie'] =
          `${SESSION_COOKIE}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; ` +
          `Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`;
      }

      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJsonBody(req);

      const result = await match.handler({
        params: match.params,
        query: Object.fromEntries(url.searchParams),
        body,
        sid,
      });
      return sendJson(res, result.status, result.body, headers);
    } catch (err) {
      if (err instanceof URIError) {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'The URL is malformed.' } });
      }
      return sendError(res, err);
    }
  };
}
