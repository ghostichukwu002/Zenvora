import { checkoutHref, sectionOf, shopHref } from '../sections.js';
import * as api from '../api.js';
import { addToCart, categoryGlyph, productImageUrl, trustBadge } from '../components.js';
import { el, icon, linkButton } from '../dom.js';
import { AVAILABILITY_LABEL, formatNaira } from '../format.js';
import { getArea } from '../state.js';
import { toast, stateBox } from '../ui.js';
import { openAreaDialog } from '../area.js';

const MAX_QUANTITY = 20;

// Unit price for the current choices: effective price plus each chosen option's delta.
function unitPriceFor(product, choices) {
  let price = product.effectivePriceKobo;
  for (const variant of product.variants) {
    const chosen = choices[variant.id];
    if (chosen === undefined) continue;
    price += variant.priceDeltaKobo[variant.options.indexOf(chosen)] ?? 0;
  }
  return price;
}

// The page offers up to MAX_QUANTITY. The server enforces exact stock on every add,
// and stock counts are not sent to the browser.
function maxQuantityFor() {
  return MAX_QUANTITY;
}

export async function renderProduct({ params }) {
  let product;
  try {
    product = await api.get(`/api/products/${encodeURIComponent(params.id)}`);
  } catch (err) {
    if (err.status === 404) {
      return stateBox({
        title: 'That product isn’t available',
        body: 'It may have been removed, or the link is out of date.',
        actions: [linkButton({ href: '#/shop', text: 'Browse the shop' })],
        iconName: 'box',
      });
    }
    return stateBox({
      tone: 'error',
      title: 'Couldn’t load this product',
      body: err.message,
      actions: [linkButton({ text: 'Try again', variant: 'secondary', onClick: () => window.location.reload() })],
    });
  }

  document.title = `${product.name} · Shop n Delight`;
  return productView(product);
}

