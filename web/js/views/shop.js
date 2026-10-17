import * as api from '../api.js';
import { categoryGlyph, productCard } from '../components.js';
import { el, icon, linkButton } from '../dom.js';
import { replaceQuery } from '../router.js';
import { getArea } from '../state.js';
import { observeReveals, skeletonGrid, stateBox } from '../ui.js';

const PAGE_SIZE = 12;
const SORTS = [
  { value: 'newest', label: 'Newest' },
  { value: 'price-asc', label: 'Price: low to high' },
  { value: 'price-desc', label: 'Price: high to low' },
];
const SEARCH_DEBOUNCE_MS = 300;

// Builds the shop and search page. The URL holds the filters, so a filtered view
// can be bookmarked, shared, and restored on reload.
export function renderShop({ query, section = 'shop', home = false }) {
  const storedArea = getArea();
  const filters = {
    q: (query.get('q') ?? '').slice(0, 100),
    category: query.get('category') ?? '',
    sort: SORTS.some((s) => s.value === query.get('sort')) ? query.get('sort') : 'newest',
    promo: query.get('promo') === '1',
    // The area filter is on when the URL names one. Otherwise it follows the saved area.
    area: query.has('area') ? query.get('area') : (storedArea ?? ''),
  };

  let offset = 0;
  let total = 0;
  let requestSeq = 0; // each request gets a number, so stale responses can be ignored
  let debounceTimer = null;
  let shownCount = 0;

  const chips = []; // { node, isActive } so aria-pressed can be refreshed in one place

  const grid = el('div', { class: 'product-grid', id: 'shop-grid' });
  const meta = el('p', { class: 'results-meta', role: 'status', 'aria-live': 'polite' });
  const more = el('div', { class: 'load-more' });

  let composing = false;
  const searchInput = el('input', {
    id: 'shop-search',
    class: 'input',
    type: 'text',
    inputmode: 'search',
    enterkeyhint: 'search',
    name: 'q',
    value: filters.q,
    placeholder: 'Search products',
    'aria-label': 'Search products',
    autocomplete: 'off',
    maxlength: '100',
    oninput: (event) => {
      clearTimeout(debounceTimer);
      clearButton.hidden = !searchInput.value;
      if (event.isComposing || composing) return;
      scheduleSearch();
    },
    oncompositionstart: () => {
      composing = true;
      clearTimeout(debounceTimer);
    },
    oncompositionend: () => {
      composing = false;
      scheduleSearch();
    },
    onkeydown: (event) => {
      if (event.key !== 'Enter' || event.isComposing || composing) return;
      event.preventDefault();
      scheduleSearch(true);
    },
  });
  const clearButton = el('button', {
    type: 'button',
    class: 'search-clear',
    'aria-label': 'Clear search',
    title: 'Clear search',
    hidden: !filters.q,
    text: '×',
    onclick: () => {
      clearTimeout(debounceTimer);
      searchInput.value = '';
      clearButton.hidden = true;
      filters.q = '';
      commit();
      searchInput.focus();
    },
  });

  function scheduleSearch(immediate = false) {
    clearTimeout(debounceTimer);
    const run = () => {
      if (!searchInput.isConnected) return;
      filters.q = searchInput.value.trim();
      commit();
    };
    if (immediate) run();
    else debounceTimer = setTimeout(run, SEARCH_DEBOUNCE_MS);
  }

  const sortSelect = el(
    'select',
    {
      id: 'shop-sort',
      class: 'select',
      'aria-label': 'Sort products',
      onchange: () => {
        filters.sort = sortSelect.value;
        commit();
      },
    },
    SORTS.map((s) => el('option', { value: s.value, text: s.label, selected: s.value === filters.sort })),
  );

  // Category chips. "All" is always there. Real categories are added once they load.
  const categoryRow = el('div', { class: 'chip-row', role: 'group', 'aria-label': 'Categories' });
  const allChip = addChip(
    'All',
    () => !filters.category,
    () => {
      filters.category = '';
      commit();
    },
  );
  categoryRow.append(allChip.node);

  const offersChip = addChip(
    'Offers',
    () => filters.promo,
    () => {
      filters.promo = !filters.promo;
      commit();
    },
  );

  // Keep delivery-location labels off both storefronts' quick-filter row.
  // A saved delivery area can still be used by the product query when applicable.
  const areaChip = null;

  const quickRow = el(
    'div',
    { class: 'chip-row', role: 'group', 'aria-label': 'Quick filters' },
    offersChip.node,
    areaChip?.node,
  );

  // Loads categories without blocking the grid. "All" still works if this fails.
  api
    .get(`/api/categories?section=${section}`)
    .then(({ items }) => {
      for (const c of items) {
        const c2 = addChip(
          [icon(categoryGlyph(c.id), 'chip__icon'), c.name],
          () => filters.category === c.id,
          () => {
            filters.category = c.id;
            commit();
          },
        );
        categoryRow.append(c2.node);
      }
      refreshChips();
    })
    .catch(() => {});

  function addChip(label, isActive, onActivate) {
    const node = el('button', { type: 'button', class: 'chip' }, label);
    node.addEventListener('click', onActivate);
    const entry = { node, isActive };
    chips.push(entry);
    return entry;
  }

  function refreshChips() {
    for (const { node, isActive } of chips) {
      node.setAttribute('aria-pressed', String(Boolean(isActive())));
    }
  }

  // Writes the filters to the URL, then fetches the first page again.
  function commit() {
    const params = {};
    if (filters.q) params.q = filters.q;
    if (filters.category) params.category = filters.category;
    if (filters.sort !== 'newest') params.sort = filters.sort;
    if (filters.promo) params.promo = '1';
    if (filters.area) params.area = filters.area;
    else if (storedArea) params.area = ''; // the user switched the saved area off explicitly
    replaceQuery(params);
    refreshChips();
    fetchPage(0, true);
  }

  async function fetchPage(nextOffset, replace) {
    const id = ++requestSeq;
    if (replace) {
      grid.setAttribute('aria-busy', 'true');
      grid.replaceChildren(...skeletonGrid(6));
    }

    const params = new URLSearchParams({
      sort: filters.sort,
      limit: String(PAGE_SIZE),
      offset: String(nextOffset),
    });
    params.set('section', section);
    if (filters.q) params.set('q', filters.q);
    if (filters.category) params.set('category', filters.category);
    if (filters.promo) params.set('promo', '1');
    if (filters.area) params.set('area', filters.area);

    try {
      const data = await api.get(`/api/products?${params}`);
      if (id !== requestSeq) return;

      total = data.total;
      offset = nextOffset + data.items.length;

      if (replace) {
        grid.replaceChildren();
        shownCount = 0;
      }
      if (!data.items.length && shownCount === 0) {
        grid.replaceChildren(emptyState());
        meta.textContent = 'No products match these filters.';
      } else {
        const fresh = data.items.map((p) => productCard(p));
        grid.append(...fresh);
        shownCount += data.items.length;
        observeReveals(grid);
        meta.textContent = `${total} ${total === 1 ? 'product' : 'products'}${filters.q ? ` for “${filters.q}”` : ''}`;
      }
      renderMore();
    } catch (err) {
      if (id !== requestSeq) return;
      grid.replaceChildren(
        stateBox({
          tone: 'error',
          title: 'We couldn’t load products',
          body: err.message,
          actions: [
            linkButton({
              text: 'Try again',
              variant: 'secondary',
              small: true,
              onClick: () => fetchPage(nextOffset, replace),
            }),
          ],
        }),
      );
      meta.textContent = '';
    } finally {
      if (id === requestSeq) grid.removeAttribute('aria-busy');
    }
  }

  function renderMore() {
    more.replaceChildren();
    if (offset < total) {
      more.append(
        linkButton({
          text: 'Show more',
          variant: 'secondary',
          onClick: (event) => {
            event.currentTarget.disabled = true;
            fetchPage(offset, false);
          },
        }),
      );
    }
  }

  function emptyState() {
    return stateBox({
      title: 'Nothing matches yet',
      body: filters.area
        ? `No stores deliver to ${filters.area} for these filters. Try another area or clear a filter.`
        : 'Try a different search, or clear the filters.',
      actions: [
        linkButton({
          text: 'Clear filters',
          variant: 'secondary',
          onClick: () => {
            Object.assign(filters, { q: '', category: '', promo: false, sort: 'newest' });
            searchInput.value = '';
            commit();
          },
        }),
      ],
      iconName: 'search',
    });
  }

  const heading = filters.q
    ? `Results for “${filters.q}”`
    : filters.category
      ? 'Shop by category'
      : section === 'puff' ? 'Everything in Puff & Sip' : 'Shop everything';

  // Keep page-level state in the title so back and forward stay understandable.
  document.title = `${heading} · ${section === 'puff' ? 'Puff & Sip' : 'Shop n Delight'}`;

  // The home page opens with a warm hero, shown only when nothing is filtered yet.
  const showHero = home && section === 'shop' && !filters.q && !filters.category && !filters.promo && !filters.area;
  const hero = showHero
    ? el('section', { class: 'sn-hero', 'aria-labelledby': 'sn-hero-title' },
        el('div', {},
          el('p', { class: 'sn-hero__kicker', text: 'Everyday shopping' }),
          el('h2', { id: 'sn-hero-title', class: 'sn-hero__title', text: 'Shop n Delight' }),
          el('p', { class: 'sn-hero__lede', text: 'Fresh groceries, quality products and everyday essentials, all in one place.' }),
          el('button', {
            type: 'button',
            class: 'sn-hero__cta',
            text: 'Shop now',
            onclick: () => document.getElementById('shop-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
          }),
        ),
        el('div', { class: 'sn-hero__art', 'aria-hidden': 'true' }, icon('basket', 'icon')),
      )
    : null;

  const page = el(
    'div',
    { class: 'container section--tight' },
    hero,
    el('div', { class: 'section__head' }, el('div', {}, el('h1', { text: heading }))),
    el(
      'div',
      { class: 'toolbar' },
      el('div', { class: 'toolbar__search' }, el('label', { class: 'visually-hidden', for: 'shop-search', text: 'Search products' }), searchInput, clearButton),
      el('div', {}, el('label', { class: 'visually-hidden', for: 'shop-sort', text: 'Sort products' }), sortSelect),
    ),
    categoryRow,
    quickRow,
    meta,
    grid,
    more,
  );

  refreshChips();
  fetchPage(0, true);
  return page;
}
