import * as api from '../api.js';
import { checkoutHref, shopHref } from '../sections.js';
import { el, icon, linkButton } from '../dom.js';
import { field, formMessage } from '../form.js';
import { formatNaira } from '../format.js';
import { setCart } from '../state.js';
import { stateBox, toast } from '../ui.js';
import { emptyView, requireLogin } from './guard.js';
import { whatsappOrderUrl } from '../whatsapp.js';

// Server error codes that belong to a specific form field.
const FIELD_FOR_CODE = { name_invalid: 'name', phone_invalid: 'phone', address_invalid: 'address', notes_invalid: 'notes' };

// Codes that mean the cart itself needs attention, so the way forward is back to the cart.
const CART_CODES = new Set(['out_of_stock', 'insufficient_stock', 'cart_empty', 'product_not_found', 'area_required', 'area_not_served', 'merchant_conflict']);

let activeSection = 'shop';

export async function renderCheckout({ section = 'shop' } = {}) {
  activeSection = section;
  const user = await requireLogin();
  if (!user) return emptyView();
  document.title = 'Checkout · Shop n Delight';

  const cart = setCart(await api.get('/api/cart'));

  if (!cart.lines.length) {
    return el('div', { class: 'container section--tight checkout' }, stateBox({
      title: 'Your cart is empty',
      body: 'Add something first, then come back to check out.',
      actions: [linkButton({ href: shopHref(activeSection), text: 'Browse the shop' })],
      iconName: 'cart',
    }));
  }
  if (cart.deliveryAreaRequired) {
    return el('div', { class: 'container section--tight checkout' }, stateBox({
      title: 'Choose a delivery area first',
      body: 'We need to know where to deliver so we can confirm the store reaches you and add the right delivery fee.',
      actions: [linkButton({ href: '#/cart', text: 'Go to cart' })],
      iconName: 'pin',
    }));
  }

  // One key per checkout screen. Retrying a failed or slow submission reuses it, so the server
  // returns the same order instead of creating a second one.
  const idempotencyKey = crypto.randomUUID();

  const fields = {
    name: field({ name: 'name', label: 'Full name', autocomplete: 'name', value: user.fullName, maxlength: 100 }),
    phone: field({
      name: 'phone',
      label: 'Phone number',
      type: 'tel',
      autocomplete: 'tel',
      inputmode: 'tel',
      value: user.phone ?? '',
      hint: 'The rider will call this number. Nigerian mobile, for example 0803 123 4567.',
    }),
    address: field({
      name: 'address',
      label: 'Delivery address',
      autocomplete: 'street-address',
      rows: 3,
      maxlength: 300,
      hint: `House number, street and landmark in ${cart.deliveryArea}.`,
    }),
    notes: field({ name: 'notes', label: 'Note for the rider', required: false, maxlength: 300, rows: 2 }),
  };

  const message = formMessage();
  const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--block', text: `Place order · ${formatNaira(cart.totalKobo)}` });
  const label = submit.textContent;
  const form = el(
    'form',
    { class: 'form', novalidate: true, 'aria-labelledby': 'checkout-title' },
    el('div', { class: 'checkout-area' }, icon('pin'), el('span', {}, 'Delivering to ', el('strong', { text: `${cart.deliveryArea}` }), ` · ${cart.merchantName}`)),
    fields.name.node,
    fields.phone.node,
    fields.address.node,
    fields.notes.node,
    paymentChoice(),
    message.node,
    submit,
    el('p', { class: 'summary__note', text: 'You pay the rider in cash when your order arrives. No card or online payment is taken in this build.' }),
  );

  let busy = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;

    for (const f of Object.values(fields)) f.setError('');
    message.show('');
    if (!fields.name.value) return fields.name.setError('Enter your full name.'), fields.name.input.focus();
    if (!fields.phone.value) return fields.phone.setError('Enter a phone number.'), fields.phone.input.focus();
    if (fields.address.value.length < 5) return fields.address.setError('Enter your delivery address.'), fields.address.input.focus();

    busy = true;
    submit.disabled = true;
    submit.replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Placing order…');

    try {
      const res = await api.post('/api/orders', {
        idempotencyKey,
        paymentMethod: 'cash_on_delivery',
        delivery: {
          name: fields.name.value,
          phone: fields.phone.value,
          address: fields.address.value,
          notes: fields.notes.value,
        },
      });
      // The server emptied the cart. Mirror that so the badge is right.
      setCart({ ...cart, lines: [], itemCount: 0, subtotalKobo: 0, deliveryFeeKobo: 0, totalKobo: 0, merchantId: null });
      toast('Order placed');
      // Once the order is saved, hand the customer to WhatsApp with the order details filled in.
      const whatsapp = whatsappOrderUrl(res.order);
      if (whatsapp) {
        window.location.href = whatsapp;
        return;
      }
      window.location.hash = `#/order/${encodeURIComponent(res.order.id)}`;
    } catch (err) {
      busy = false;
      submit.disabled = false;
      submit.textContent = label;

      if (err.code === 'auth_required') {
        window.location.hash = `#/login?next=${encodeURIComponent(checkoutHref(activeSection))}`;
        return;
      }
      const key = FIELD_FOR_CODE[err.code];
      if (key) {
        fields[key].setError(err.message);
        fields[key].input.focus();
      } else if (CART_CODES.has(err.code)) {
        message.show(`${err.message} Please review your cart.`);
      } else if (err.code === 'network' || err.code === 'timeout') {
        // The first request may have succeeded. Retrying with the same key is safe: it can only ever return that one order.
        message.show(`${err.message} It is safe to try again. You will not be charged twice.`);
      } else {
        message.show(err.message);
      }
    }
  });

  return el(
    'div',
    { class: 'container checkout' },
    el('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' }, el('ol', {}, el('li', {}, el('a', { href: '#/cart', text: 'Cart' })), el('li', { text: 'Checkout' }))),
    el('h1', { id: 'checkout-title', tabindex: '-1', text: 'Checkout' }),
    el('div', { class: 'cart-layout' }, form, summary(cart)),
  );
}

