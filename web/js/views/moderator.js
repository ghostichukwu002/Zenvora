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
        body: 'This workspace is reserved for approved store moderators. Your account does not have catalogue-editing access.',
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
      el('p', { class: 'moderator-eyebrow', text: 'STORE OPERATIONS / CATALOGUE CONTROL' }),
      el('h1', { text: 'Store operations' }),
      el('p', { class: 'moderator-lead', text: 'Manage both storefronts from one place. Switch stores, update product details, adjust prices and keep stock accurate.' })),
    el('div', { class: 'moderator-user' },
      el('span', { class: 'moderator-user__avatar', text: (user.fullName || user.email || 'M').trim().charAt(0).toUpperCase() }),
      el('span', {}, el('strong', { text: user.fullName || 'Moderator' }), el('small', { text: user.role === 'admin' ? 'Administrator access' : 'Catalogue moderator' }))));

  const toolbar = el('div', { class: 'moderator-toolbar' },
    el('label', { class: 'moderator-search-wrap' }, el('span', { class: 'moderator-search-icon', 'aria-hidden': 'true', text: '⌕' }), search),
    count,
    refreshButton);

  let storeOptions = [];
  let categoryOptions = [];
  let selectedPhotos = [];
  let coverIndex = 0;
  const createName = input('Product name', '', { required: true, maxlength: 140 });
  const createBrand = input('Brand (optional)', '', { maxlength: 100 });
  const createDescription = input('Description', '', { multiline: true, maxlength: 2000, wide: true });
  const createPrice = input('Regular price (₦)', '', { type: 'number', min: '1', max: '1000000', step: '0.01', required: true });
  const createPromo = input('Offer price (₦)', '', { type: 'number', min: '1', max: '1000000', step: '0.01', placeholder: 'No offer' });
  const createStock = input('Stock quantity', '', { type: 'number', min: '0', max: '100000', step: '1', placeholder: 'Leave blank for made to order' });
  const createSpecs = input('Product specifications', '', { multiline: true, maxlength: 3000, wide: true, hint: 'One detail per line, e.g. Colour: Black · Capacity: 20,000 mAh · Material: Aluminium' });
  createSpecs.control.placeholder = 'Colour: Black\nCapacity: 20,000 mAh\nMaterial: Aluminium';
  const createMerchant = el('select', { class: 'input moderator-input', required: true, 'aria-label': 'Store merchant' });
  const createCategory = el('select', { class: 'input moderator-input', required: true, 'aria-label': 'Product category' });
  const createForm = el('form', { class: 'moderator-create-form' });
  const photoPicker = el('input', { class: 'input moderator-photo-picker', type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, 'aria-label': 'Choose product images' });
  const photoPreview = el('div', { class: 'moderator-photo-grid', 'aria-live': 'polite' });
  const photoHelp = el('small', { class: 'moderator-hint', text: 'JPG, PNG or WebP · up to 5 MB each · maximum 6 photos. Use real, clear product photos.' });
  const createError = el('p', { class: 'moderator-product__error', role: 'alert', hidden: true });
  const createSave = el('button', { type: 'submit', class: 'btn btn--primary moderator-save', text: 'Create product listing' });
  const createPanel = el('section', { class: 'moderator-create' },
    el('div', { class: 'moderator-create__heading' },
      el('div', {}, el('p', { class: 'moderator-eyebrow', text: 'NEW CATALOGUE ITEM' }), el('h2', { text: 'Add a product' }),
        el('p', { class: 'moderator-lead', text: 'Create a listing with product details, specifications and up to six Cloudinary-hosted photos.' })),
      el('span', { class: 'moderator-create__badge', text: 'New listing' })),
    createForm);
  const selectField = (label, control) => el('div', { class: 'field moderator-field' }, el('label', { text: label }), control);
  const photoField = el('div', { class: 'field moderator-field moderator-field--wide' },
    el('label', { text: 'Product photos' }), photoPicker, photoHelp, photoPreview);
  createForm.append(
    el('div', { class: 'moderator-product__fields' },
      selectField('Store', createMerchant), selectField('Category', createCategory),
      createName.field, createBrand.field, createDescription.field,
      createPrice.field, createPromo.field, createStock.field, createSpecs.field, photoField),
    createError,
    el('div', { class: 'moderator-product__footer' },
      el('span', { class: 'moderator-product__saved', text: 'Images upload securely to Cloudinary. Product details are saved to the database.' }),
      createSave));

  function updateSelect(control, items, emptyLabel, selectedValue) {
    control.replaceChildren(el('option', { value: '', text: emptyLabel }));
    for (const item of items) control.append(el('option', { value: item.id, text: item.name, selected: item.id === selectedValue }));
  }

  function renderPhotoPreviews() {
    photoPreview.replaceChildren();
    selectedPhotos.forEach((photo, index) => {
      const image = el('img', { src: photo.previewUrl, alt: photo.alt || photo.file.name, loading: 'lazy' });
      const altId = `mod-photo-alt-${index}`;
      const alt = el('input', { class: 'input moderator-input', type: 'text', value: photo.alt, maxlength: 160, placeholder: 'Describe this photo for accessibility', 'aria-label': `Photo ${index + 1} alt text` });
      alt.addEventListener('input', () => { photo.alt = alt.value; });
      const cover = el('label', { class: 'moderator-photo-cover' },
        el('input', { type: 'radio', name: 'moderator-cover-photo', checked: index === coverIndex, onchange: () => { coverIndex = index; } }),
        el('span', { text: index === coverIndex ? 'Cover photo' : 'Set as cover' }));
      const remove = el('button', { type: 'button', class: 'btn btn--secondary btn--small', text: 'Remove', onclick: () => {
        URL.revokeObjectURL(photo.previewUrl);
        selectedPhotos.splice(index, 1);
        if (coverIndex >= selectedPhotos.length) coverIndex = Math.max(0, selectedPhotos.length - 1);
        renderPhotoPreviews();
      } });
      photoPreview.append(el('article', { class: 'moderator-photo' }, image,
        el('div', { class: 'moderator-photo__body' }, el('strong', { text: photo.file.name }),
          el('small', { text: `${(photo.file.size / 1024 / 1024).toFixed(2)} MB` }), alt, cover, remove)));
    });
  }

  photoPicker.addEventListener('change', () => {
    for (const photo of selectedPhotos) URL.revokeObjectURL(photo.previewUrl);
    selectedPhotos = Array.from(photoPicker.files || []).map((file) => ({
      file, alt: file.name.replace(/\\.[^.]+$/, '').replace(/[-_]+/g, ' '), previewUrl: URL.createObjectURL(file),
    }));
    coverIndex = 0;
    createError.hidden = true;
    if (selectedPhotos.length > 6) {
      createError.textContent = 'Choose no more than 6 photos for one product.';
      createError.hidden = false;
    }
    for (const photo of selectedPhotos) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(photo.file.type) || photo.file.size > 5 * 1024 * 1024) {
        createError.textContent = 'Every photo must be JPG, PNG or WebP and no larger than 5 MB.';
        createError.hidden = false;
      }
    }
    renderPhotoPreviews();
  });

  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    createError.hidden = true;
    const regular = moneyToKobo(createPrice.control.value);
    const offer = createPromo.control.value.trim() === '' ? null : moneyToKobo(createPromo.control.value);
    const rawStock = createStock.control.value.trim();
    const stock = rawStock === '' ? null : Number(rawStock);
    const name = createName.control.value.trim();
    if (name.length < 2 || name.length > 140) { createError.textContent = 'Product name must be between 2 and 140 characters.'; createError.hidden = false; createName.control.focus(); return; }
    if (!createMerchant.value || !createCategory.value) { createError.textContent = 'Choose a store and category.'; createError.hidden = false; return; }
    if (!Number.isInteger(regular) || regular < 100 || regular > 100000000) { createError.textContent = 'Enter a regular price between ₦1 and ₦1,000,000.'; createError.hidden = false; createPrice.control.focus(); return; }
    if (offer !== null && (!Number.isInteger(offer) || offer < 100 || offer >= regular)) { createError.textContent = 'Offer price must be lower than the regular price.'; createError.hidden = false; createPromo.control.focus(); return; }
    if (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 100000)) { createError.textContent = 'Stock must be a whole number from 0 to 100,000.'; createError.hidden = false; createStock.control.focus(); return; }
    if (selectedPhotos.length < 1 || selectedPhotos.length > 6) { createError.textContent = 'Add between 1 and 6 product photos.'; createError.hidden = false; return; }
    if (selectedPhotos.some((photo) => !['image/jpeg', 'image/png', 'image/webp'].includes(photo.file.type) || photo.file.size > 5 * 1024 * 1024)) { createError.textContent = 'Photos must be JPG, PNG or WebP and no larger than 5 MB each.'; createError.hidden = false; return; }
    const specifications = {};
    for (const line of createSpecs.control.value.split('\n')) {
      if (!line.trim()) continue;
      const splitAt = line.indexOf(':');
      if (splitAt < 1) { createError.textContent = 'Use “Label: value” on each specification line.'; createError.hidden = false; createSpecs.control.focus(); return; }
      const key = line.slice(0, splitAt).trim();
      const value = line.slice(splitAt + 1).trim();
      if (key.length > 40 || value.length > 200 || Object.keys(specifications).length >= 20) { createError.textContent = 'Use up to 20 specifications; labels max 40 characters and values max 200.'; createError.hidden = false; return; }
      if (key && value) specifications[key] = value;
    }
    createSave.disabled = true;
    createSave.textContent = 'Uploading photos…';
    createForm.setAttribute('aria-busy', 'true');
    try {
      const uploaded = [];
      const orderedPhotos = selectedPhotos.map((photo, index) => ({ photo, index })).sort((a, b) => (a.index === coverIndex ? -1 : b.index === coverIndex ? 1 : a.index - b.index));
      for (const { photo } of orderedPhotos) {
        const signed = await api.post('/api/moderator/uploads/sign', {});
        const data = new FormData();
        data.append('file', photo.file);
        data.append('api_key', signed.apiKey);
        data.append('timestamp', String(signed.timestamp));
        data.append('folder', signed.folder);
        data.append('public_id', signed.publicId);
        data.append('signature', signed.signature);
        const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(signed.cloudName)}/image/upload`, { method: 'POST', body: data });
        const cloudResult = await response.json().catch(() => null);
        if (!response.ok || !cloudResult?.secure_url || !cloudResult?.public_id) {
          throw new Error(cloudResult?.error?.message || 'A photo could not be uploaded to Cloudinary. Please try again.');
        }
        uploaded.push({ url: cloudResult.secure_url, publicId: cloudResult.public_id, alt: photo.alt.trim() || name });
        createSave.textContent = `Uploading photos… ${uploaded.length}/${orderedPhotos.length}`;
      }
      const result = await api.post('/api/moderator/products', {
        section, merchantId: createMerchant.value, category: createCategory.value,
        name, description: createDescription.control.value.trim(), brand: createBrand.control.value.trim(),
        priceKobo: regular, promoPriceKobo: offer, stock, specifications, images: uploaded,
      });
      notice.textContent = `${result.product.name} was created successfully.`;
      createForm.reset();
      for (const photo of selectedPhotos) URL.revokeObjectURL(photo.previewUrl);
      selectedPhotos = [];
      coverIndex = 0;
      renderPhotoPreviews();
      await loadProducts();
    } catch (err) {
      createError.textContent = err.status === 401 ? 'Your session expired. Please sign in again.'
        : err.status === 403 ? 'Your account no longer has moderator access.'
          : err.message || 'Could not create this listing. Please try again.';
      createError.hidden = false;
    } finally {
      createSave.disabled = false;
      createSave.textContent = 'Create product listing';
      createForm.removeAttribute('aria-busy');
    }
  });

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
        el('p', { text: 'Getting the latest catalogue from your stores.' })));
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
      storeOptions = Array.isArray(result.merchants) ? result.merchants : [];
      categoryOptions = Array.isArray(result.categories) ? result.categories : [];
      updateSelect(createMerchant, storeOptions, 'Choose a store', createMerchant.value);
      updateSelect(createCategory, categoryOptions, 'Choose a category', createCategory.value);
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
            ? 'This account is not allowed to edit the catalogue. Ask the store owner to confirm your moderator access.'
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
  root.append(heading, storeSwitch, createPanel, toolbar, notice, list);
  await loadProducts();
  return root;
}
