import * as api from '../api.js';
import { el, linkButton } from '../dom.js';
import { field, formMessage, guardedSubmit } from '../form.js';
import { formatNaira } from '../format.js';
import { stateBox, toast } from '../ui.js';
import { emptyView, formatDate, ORDER_STATUS_LABEL, requireLogin } from './guard.js';

// Button labels for each step a store may take. The server holds the real rules;
// this only decides which buttons to show.
const NEXT_STEPS = {
  placed: [
    { to: 'accepted', label: 'Accept order', primary: true },
    { to: 'rejected', label: 'Reject', primary: false },
  ],
  accepted: [
    { to: 'preparing', label: 'Start preparing', primary: true },
    { to: 'rejected', label: 'Reject', primary: false },
  ],
  preparing: [{ to: 'ready', label: 'Mark ready', primary: true }],
};

export async function renderMerchantHome() {
  const user = await requireLogin();
  if (!user) return emptyView();
  document.title = 'Store dashboard · Shop n Delight';

  const { items } = await api.get('/api/merchant/memberships');
  if (items.length) {
    // Go straight to the first store. Staff with several stores can switch from the header.
    window.location.replace(`#/merchant/${encodeURIComponent(items[0].id)}`);
    return emptyView();
  }
  return claimPage();
}

function claimPage() {
  const merchantSelect = el('select', { class: 'select', id: 'claim-store', name: 'merchantId', required: true },
    el('option', { value: '', text: 'Choose your store', disabled: true, selected: true }),
    // Store ids come from the public catalogue, so the list needs no extra request.
    [
      ['m-sample-kitchen', 'Sample Kitchen (demo)'],
      ['m-sample-market', 'Sample Market (demo)'],
      ['m-sample-tech', 'Sample Tech Store (demo)'],
    ].map(([value, text]) => el('option', { value, text })),
  );
  const code = field({ name: 'code', label: 'Store access code', autocomplete: 'off', hint: 'Issued to your store by Shop n Delight. Ask the team if you don’t have one.' });
  const message = formMessage();
  const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--block', text: 'Connect store' });
  const form = el(
    'form',
    { class: 'form', novalidate: true },
    el('div', { class: 'field' }, el('label', { for: 'claim-store', text: 'Store' }), merchantSelect),
    code.node,
    message.node,
    submit,
  );

  guardedSubmit(form, submit, 'Connecting…', async () => {
    code.setError('');
    message.show('');
    if (!merchantSelect.value) return message.show('Choose your store.');
    if (!code.value) return code.setError('Enter the access code.'), code.input.focus();
    try {
      await api.post('/api/merchant/claim', { merchantId: merchantSelect.value, code: code.value });
      toast('Store connected');
      window.location.hash = `#/merchant/${encodeURIComponent(merchantSelect.value)}`;
    } catch (err) {
      if (err.code === 'claim_invalid') code.setError(err.message);
      else message.show(err.message);
    }
  });

  return el(
    'div',
    { class: 'container auth' },
    el(
      'div',
      { class: 'auth__card' },
      el('h1', { text: 'Connect your store' }),
      el('p', { class: 'muted', text: 'Enter the store and access code you were given to see your orders and manage stock.' }),
      form,
      el('p', { class: 'auth__links' }, linkButton({ href: '#/account', text: 'Back to your account', variant: 'ghost', small: true })),
    ),
  );
}

