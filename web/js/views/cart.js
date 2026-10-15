import { checkoutHref, productHref } from '../sections.js';
import * as api from '../api.js';
import { el, icon, linkButton, setMain } from '../dom.js';
import { formatNaira } from '../format.js';
import { setCart } from '../state.js';
import { stateBox, toast } from '../ui.js';

const MAX_QUANTITY = 20;

let busy = false;

// Keys from a server cart line look like "p-jollof-combo|portion=Large". Shown to users as "Portion: Large".
function variantLabel(choice) {
  return Object.entries(choice)
    .map(([key, value]) => `${key.charAt(0).toUpperCase()}${key.slice(1)}: ${value}`)
    .join(' · ');
}

export async function renderCart() {
  const cart = setCart(await api.get('/api/cart'));
  document.title = 'Your cart · Shop n Delight';
  return cartView(cart);
}

// Runs one cart change at a time. The server returns the new cart, and the page redraws from it.
async function mutate(request, focusKey) {
  if (busy) return;
  busy = true;
  for (const control of document.querySelectorAll('#app button, #app select')) control.disabled = true;

  try {
    const next = setCart(await request());
    setMain(cartView(next));
    if (focusKey) {
      const target = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      if (target && !target.disabled) target.focus();
      else document.querySelector('#app h1')?.focus();
    }
  } catch (err) {
    toast(err.message, { tone: 'error' });
    for (const control of document.querySelectorAll('#app button, #app select')) control.disabled = false;
  } finally {
    busy = false;
  }
}

function lineNode(line) {
  const decrease = el('button', {
    type: 'button',
    'aria-label': `Decrease ${line.name} quantity`,
    'data-focus-key': `${line.key}:dec`,
    disabled: line.quantity <= 1,
    text: '−',
    onclick: () => mutate(() => api.patch(`/api/cart/items/${encodeURIComponent(line.key)}`, { quantity: line.quantity - 1 }), `${line.key}:dec`),
  });
  const increase = el('button', {
    type: 'button',
    'aria-label': `Increase ${line.name} quantity`,
    'data-focus-key': `${line.key}:inc`,
    disabled: line.quantity >= MAX_QUANTITY,
    text: '+',
    onclick: () => mutate(() => api.patch(`/api/cart/items/${encodeURIComponent(line.key)}`, { quantity: line.quantity + 1 }), `${line.key}:inc`),
  });
  const remove = el('button', {
    type: 'button',
    class: 'btn btn--ghost btn--small',
    'aria-label': `Remove ${line.name} from cart`,
    'data-focus-key': `${line.key}:remove`,
    onclick: () => mutate(() => api.del(`/api/cart/items/${encodeURIComponent(line.key)}`), null),
  });
  remove.append(icon('trash'), el('span', { text: 'Remove' }));

  const variants = variantLabel(line.variantChoice);

  return el(
    'article',
    { class: 'cart-line' },
    el('div', { class: 'cart-line__thumb' }, icon('box')),
    el(
      'div',
      {},
      el('a', { class: 'cart-line__name', href: productHref(line.productId, line.section), text: line.name }),
      el('div', { class: 'cart-line__meta' }, [
        variants || null,
        line.onPromotion ? 'On offer' : null,
        `${formatNaira(line.unitKobo)} each`,
      ].filter(Boolean).join(' · ')),
      line.stockWarning
        ? el('p', { class: 'field-error', role: 'alert', text: 'Stock has changed. Please lower the quantity.' })
        : null,
      el(
        'div',
        { class: 'cart-line__controls' },
        el('div', { class: 'stepper' }, decrease, el('output', { 'aria-live': 'polite', text: String(line.quantity) }), increase),
        remove,
      ),
    ),
    el('div', { class: 'cart-line__total', text: formatNaira(line.lineKobo) }),
  );
}

// Checkout is offered only when the cart can actually be ordered. The server re-checks everything anyway.
function checkoutAction(cart) {
  if (cart.deliveryAreaRequired) {
    return el('button', { type: 'button', class: 'btn btn--primary btn--block', disabled: true, text: 'Choose a delivery area to continue' });
  }
  if (cart.lines.some((l) => l.stockWarning)) {
    return el('button', { type: 'button', class: 'btn btn--primary btn--block', disabled: true, text: 'Fix stock issues to continue' });
  }
  return el('a', { class: 'btn btn--primary btn--block', href: checkoutHref(cart.section), text: 'Checkout' });
}

function summaryNode(cart) {
  const areaSelect = el(
    'select',
    {
      id: 'cart-area',
      class: 'select',
      'data-focus-key': 'cart-area',
      onchange: (event) => {
        const area = event.target.value;
        mutate(() => api.put('/api/cart/delivery-area', { area }), 'cart-area');
      },
    },
    el('option', { value: '', text: 'Choose an area', disabled: true, selected: !cart.deliveryArea }),
    cart.merchantServiceAreas.map((name) =>
      el('option', { value: name, text: name, selected: name === cart.deliveryArea }),
    ),
  );

  const deliveryValue = cart.deliveryAreaRequired
    ? el('span', { class: 'muted', text: 'Choose an area' })
    : el('span', { text: formatNaira(cart.deliveryFeeKobo) });

  return el(
    'aside',
    { class: 'summary', 'aria-labelledby': 'summary-title' },
    el('h2', { id: 'summary-title', text: 'Order summary' }),
    el('div', { class: 'field' }, el('label', { for: 'cart-area', text: 'Delivery area' }), areaSelect),
    el('div', { class: 'summary__row' }, el('span', { text: `Subtotal (${cart.itemCount} ${cart.itemCount === 1 ? 'item' : 'items'})` }), el('span', { text: formatNaira(cart.subtotalKobo) })),
    el('div', { class: 'summary__row' }, el('span', { text: 'Delivery' }), deliveryValue),
    el('div', { class: 'summary__row summary__row--total' }, el('span', { text: 'Total' }), el('span', { text: formatNaira(cart.totalKobo) })),
    checkoutAction(cart),
    el(
      'p',
      { class: 'summary__note' },
      'You’ll pay cash on delivery. Prices, stock and delivery fees are checked again on our servers when you place the order.',
    ),
  );
}

function cartView(cart) {
  if (!cart.lines.length) {
    return el(
      'div',
      { class: 'container section--tight' },
      el('h1', { tabindex: '-1', text: 'Your cart' }),
      stateBox({
        title: 'Your cart is empty',
        body: 'Add something from the shop and it will appear here.',
        actions: [linkButton({ href: '#/shop', text: 'Browse the shop' })],
        iconName: 'cart',
      }),
    );
  }

  const clear = el('button', {
    type: 'button',
    class: 'btn btn--secondary btn--small',
    text: 'Clear cart',
    onclick: () => mutate(() => api.del('/api/cart'), null),
  });

  return el(
    'div',
    { class: 'container' },
    el(
      'nav',
      { class: 'breadcrumb', 'aria-label': 'Breadcrumb' },
      el('ol', {}, el('li', {}, el('a', { href: '#/', text: 'Home' })), el('li', { text: 'Cart' })),
    ),
    el('h1', { tabindex: '-1', text: 'Your cart' }),
    el(
      'div',
      { class: 'merchant-banner section--tight' },
      el('span', {}, 'From ', el('strong', { text: cart.merchantName })),
      clear,
    ),
    el(
      'div',
      { class: 'cart-layout' },
      el('div', { class: 'cart-lines' }, cart.lines.map(lineNode)),
      summaryNode(cart),
    ),
  );
}