function productView(product) {
  const area = getArea();
  const productImages = (Array.isArray(product.images) ? product.images : [])
    .map((image) => typeof image === 'string' ? { url: image, alt: product.name } : image)
    .filter((image) => image && typeof image.url === 'string' && image.url);
  let selectedImageIndex = 0;
  const choices = {};
  const quantityOutput = el('output', { 'aria-live': 'polite', text: '1' });
  let quantity = 1;

  const decrement = el('button', { type: 'button', 'aria-label': 'Decrease quantity', text: '−' });
  const increment = el('button', { type: 'button', 'aria-label': 'Increase quantity', text: '+' });
  // Quantity is an output element, so screen readers announce changes via aria-live.
  const priceNode = el('span', { class: 'price' });
  const hint = el('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
  const errorNode = el('p', { class: 'field-error', role: 'alert' });
  const addButton = el('button', { type: 'button', class: 'btn btn--primary btn--block' });
  const addLabel = el('span', { text: 'Add to cart' });
  addButton.append(addLabel);

  const unavailable = product.availability === 'out_of_stock';

  // Delivery check, using the public service-area list. The server still validates on checkout.
  const deliveryLine = area
    ? product.merchant.serviceAreas.includes(area)
      ? el('p', { class: 'availability availability--in_stock', text: `Delivers to ${area}` })
      : el('p', {
          class: 'availability availability--out_of_stock',
          text: `${product.merchant.name} doesn’t deliver to ${area} yet`,
        })
    : el(
        'p',
        { class: 'muted' },
        'Choose your delivery area to check it reaches you. ',
        linkButton({ text: 'Choose area', variant: 'ghost', small: true, onClick: openAreaDialog }),
      );

  function refresh() {
    const hasAllChoices = product.variants.every((v) => choices[v.id] !== undefined);
    const price = unitPriceFor(product, choices);
    priceNode.textContent = formatNaira(price * quantity);
    quantityOutput.textContent = String(quantity);
    decrement.disabled = quantity <= 1;
    increment.disabled = quantity >= maxQuantityFor(product);

    let disabled = false;
    if (unavailable) {
      addLabel.textContent = 'Unavailable';
      disabled = true;
      hint.textContent = 'This product is currently unavailable.';
    } else if (!hasAllChoices) {
      addLabel.textContent = 'Choose options to continue';
      disabled = true;
      hint.textContent = 'Pick an option above to see the price and add to cart.';
    } else {
      addLabel.textContent = quantity > 1 ? `Add ${quantity} to cart` : 'Add to cart';
      hint.textContent = product.availability === 'low_stock' ? 'Few left in stock.' : '';
    }
    addButton.disabled = disabled || addButton.dataset.busy === 'true';
  }

  decrement.addEventListener('click', () => {
    quantity = Math.max(1, quantity - 1);
    refresh();
  });
  increment.addEventListener('click', () => {
    quantity = Math.min(maxQuantityFor(product), quantity + 1);
    refresh();
  });

  let goToCheckout = false;
  const buyNow = el('button', { type: 'button', class: 'btn btn--secondary btn--block', text: 'Buy now' });
  buyNow.addEventListener('click', () => {
    if (addButton.disabled) return;
    goToCheckout = true;
    addButton.click();
  });

  addButton.addEventListener('click', async () => {
    // Ignore repeat taps while a request is in flight, so one tap cannot add twice.
    if (addButton.dataset.busy === 'true') return;
    addButton.dataset.busy = 'true';
    addButton.disabled = true;
    errorNode.textContent = '';
    addLabel.textContent = 'Adding…';

    let added = false;
    try {
      await addToCart({ productId: product.id, variantChoice: { ...choices }, quantity });
      added = true;
      addLabel.textContent = 'Added to cart';
      toast(`${product.name} added to your cart`, { linkHref: checkoutHref(sectionOf(product)), linkText: 'Checkout' });
      if (goToCheckout) {
        window.location.hash = checkoutHref(sectionOf(product));
        return;
      }
    } catch (err) {
      errorNode.textContent = err.message;
      toast(err.message, { tone: 'error' });
    } finally {
      addButton.dataset.busy = 'false';
      if (added) {
        // Keep the confirmation visible briefly, then return to the normal button.
        setTimeout(refresh, 1400);
      } else {
        refresh();
      }
    }
  });

  const variantGroups = product.variants.map((variant) => {
    const labelId = `variant-${variant.id}`;
    const buttons = variant.options.map((option) => {
      const btn = el('button', { type: 'button', class: 'chip', text: option, 'aria-pressed': 'false' });
      btn.addEventListener('click', () => {
        choices[variant.id] = option;
        for (const other of buttons) other.setAttribute('aria-pressed', String(other === btn));
        refresh();
      });
      return btn;
    });
    return el(
      'div',
      { class: 'option-group', role: 'group', 'aria-labelledby': labelId },
      el('span', { class: 'option-group__label', id: labelId, text: variant.label }),
      el('div', { class: 'option-group__choices' }, buttons),
    );
  });

  const prep = product.merchant.prepMinutes
    ? el('span', { text: ` · Usually about ${product.merchant.prepMinutes} min to prepare (estimate)` })
    : null;

  const page = el(
    'div',
    { class: 'container' },
    el(
      'nav',
      { class: 'breadcrumb', 'aria-label': 'Breadcrumb' },
      el(
        'ol',
        {},
        el('li', {}, el('a', { href: '#/', text: 'Home' })),
        el('li', {}, el('a', { href: `${shopHref(sectionOf(product))}?category=${encodeURIComponent(product.category.id)}`, text: product.category.name })),
        el('li', { text: product.name }),
      ),
    ),
    el(
      'div',
      { class: 'product-detail' },
      el(
        'div',
        { class: 'product-detail__media' },
        productImages.length
          ? el('div', { class: 'product-gallery' },
              el('img', { class: 'product-gallery__main', src: productImages[0].url, alt: productImages[0].alt || product.name, fetchpriority: 'high', decoding: 'async', onerror: (event) => { event.currentTarget.replaceWith(icon(categoryGlyph(product.category.id))); } }),
              productImages.length > 1 ? el('div', { class: 'product-gallery__thumbs', role: 'group', 'aria-label': 'Product photos' },
                productImages.map((image, index) => el('button', { type: 'button', class: `product-gallery__thumb ${index === selectedImageIndex ? 'is-active' : ''}`, 'aria-label': `View photo ${index + 1}`, 'aria-pressed': String(index === selectedImageIndex), onclick: (event) => {
                  selectedImageIndex = index;
                  const main = event.currentTarget.closest('.product-gallery').querySelector('.product-gallery__main');
                  main.src = image.url;
                  main.alt = image.alt || product.name;
                  event.currentTarget.parentElement.querySelectorAll('button').forEach((button) => {
                    button.classList.toggle('is-active', button === event.currentTarget);
                    button.setAttribute('aria-pressed', String(button === event.currentTarget));
                  });
                } }, el('img', { src: image.url, alt: '', loading: 'lazy' })))
              ) : null)
          : productImageUrl(product)
            ? el('img', { src: productImageUrl(product), alt: product.name, fetchpriority: 'high', decoding: 'async', onerror: (event) => { event.currentTarget.replaceWith(icon(categoryGlyph(product.category.id))); } })
            : icon(categoryGlyph(product.category.id)),
      ),
      el(
        'div',
        { class: 'product-detail__info' },
        el('p', { class: 'muted', text: product.category.name }),
        el('h1', { text: product.name }),
        el(
          'p',
          { class: 'product-detail__merchant' },
          'Sold by ',
          el('strong', { text: product.merchant.name }),
          ` · ${product.merchant.city}, ${product.merchant.state}`,
          prep,
          product.merchant.verified ? ' ' : null,
          product.merchant.verified ? trustBadge('store') : null,
        ),
        el(
          'div',
          { class: 'product-detail__price' },
          priceNode,
          product.promoPriceKobo !== null
            ? el('span', { class: 'price--was', text: formatNaira(product.priceKobo) })
            : null,
          el('span', {
            class: `availability availability--${product.availability}`,
            text: AVAILABILITY_LABEL[product.availability],
          }),
        ),
        product.description ? el('p', { text: product.description }) : null,
        product.brand ? el('p', { class: 'product-detail__brand' }, el('strong', { text: 'Brand: ' }), product.brand) : null,
        product.specifications && Object.keys(product.specifications).length
          ? el('section', { class: 'product-specifications', 'aria-label': 'Product specifications' },
              el('h2', { text: 'Specifications' }),
              el('dl', {}, Object.entries(product.specifications).map(([label, value]) =>
                el('div', { class: 'product-specifications__row' }, el('dt', { text: label }), el('dd', { text: String(value) })))))
          : null,
        deliveryLine,
        variantGroups.length ? variantGroups : null,
        el(
          'div',
          { class: 'purchase' },
          el(
            'div',
            { class: 'purchase__row' },
            el('span', { class: 'field__label', text: 'Quantity' }),
            el('div', { class: 'stepper' }, decrement, quantityOutput, increment),
          ),
          el('div', { class: 'purchase__row' }, addButton, buyNow),
          hint,
          errorNode,
        ),
      ),
    ),
  );

  refresh();
  return page;
}