export async function renderMerchantDashboard({ params }) {
  const user = await requireLogin();
  if (!user) return emptyView();

  const merchantId = params.id;
  let memberships;
  try {
    ({ items: memberships } = await api.get('/api/merchant/memberships'));
  } catch (err) {
    return stateBox({ tone: 'error', title: 'Couldn’t load your stores', body: err.message });
  }
  const store = memberships.find((m) => m.id === merchantId);
  if (!store) {
    return el('div', { class: 'container section--tight' }, stateBox({
      title: 'You don’t have access to this store',
      body: 'Connect the store with its access code first.',
      actions: [linkButton({ href: '#/merchant', text: 'Connect a store' })],
      iconName: 'shop',
    }));
  }
  document.title = `${store.name} · Shop n Delight`;

  const summaryBox = el('div', { class: 'merchant-summary', 'aria-live': 'polite' });
  const ordersBox = el('div', { 'aria-busy': 'true' }, el('p', { class: 'muted', text: 'Loading orders…' }));
  const productsBox = el('div', { 'aria-busy': 'true' }, el('p', { class: 'muted', text: 'Loading products…' }));

  async function loadOrders() {
    try {
      const { items, summary } = await api.get(`/api/merchant/${encodeURIComponent(merchantId)}/orders`);
      summaryBox.replaceChildren(...summaryRows(summary));
      ordersBox.replaceChildren(
        items.length ? el('ul', { class: 'order-list' }, items.map((o) => orderCard(o, merchantId, loadOrders))) :
          stateBox({ title: 'No orders yet', body: 'New orders from customers will appear here.', iconName: 'receipt' }),
      );
    } catch (err) {
      ordersBox.replaceChildren(stateBox({ tone: 'error', title: 'Couldn’t load orders', body: err.message, actions: [linkButton({ text: 'Try again', variant: 'secondary', small: true, onClick: loadOrders })] }));
    } finally {
      ordersBox.removeAttribute('aria-busy');
    }
  }

  async function loadProducts() {
    try {
      const { items } = await api.get(`/api/merchant/${encodeURIComponent(merchantId)}/products`);
      productsBox.replaceChildren(
        el('div', { class: 'product-table' }, items.map((p) => productRow(p, merchantId))),
      );
    } catch (err) {
      productsBox.replaceChildren(stateBox({ tone: 'error', title: 'Couldn’t load products', body: err.message }));
    } finally {
      productsBox.removeAttribute('aria-busy');
    }
  }

  loadOrders();
  loadProducts();

  const switcher = memberships.length > 1
    ? el('label', { class: 'merchant-switch' }, el('span', { class: 'visually-hidden', text: 'Choose store' }),
        el('select', { class: 'select', onchange: (e) => (window.location.hash = `#/merchant/${encodeURIComponent(e.target.value)}`) },
          memberships.map((m) => el('option', { value: m.id, text: m.name, selected: m.id === merchantId }))))
    : null;

  return el(
    'div',
    { class: 'container section--tight' },
    el('div', { class: 'section__head' }, el('div', {}, el('h1', { tabindex: '-1', text: store.name }), el('p', { text: 'Orders and stock for your store' })), switcher),
    summaryBox,
    el('section', { class: 'merchant-block', 'aria-labelledby': 'm-orders' }, el('h2', { id: 'm-orders', text: 'Orders' }), ordersBox),
    el('section', { class: 'merchant-block', 'aria-labelledby': 'm-products' }, el('h2', { id: 'm-products', text: 'Products and stock' }),
      el('p', { class: 'muted', text: 'Leave stock empty for made-to-order items. Prices are in naira.' }), productsBox),
  );
}

function summaryRows(summary) {
  const rows = [
    ['Orders, all time', String(summary.allTime.orders)],
    ['Value, all time', formatNaira(summary.allTime.valueKobo)],
    ['Orders, last 7 days', String(summary.last7Days.orders)],
    ['Value, last 7 days', formatNaira(summary.last7Days.valueKobo)],
  ];
  return rows.map(([label, value]) => el('div', { class: 'merchant-stat' }, el('span', { class: 'muted', text: label }), el('strong', { text: value })));
}

