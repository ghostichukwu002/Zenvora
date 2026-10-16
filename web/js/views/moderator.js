import * as api from '../api.js';
import { el, linkButton } from '../dom.js';
import { ensureUser } from '../state.js';
import { stateBox } from '../ui.js';

const STORES = [
  { id: 'shop', name: 'Shop n Delight', short: 'Everyday essentials', accent: 'orange', mark: 'S' },
  { id: 'puff', name: 'Puff & Sip', short: 'Lifestyle & accessories', accent: 'blue', mark: 'P' },
];

const moneyToKobo = (value) => Math.round(Number(value) * 100);
const moneyInput = (kobo) => Number.isInteger(kobo) ? (kobo / 100).toFixed(2).replace(/\.00$/, '') : '';
const input = (label, value, options = {}) => {
  const id = `mod-${Math.random().toString(36).slice(2, 10)}`;
  const field = el('div', { class: `field moderator-field ${options.wide ? 'moderator-field--wide' : ''}` });
  field.append(el('label', { for: id, text: label }));
  const control = options.multiline
    ? el('textarea', { id, class: 'input moderator-input', rows: 3, maxlength: options.maxlength || 2000, text: value ?? '' })
    : el('input', { id, class: 'input moderator-input', type: options.type || 'text', value: value ?? '', min: options.min, max: options.max, step: options.step, placeholder: options.placeholder, inputmode: options.inputmode });
  if (options.required) control.required = true;
  field.append(control);
  if (options.hint) field.append(el('small', { class: 'moderator-hint', text: options.hint }));
  return { field, control };
};

function storePill(store, selected, onClick) {
  return el('button', {
    type: 'button',
    class: `moderator-store ${store.accent === 'blue' ? 'moderator-store--blue' : ''} ${selected ? 'is-active' : ''}`,
    'aria-pressed': String(selected),
    onclick: onClick,
  },
  el('span', { class: 'moderator-store__mark', text: store.mark }),
  el('span', { class: 'moderator-store__copy' },
    el('strong', { text: store.name }),
    el('small', { text: store.short })),
  el('span', { class: 'moderator-store__arrow', 'aria-hidden': 'true', text: selected ? '✓' : '↗' }));
}

