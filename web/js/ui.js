// Shared UI pieces: toasts, empty and error panels, skeletons, scroll reveals.
// Motion goes through CSS classes and respects prefers-reduced-motion (see components.css).

import { el, icon } from './dom.js';

const MAX_TOASTS = 3;

export function toast(message, { tone = 'default', linkHref, linkText, duration = 4200 } = {}) {
  const region = document.getElementById('toast-region');
  const node = el(
    'div',
    { class: tone === 'error' ? 'toast toast--error' : 'toast' },
    el('span', { text: message }),
    linkHref ? el('a', { href: linkHref, text: linkText ?? 'View' }) : null,
  );
  region.append(node);

  // Keep the stack short so toasts never cover the page.
  while (region.children.length > MAX_TOASTS) region.firstElementChild.remove();

  requestAnimationFrame(() => node.classList.add('is-visible'));
  setTimeout(() => {
    node.classList.remove('is-visible');
    setTimeout(() => node.remove(), 300);
  }, duration);
  return node;
}

// A panel for empty, loading-failed, or informational states.
export function stateBox({ tone = 'neutral', title, body, actions = [], iconName }) {
  const isError = tone === 'error';
  return el(
    'section',
    {
      class: isError ? 'state state--error' : 'state',
      role: isError ? 'alert' : undefined,
    },
    iconName ? icon(iconName, 'icon') : null,
    el('h2', { text: title }),
    body ? el('p', { text: body }) : null,
    actions.length ? el('div', { class: 'purchase__row' }, actions) : null,
  );
}

export function skeletonGrid(count = 8) {
  return Array.from({ length: count }, () =>
    el(
      'div',
      { class: 'skeleton-card', 'aria-hidden': 'true' },
      el('div', { class: 'skeleton skeleton--media' }),
      el(
        'div',
        { class: 'skeleton-card__body' },
        el('div', { class: 'skeleton skeleton--line' }),
        el('div', { class: 'skeleton skeleton--line skeleton--short' }),
      ),
    ),
  );
}

export function skeletonTiles(count = 8) {
  return Array.from({ length: count }, () =>
    el('div', { class: 'skeleton skeleton--tile', 'aria-hidden': 'true' }),
  );
}

// Animates elements as they scroll into view. Each element animates once.
export function observeReveals(root = document) {
  const targets = [...root.querySelectorAll('[data-reveal]:not(.is-revealed)')];
  if (!targets.length) return;

  targets.forEach((node, i) => {
    // Small stagger for groups; capped so late items never feel delayed.
    node.style.transitionDelay = `${Math.min(i, 6) * 60}ms`;
  });

  if (!('IntersectionObserver' in window)) {
    targets.forEach((node) => node.classList.add('is-revealed'));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-revealed');
        io.unobserve(entry.target);
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -32px 0px' },
  );
  targets.forEach((node) => io.observe(node));
}