function paymentChoice() {
  return el(
    'fieldset',
    { class: 'payment' },
    el('legend', { text: 'Payment' }),
    el(
      'label',
      { class: 'payment__option payment__option--selected' },
      el('input', { type: 'radio', name: 'payment', value: 'cash_on_delivery', checked: true }),
      el('span', {}, el('strong', { text: 'Cash on delivery' }), el('span', { class: 'muted', text: 'Pay the rider when your order arrives.' })),
    ),
    el(
      'label',
      { class: 'payment__option payment__option--disabled' },
      el('input', { type: 'radio', name: 'payment', value: 'online', disabled: true }),
      el('span', {}, el('strong', { text: 'Pay online' }), el('span', { class: 'muted', text: 'Not available yet.' })),
    ),
  );
}

function summary(cart) {
  return el(
    'aside',
    { class: 'summary', 'aria-labelledby': 'co-summary-title' },
    el('h2', { id: 'co-summary-title', text: 'Your order' }),
    el(
      'ul',
      { class: 'summary__lines' },
      cart.lines.map((l) =>
        el('li', { class: 'summary__row' }, el('span', { text: `${l.quantity} × ${l.name}${Object.values(l.variantChoice).length ? ` (${Object.values(l.variantChoice).join(', ')})` : ''}` }), el('span', { text: formatNaira(l.lineKobo) })),
      ),
    ),
    el('div', { class: 'summary__row' }, el('span', { text: 'Subtotal' }), el('span', { text: formatNaira(cart.subtotalKobo) })),
    el('div', { class: 'summary__row' }, el('span', { text: 'Delivery' }), el('span', { text: formatNaira(cart.deliveryFeeKobo) })),
    el('div', { class: 'summary__row summary__row--total' }, el('span', { text: 'Total to pay' }), el('span', { text: formatNaira(cart.totalKobo) })),
    el('p', { class: 'summary__note', text: 'The server checks prices and stock again when you place the order. If anything changed, you’ll be told before anything is created.' }),
  );
}
