import * as api from '../api.js';
import { openAreaDialog } from '../area.js';
import { categoryTile, productCard } from '../components.js';
import { el, icon, linkButton } from '../dom.js';
import { getArea } from '../state.js';
import { observeReveals, skeletonGrid, skeletonTiles, stateBox } from '../ui.js';

const CATEGORY_LIST = [
  'Food',
  'Groceries',
  'Fashion',
  'Electronics',
  'Beauty',
  'Home & living',
  'Books & stationery',
  'Essentials',
];

function hero(area) {
  const input = el('input', {
    class: 'input',
    type: 'search',
    name: 'q',
    placeholder: 'Search jollof, rice, earbuds…',
    'aria-label': 'Search Shop n Delight',
    autocomplete: 'off',
    maxlength: '100',
  });

  const form = el(
    'form',
    {
      class: 'search-form',
      role: 'search',
      onsubmit: (event) => {
        event.preventDefault();
        const q = input.value.trim();
        window.location.hash = q ? `#/search?q=${encodeURIComponent(q)}` : '#/shop';
      },
    },
    input,
    el('button', { type: 'submit', class: 'btn btn--primary' }, icon('search'), el('span', { text: 'Search' })),
  );

  const areaNote = area
    ? el(
        'p',
        { class: 'muted hero__area' },
        'Showing stores that deliver to ',
        el('strong', { text: area }),
        ' ',
        linkButton({ text: 'Change', variant: 'ghost', small: true, onClick: openAreaDialog }),
      )
    : el(
        'p',
        { class: 'muted hero__area' },
        'Choose your area to see stores that deliver to you. ',
        linkButton({ text: 'Choose area', variant: 'ghost', small: true, onClick: openAreaDialog }),
      );

  return el(
    'section',
    { class: 'container hero' },
    el(
      'div',
      {},
      el('p', { class: 'hero__eyebrow', text: 'Food, groceries, electronics and more' }),
      el('h1', { text: 'Everything You Need. Closer Than Ever.' }),
      el('p', {
        class: 'hero__lede',
        text: 'Discover great food, everyday essentials, and trusted stores—all in one place.',
      }),
      el('div', { class: 'hero__search' }, form, areaNote),
      el(
        'div',
        { class: 'purchase__row' },
        linkButton({ href: '#/shop', text: 'Shop everything' }),
        linkButton({ href: '#/shop?category=food', text: 'Order food', variant: 'secondary' }),
        linkButton({ href: '#/puff-sip', text: 'Explore Puff & Sip', variant: 'secondary' }),
      ),
    ),
    el(
      'aside',
      { class: 'hero__panel', 'aria-label': 'What you can shop for' },
      el('p', { class: 'hero__panel-title', text: 'You only see stores that deliver to you.' }),
      el('ul', { class: 'hero__panel-list' }, CATEGORY_LIST.map((name) => el('li', { text: name }))),
      el('img', { class: 'hero__panel-mark', src: 'assets/shop-n-delight-mark.svg', alt: '', width: '180', height: '180' }),
    ),
  );
}

// A section whose content loads on its own. It shows skeletons first, then the result,
// an empty message, or an error with a retry button. A failing section never blocks the page.
function section({ title, subtitle, href, gridClass = 'product-grid', skeletonCount = 4, hideWhenEmpty = false, emptyText, load, render }) {
  const skeletons = gridClass === 'category-grid' ? skeletonTiles(skeletonCount) : skeletonGrid(skeletonCount);
  const grid = el('div', { class: gridClass, 'aria-busy': 'true' }, skeletons);
  const head = el(
    'div',
    { class: 'section__head' },
    el('div', {}, el('h2', { text: title }), subtitle ? el('p', { text: subtitle }) : null),
    href ? el('a', { class: 'text-link', href, text: 'See all' }) : null,
  );
  const root = el('section', { class: 'section' }, head, grid);

  const run = async () => {
    grid.setAttribute('aria-busy', 'true');
    try {
      const data = await load();
      const nodes = render(data);
      if (!nodes.length) {
        if (hideWhenEmpty) return root.remove();
        grid.replaceChildren(stateBox({ title: emptyText ?? 'Nothing here yet', body: '' }));
      } else {
        grid.replaceChildren(...nodes);
        observeReveals(grid);
      }
    } catch (err) {
      grid.replaceChildren(
        stateBox({
          tone: 'error',
          title: `${title} didn’t load`,
          body: err.message,
          actions: [linkButton({ text: 'Try again', variant: 'secondary', small: true, onClick: run })],
        }),
      );
    } finally {
      grid.removeAttribute('aria-busy');
    }
  };

  run();
  return root;
}

export function renderHome() {
  const area = getArea();

  const categories = section({
    title: 'Shop by category',
    gridClass: 'category-grid',
    skeletonCount: 8,
    load: async () => (await api.get('/api/categories')).items,
    render: (items) => items.map((c, i) => categoryTile(c, i)),
  });

  const nearYou = area
    ? section({
        title: `Stores that deliver to ${area}`,
        subtitle: 'Only stores that list this area are shown.',
        href: `#/shop`,
        emptyText: `No stores deliver to ${area} yet`,
        load: async () => (await api.get(`/api/products?area=${encodeURIComponent(area)}&limit=4`)).items,
        render: (items) => items.map((p) => productCard(p)),
      })
    : el(
        'section',
        { class: 'section' },
        el('div', { class: 'section__head' }, el('div', {}, el('h2', { text: 'Stores near you' }))),
        stateBox({
          title: 'Choose your area',
          body: 'We show stores that deliver to where you are. Pick an area to see them here.',
          actions: [linkButton({ text: 'Choose area', onClick: openAreaDialog })],
          iconName: 'pin',
        }),
      );

  const offers = section({
    title: 'Special offers',
    subtitle: 'Products with a reduced price right now.',
    href: '#/shop?sort=price-asc',
    hideWhenEmpty: true,
    load: async () => (await api.get('/api/products?promo=1&limit=4')).items,
    render: (items) => items.map((p) => productCard(p)),
  });

  const groceries = section({
    title: 'Everyday groceries',
    href: '#/shop?category=groceries',
    hideWhenEmpty: true,
    load: async () => (await api.get('/api/products?category=groceries&limit=4')).items,
    render: (items) => items.map((p) => productCard(p)),
  });

  const newest = section({
    title: 'Newly added',
    href: '#/shop?sort=newest',
    hideWhenEmpty: true,
    load: async () => (await api.get('/api/products?sort=newest&limit=4')).items,
    render: (items) => items.map((p) => productCard(p)),
  });

  const trust = el(
    'section',
    { class: 'section' },
    el('div', { class: 'section__head' }, el('div', {}, el('h2', { text: 'How Shop n Delight works' }))),
    el(
      'div',
      { class: 'trust-list' },
      trustItem('shield', 'Totals you can check', 'Prices, delivery fees and totals are worked out on our servers before you confirm anything.'),
      trustItem('pin', 'Stores that reach you', 'We only show stores that list your area as a delivery area.'),
      trustItem('receipt', 'Clear stock signals', 'Each product shows whether it is in stock, running low, or unavailable.'),
    ),
  );

  return el('div', {}, hero(area), categories, nearYou, offers, groceries, newest, trust);
}

function trustItem(iconName, title, body) {
  return el(
    'div',
    { class: 'trust-item', 'data-reveal': '' },
    el('div', { class: 'trust-item__icon' }, icon(iconName)),
    el('h3', { text: title }),
    el('p', { text: body }),
  );
}