export async function renderModerator() {
  const user = await ensureUser();
  if (!user) {
    const here = window.location.hash || '#/moderator';
    window.location.hash = `#/login?next=${encodeURIComponent(here)}`;
    return el('div');
  }

  if (!['moderator', 'admin'].includes(user.role)) {
    return el('section', { class: 'container section moderator-denied' },
      stateBox({
        title: 'Staff access only',
        body: 'This workspace is reserved for approved Zenvora moderators. Your account does not have catalogue-editing access.',
        iconName: 'shield',
        actions: [linkButton({ href: '#/account', text: 'Back to your account', variant: 'secondary' })],
      }));
  }

  let section = 'shop';
  let products = [];
  let loading = false;
  let requestId = 0;
  const root = el('section', { class: 'container moderator section' });
  const notice = el('p', { class: 'moderator-notice', role: 'status', 'aria-live': 'polite' });
  const storeSwitch = el('div', { class: 'moderator-stores', role: 'group', 'aria-label': 'Choose storefront' });
  const search = el('input', { class: 'input moderator-search', type: 'search', placeholder: 'Search products by name or description…', 'aria-label': 'Search products' });
  const count = el('span', { class: 'moderator-count', text: 'Loading catalogue…' });
  const list = el('div', { class: 'moderator-list', 'aria-live': 'polite' });
  const refreshButton = el('button', { type: 'button', class: 'btn btn--secondary btn--small', text: 'Refresh', onclick: () => loadProducts() });
  const heading = el('div', { class: 'moderator-heading' },
    el('div', { class: 'moderator-heading__copy' },
      el('p', { class: 'moderator-eyebrow', text: 'ZENVORA / CATALOGUE CONTROL' }),
      el('h1', { text: 'Moderator workspace' }),
      el('p', { class: 'moderator-lead', text: 'Keep both storefronts accurate. Edit product details, prices and stock, then save each item.' })),
    el('div', { class: 'moderator-user' },
      el('span', { class: 'moderator-user__avatar', text: (user.fullName || user.email || 'M').trim().charAt(0).toUpperCase() }),
      el('span', {}, el('strong', { text: user.fullName || 'Moderator' }), el('small', { text: user.role === 'admin' ? 'Administrator access' : 'Catalogue moderator' }))));

  const toolbar = el('div', { class: 'moderator-toolbar' },
    el('label', { class: 'moderator-search-wrap' }, el('span', { class: 'moderator-search-icon', 'aria-hidden': 'true', text: '⌕' }), search),
    count,
    refreshButton);

  function visibleProducts() {
    const q = search.value.trim().toLowerCase();
    return products.filter((p) => !q || [p.name, p.description].some((v) => String(v || '').toLowerCase().includes(q)));
  }

  function renderProducts() {
    list.replaceChildren();
    const items = visibleProducts();
    count.textContent = items.length === products.length
      ? `${products.length} product${products.length === 1 ? '' : 's'}`
      : `${items.length} of ${products.length} products`;
    if (loading) {
      list.append(el('div', { class: 'moderator-empty moderator-empty--loading', role: 'status' },
        el('span', { class: 'moderator-spinner', 'aria-hidden': 'true' }),
        el('strong', { text: 'Loading products' }),
        el('p', { text: 'Getting the latest catalogue from Zenvora.' })));
      return;
    }
    if (!items.length) {
      list.append(el('div', { class: 'moderator-empty' },
        el('span', { class: 'moderator-empty__icon', 'aria-hidden': 'true', text: search.value ? '⌕' : '◇' }),
        el('strong', { text: search.value ? 'No matching products' : 'No products in this storefront yet' }),
        el('p', { text: search.value ? 'Try another name or clear your search.' : 'Products will appear here when the catalogue has items for this store.' }),
        search.value ? el('button', { type: 'button', class: 'btn btn--secondary btn--small', text: 'Clear search', onclick: () => { search.value = ''; renderProducts(); search.focus(); } }) : el('span')));
      return;
    }
    for (const product of items) list.append(productCard(product));
  }

  function productCard(product) {
    const original = {
      name: product.name ?? '',
      description: product.description ?? '',
      price: moneyInput(product.priceKobo),
      promo: moneyInput(product.promoPriceKobo),
      stock: product.stock === null || product.stock === undefined ? '' : String(product.stock),
    };
    const name = input('Product name', original.name, { required: true, maxlength: 140 });
    name.control.maxLength = 140;
    const description = input('Description', original.description, { multiline: true, maxlength: 2000, wide: true });
    const price = input('Regular price (₦)', original.price, { type: 'number', min: '1', max: '1000000', step: '0.01', required: true, inputmode: 'decimal' });
    const promo = input('Offer price (₦)', original.promo, { type: 'number', min: '1', max: '1000000', step: '0.01', placeholder: 'No offer', inputmode: 'decimal' });
    const stockField = input('Stock quantity', original.stock, { type: 'number', min: '0', max: '100000', step: '1', placeholder: 'Made to order' });
    const form = el('form', { class: 'moderator-product', novalidate: true });
    const head = el('div', { class: 'moderator-product__head' },
      el('div', { class: 'moderator-product__identity' },
        el('span', { class: 'moderator-product__dot' }),
        el('div', {}, el('h2', { text: product.name || 'Untitled product' }), el('p', { text: `ID · ${product.id}` }))),
      el('span', { class: 'moderator-product__status', text: product.stock === 0 ? 'Out of stock' : product.stock !== null && product.stock <= 5 ? 'Low stock' : product.stock === null ? 'Made to order' : 'Available' }));
    const fields = el('div', { class: 'moderator-product__fields' }, name.field, description.field, price.field, promo.field, stockField.field);
    const footer = el('div', { class: 'moderator-product__footer' },
      el('span', { class: 'moderator-product__saved', text: 'Changes save to the backend.' }),
      el('button', { type: 'submit', class: 'btn btn--primary moderator-save', text: 'Save changes' }));
    const error = el('p', { class: 'moderator-product__error', role: 'alert', hidden: true });
    form.append(head, fields, error, footer);
    form.addEventListener('input', () => {
      form.classList.toggle('is-dirty', name.control.value !== original.name || description.control.value !== original.description || price.control.value !== original.price || promo.control.value !== original.promo || stockField.control.value !== original.stock);
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.hidden = true;
      const regular = moneyToKobo(price.control.value);
      const offer = promo.control.value.trim() === '' ? null : moneyToKobo(promo.control.value);
      const rawStock = stockField.control.value.trim();
      const stock = rawStock === '' ? null : Number(rawStock);
      if (name.control.value.trim().length < 2 || name.control.value.trim().length > 140) {
        error.textContent = 'Product name must be between 2 and 140 characters.'; error.hidden = false; name.control.focus(); return;
      }
      if (!Number.isFinite(regular) || regular < 100 || regular > 100000000) {
        error.textContent = 'Enter a regular price between ₦1 and ₦1,000,000.'; error.hidden = false; price.control.focus(); return;
      }
      if (offer !== null && (!Number.isFinite(offer) || offer < 100 || offer >= regular)) {
        error.textContent = 'Offer price must be valid and lower than the regular price.'; error.hidden = false; promo.control.focus(); return;
      }
      if (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 100000)) {
        error.textContent = 'Stock must be a whole number from 0 to 100,000, or leave blank for made-to-order.'; error.hidden = false; stockField.control.focus(); return;
      }
      const payload = {
        name: name.control.value.trim(),
        description: description.control.value.trim(),
        priceKobo: regular,
        promoPriceKobo: offer,
        stock,
      };
      const save = footer.querySelector('button');
      save.disabled = true;
      save.dataset.originalText = save.textContent;
      save.textContent = 'Saving…';
      form.setAttribute('aria-busy', 'true');
      try {
        const result = await api.patch(`/api/moderator/products/${encodeURIComponent(product.id)}`, payload);
        Object.assign(product, result.product);
        original.name = product.name;
        original.description = product.description;
        original.price = moneyInput(product.priceKobo);
        original.promo = moneyInput(product.promoPriceKobo);
        original.stock = product.stock === null || product.stock === undefined ? '' : String(product.stock);
        name.control.value = original.name;
        description.control.value = original.description;
        price.control.value = original.price;
        promo.control.value = original.promo;
        stockField.control.value = original.stock;
        form.classList.remove('is-dirty');
        form.classList.add('is-saved');
        save.textContent = 'Saved ✓';
        notice.textContent = `${product.name} updated successfully.`;
        window.setTimeout(() => { if (save.isConnected) save.textContent = save.dataset.originalText || 'Save changes'; form.classList.remove('is-saved'); }, 1800);
        const title = head.querySelector('h2');
        if (title) title.textContent = product.name;
        const status = head.querySelector('.moderator-product__status');
        if (status) status.textContent = product.stock === 0 ? 'Out of stock' : product.stock !== null && product.stock <= 5 ? 'Low stock' : product.stock === null ? 'Made to order' : 'Available';
      } catch (err) {
        error.textContent = err.status === 401
          ? 'Your session has expired. Please log in again.'
          : err.status === 403
            ? 'Your account no longer has moderator access.'
            : err.message || 'Could not save these changes. Please try again.';
        error.hidden = false;
      } finally {
        save.disabled = false;
        form.removeAttribute('aria-busy');
        if (save.textContent === 'Saving…') save.textContent = save.dataset.originalText || 'Save changes';
      }
    });
    return form;
  }

  async function loadProducts() {
    const id = ++requestId;
    loading = true;
    notice.textContent = '';
    renderProducts();
    refreshButton.disabled = true;
    storeSwitch.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const result = await api.get(`/api/moderator/products?section=${section}`);
      if (id !== requestId) return;
      products = Array.isArray(result.items) ? result.items : [];
      loading = false;
      renderProducts();
    } catch (err) {
      if (id !== requestId) return;
      loading = false;
      list.replaceChildren(stateBox({
        tone: 'error',
        title: err.status === 403 ? 'Moderator access required' : 'Couldn’t load products',
        body: err.status === 401
          ? 'Your session may have expired. Sign in again, then reopen the moderator workspace.'
          : err.status === 403
            ? 'This account is not allowed to edit the catalogue. Ask the owner to check your moderator role in Render.'
            : err.message || 'Check the backend connection and try again.',
        actions: [linkButton({ text: 'Try again', onClick: () => loadProducts(), variant: 'secondary' })],
        iconName: 'shield',
      }));
      count.textContent = 'Catalogue unavailable';
    } finally {
      if (id === requestId) {
        refreshButton.disabled = false;
        storeSwitch.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      }
    }
  }

  function chooseStore(next) {
    if (section === next) return;
    section = next;
    storeSwitch.replaceChildren(...STORES.map((store) => storePill(store, store.id === section, () => chooseStore(store.id))));
    root.dataset.store = section;
    loadProducts();
  }

  storeSwitch.replaceChildren(...STORES.map((store) => storePill(store, store.id === section, () => chooseStore(store.id))));
  search.addEventListener('input', renderProducts);
  root.dataset.store = section;
  root.append(heading, storeSwitch, toolbar, notice, list);
  await loadProducts();
  return root;
}
