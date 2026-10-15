// Hash-based router. The server serves one HTML page, so routes live in the URL fragment:
//   #/            home
//   #/shop        browse, optionally ?category=…&sort=…&q=…
//   #/search      search results (same view as shop)
//   #/product/:id product detail
//   #/cart        cart
// Hash routing needs no server rewrites, and it works on any static host.

import { focusMain, linkButton, setMain } from './dom.js';
import { observeReveals, stateBox } from './ui.js';

const routes = [];
let navigationId = 0;

export function route(pattern, { nav = null, title = 'Shop n Delight', render }) {
  const names = [];
  const regex = new RegExp(
    '^' +
      pattern
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            names.push(seg.slice(1));
            return '([^/]+)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/') +
      '$',
  );
  routes.push({ regex, names, nav, title, render });
}

export function currentLocation() {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  return { path, query: new URLSearchParams(queryPart), hash: window.location.hash };
}

// Replaces the query string without adding history entries (used by filters).
export function replaceQuery(params) {
  const { path } = currentLocation();
  const query = new URLSearchParams(params);
  const qs = query.toString();
  history.replaceState(null, '', `${window.location.pathname}#${path}${qs ? `?${qs}` : ''}`);
}

function markActiveNav(match, query) {
  const links = document.querySelectorAll('[data-nav]');
  const hash = window.location.hash;
  for (const link of links) {
    const href = link.getAttribute('href') ?? '';
    let active;
    if (href.includes('?')) {
      active = href === hash;
    } else {
      active = match.nav !== null && link.dataset.nav === match.nav && !query.get('category');
    }
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

// Puff & Sip owns its whole path tree: its landing page, shop, product and checkout.
const isPuffPath = (p) => p === '/puff-sip' || p.startsWith('/puff-sip/');

async function navigate() {
  const id = ++navigationId;
  const { path, query } = currentLocation();
  document.documentElement.dataset.section = isPuffPath(path) ? 'puff-sip' : 'shop-n-delight';

  // Keep the active storefront's original brand identity in the shared shell.
  const isPuffSip = isPuffPath(path);
  const brandName = isPuffSip ? 'Puff & Sip' : 'Shop n Delight';
  const brandLogo = isPuffSip ? 'assets/puff-sip-logo.jpg' : 'assets/shop-n-delight-logo.png';
  const brandTagline = isPuffSip ? 'Little treats. Big mood.' : 'Everyday shopping, with a little extra delight.'
  document.querySelectorAll('[data-brand-logo]').forEach((logo) => {
    logo.src = brandLogo;
    logo.alt = brandName;
  });
  document.querySelectorAll('[data-brand-name]').forEach((name) => {
    name.textContent = brandName;
  });
  document.querySelectorAll('[data-brand-tagline]').forEach((tagline) => {
    tagline.textContent = brandTagline;
  });

  let match = null;
  let params = {};
  for (const r of routes) {
    const m = r.regex.exec(path);
    if (!m) continue;
    match = r;
    r.names.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1]);
    });
    break;
  }

  const main = document.getElementById('app');
  if (!match) {
    document.title = 'Page not found · Shop n Delight';
    markActiveNav({ nav: null }, query);
    setMain(
      stateBox({
        title: 'We couldn’t find that page',
        body: 'The link may be out of date. Try the home page or browse the shop.',
        actions: [linkButton({ href: '#/', text: 'Go home' })],
        iconName: 'home',
      }),
    );
    focusMain();
    return;
  }

  markActiveNav(match, query);
  const pageTitle = typeof match.title === 'function' ? match.title({ params, query }) : match.title;
  document.title = `${pageTitle} · Shop n Delight`;

  // Scroll to the top only when the page itself changes, not when filters change.
  if (match.lastPath !== path) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    match.lastPath = path;
  }

  try {
    const node = await match.render({ params, query, navigationId: id });
    if (id !== navigationId) return; // a newer navigation has started; drop this render
    main.classList.remove('view-enter');
    void main.offsetWidth; // restart the entrance transition
    main.classList.add('view-enter');
    setMain(node);
    observeReveals(main);
    focusMain();
  } catch (err) {
    if (id !== navigationId) return;
    setMain(
      stateBox({
        tone: 'error',
        title: 'Something didn’t load',
        body: err.message ?? 'Please try again.',
        actions: [linkButton({ text: 'Try again', onClick: () => navigate() })],
        iconName: 'shield',
      }),
    );
    focusMain();
  }
}

// Re-renders the current route, for example after the delivery area changes.
export function refresh() {
  return navigate();
}

export function start() {
  window.addEventListener('hashchange', navigate);
  navigate();
}
