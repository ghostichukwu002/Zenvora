import { checkoutHref, productHref, sectionOf } from './sections.js';
import * as api from './api.js';
import { el, icon } from './dom.js';
import { AVAILABILITY_LABEL, formatNaira } from './format.js';
import { setCart } from './state.js';
import { toast } from './ui.js';

// Icon per category. The server does not send glyphs on product payloads, so the mapping lives here.
export const CATEGORY_GLYPH = {
  food: 'bowl',
  groceries: 'basket',
  fashion: 'shirt',
  electronics: 'plug',
  beauty: 'drop',
  home: 'lamp',
  books: 'book',
  essentials: 'box',
};

export function categoryGlyph(id) {
  return CATEGORY_GLYPH[id] ?? 'box';
}

// Read an optional image field when the existing product payload provides one.
// No API contract is changed; products without a photo keep the category fallback.
export function productImageUrl(product) {
  const candidate = product.imageUrl ?? product.imageURL ?? product.photoUrl ?? product.thumbnailUrl ?? product.image
    ?? (Array.isArray(product.images) ? product.images[0] : '');
  if (typeof candidate === 'string') return candidate.trim();
  if (candidate && typeof candidate === 'object') return String(candidate.url ?? candidate.secure_url ?? '').trim();
  return '';
}

// Adds one line to the server cart. Returns the priced cart.
// Errors bubble up to the caller, which decides how to show them.
export async function addToCart({ productId, variantChoice = {}, quantity = 1 }) {
  const cart = await api.post('/api/cart/items', { productId, variantChoice, quantity });
  return setCart(cart);
}

// Quick add for simple products (no variants to choose). Guards against double taps.
function quickAddButton(product) {
  const button = el(
    'button',
    {
      type: 'button',
      class: 'btn btn--primary btn--small',
      'aria-label': `Add ${product.name} to cart`,
    },
    'Add',
  );

  button.addEventListener('click', async () => {
    if (button.dataset.busy === 'true') return;
    button.dataset.busy = 'true';
    button.disabled = true;
    const original = button.textContent;
    button.replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }));

    try {
      await addToCart({ productId: product.id, quantity: 1 });
      button.replaceChildren(icon('check', 'icon'), 'Added');
      button.classList.add('btn--added');
      toast(`${product.name} added to your cart`, { linkHref: checkoutHref(sectionOf(product)), linkText: 'Checkout' });
      setTimeout(() => {
        button.classList.remove('btn--added');
        button.textContent = original;
        button.disabled = false;
        button.dataset.busy = 'false';
      }, 1600);
    } catch (err) {
      button.textContent = original;
      button.disabled = false;
      button.dataset.busy = 'false';
      toast(err.message, { tone: 'error' });
    }
  });

  return button;
}

export function productCard(product, { reveal = true } = {}) {
  const onOffer = product.promoPriceKobo !== null;
  const unavailable = product.availability === 'out_of_stock';
  const hasOptions = product.variants.length > 0;

  let action;
  if (unavailable) {
    action = el('button', { type: 'button', class: 'btn btn--secondary btn--small', disabled: true }, 'Unavailable');
  } else if (hasOptions) {
    action = el(
      'a',
      { class: 'btn btn--secondary btn--small', href: productHref(product.id, sectionOf(product)) },
      'Choose options',
    );
  } else {
    action = quickAddButton(product);
  }

  const imageUrl = productImageUrl(product);
  const media = el(
    'div',
    { class: 'product-card__media' },
    imageUrl
      ? el('img', { src: imageUrl, alt: product.name, loading: 'lazy', decoding: 'async', onerror: (event) => { event.currentTarget.replaceWith(icon(categoryGlyph(product.category.id), 'icon')); } })
      : icon(categoryGlyph(product.category.id), 'icon'),
    onOffer ? el('span', { class: 'product-card__badge', text: 'Offer' }) : null,
  );

  return el(
    'article',
    { class: 'product-card', 'data-reveal': reveal ? '' : undefined },
    media,
    el(
      'div',
      { class: 'product-card__body' },
      el('span', { class: 'product-card__merchant', text: product.merchant.name }),
      el(
        'h3',
        { class: 'product-card__name' },
        el('a', { href: productHref(product.id, sectionOf(product)), text: product.name }),
      ),
      el(
        'div',
        { class: 'product-card__price-row' },
        el('span', { class: 'price', text: formatNaira(product.effectivePriceKobo) }),
        onOffer ? el('span', { class: 'price--was', text: formatNaira(product.priceKobo) }) : null,
      ),
    ),
    el(
      'div',
      { class: 'product-card__footer purchase__row' },
      el('span', {
        class: `availability availability--${product.availability}`,
        text: AVAILABILITY_LABEL[product.availability],
      }),
      action,
    ),
  );
}

export function categoryTile(category, index = 0) {
  const count = category.productCount ?? 0;
  return el(
    'a',
    {
      class: 'category-tile',
      href: `#/shop?category=${encodeURIComponent(category.id)}`,
      'data-reveal': '',
      dataset: { index: String(index) },
    },
    el('span', { class: 'category-tile__icon' }, icon(categoryGlyph(category.id), 'icon')),
    el('span', { text: category.name }),
    el('span', {
      class: 'muted',
      text: count > 0 ? `${count} ${count === 1 ? 'item' : 'items'}` : 'Coming soon',
    }),
  );
}

// Trust badges. "store" and "rider" mean an administrator verified them; "admin" marks Shop n Delight staff.
const TRUST_LABEL = { store: 'Verified store', rider: 'Verified rider', admin: 'Shop n Delight admin' };
export function trustBadge(kind) {
  return el(
    'span',
    { class: `trust-badge trust-badge--${kind}`, title: kind === 'admin' ? 'Works for Shop n Delight' : 'Checked by Shop n Delight' },
    icon('check'),
    TRUST_LABEL[kind],
  );
}