function orderCard(order, merchantId, reload) {
  const steps = NEXT_STEPS[order.status] ?? [];
  const busyGuard = { busy: false };

  const actions = steps.map((step) => {
    const button = el('button', {
      type: 'button',
      class: `btn btn--small ${step.primary ? 'btn--primary' : 'btn--secondary'}`,
      text: step.label,
      onclick: async (event) => {
        if (busyGuard.busy) return;
        if (step.to === 'rejected' && !window.confirm(`Reject order ${order.id}? The items go back into stock.`)) return;
        busyGuard.busy = true;
        event.currentTarget.disabled = true;
        try {
          await api.patch(`/api/merchant/${encodeURIComponent(merchantId)}/orders/${encodeURIComponent(order.id)}`, { status: step.to });
          toast(`Order ${order.id} ${ORDER_STATUS_LABEL[step.to] ? ORDER_STATUS_LABEL[step.to].toLowerCase() : step.to}`);
          await reload();
        } catch (err) {
          toast(err.message, { tone: 'error' });
          busyGuard.busy = false;
          event.currentTarget.disabled = false;
          if (err.code === 'status_changed' || err.code === 'invalid_transition') await reload();
        }
      },
    });
    return button;
  });

  const d = order.delivery;
  const count = order.items.reduce((n, i) => n + i.quantity, 0);
  return el(
    'li',
    { class: 'order-card' },
    el('div', { class: 'order-card__head' },
      el('strong', { text: order.id }),
      el('span', { class: 'badge', text: ORDER_STATUS_LABEL[order.status] ?? order.status }),
    ),
    el('p', { class: 'muted', text: `${formatDate(order.createdAt)} · ${count} ${count === 1 ? 'item' : 'items'} · ${formatNaira(order.totalKobo)}` }),
    el('ul', { class: 'order-card__items' }, order.items.map((i) => {
      const options = Object.values(i.variantChoice).join(', ');
      return el('li', { text: `${i.quantity} × ${i.name}${options ? ` (${options})` : ''}` });
    })),
    el('p', { class: 'order-card__delivery' }, el('strong', { text: d.name }), ` · ${d.phone}`, el('br'), `${d.address}, ${d.area}`, d.notes ? el('br') : null, d.notes ? `Note: ${d.notes}` : null),
    steps.length
      ? el('div', { class: 'order-card__actions' }, actions)
      : order.status === 'ready'
        ? el('p', { class: 'muted', text: 'Ready. Shop n Delight dispatch assigns a rider, who collects the order from you.' })
        : null,
  );
}

function productRow(product, merchantId) {
  const stock = field({ name: 'stock', label: 'Stock', type: 'number', value: product.stock === null ? '' : String(product.stock), required: false, inputmode: 'numeric' });
  stock.input.min = '0';
  stock.input.step = '1';
  const price = field({ name: 'price', label: 'Price (₦)', type: 'number', value: String(product.priceKobo / 100), inputmode: 'decimal' });
  price.input.min = '1';
  price.input.step = '0.01';
  const offer = field({ name: 'offer', label: 'Offer price (₦)', type: 'number', value: product.promoPriceKobo === null ? '' : String(product.promoPriceKobo / 100), required: false, inputmode: 'decimal' });
  offer.input.min = '1';
  offer.input.step = '0.01';
  const message = formMessage();
  const save = el('button', { type: 'submit', class: 'btn btn--primary btn--small', text: 'Save' });
  const form = el('form', { class: 'product-row', novalidate: true, 'aria-label': `${product.name} stock and prices` },
    el('div', { class: 'product-row__name' }, el('strong', { text: product.name }), product.variants.length ? el('span', { class: 'muted', text: 'Has options' }) : null),
    el('div', { class: 'product-row__fields' }, stock.node, price.node, offer.node),
    message.node,
    el('div', { class: 'product-row__save' }, save),
  );

  guardedSubmit(form, save, 'Saving…', async () => {
    message.show('');
    [stock, price, offer].forEach((f) => f.setError(''));
    const body = {};
    const stockText = stock.input.value.trim();
    body.stock = stockText === '' ? null : Number(stockText);
    body.priceKobo = Math.round(Number(price.input.value) * 100);
    const offerText = offer.input.value.trim();
    body.promoPriceKobo = offerText === '' ? null : Math.round(Number(offerText) * 100);
    try {
      const res = await api.patch(`/api/merchant/${encodeURIComponent(merchantId)}/products/${encodeURIComponent(product.id)}`, body);
      stock.input.value = res.product.stock === null ? '' : String(res.product.stock);
      price.input.value = String(res.product.priceKobo / 100);
      offer.input.value = res.product.promoPriceKobo === null ? '' : String(res.product.promoPriceKobo / 100);
      toast(`${product.name} saved`);
    } catch (err) {
      if (err.code === 'stock_invalid') stock.setError(err.message);
      else if (err.code === 'price_invalid') price.setError(err.message);
      else if (err.code === 'promo_invalid') offer.setError(err.message);
      else message.show(err.message);
    }
  });

  return form;
}
