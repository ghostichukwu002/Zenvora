// Lightweight, delegated motion for dynamically rendered views. No app/business logic is changed.
export function initMotion() {
  const app = document.getElementById('app');
  if (!app) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const revealSelector = [
    '.hero__search', '.hero__panel', '.section__head',
    '.category-tile', '.product-card', '.trust-item',
    '.product-detail__media', '.product-detail__info',
    '.auth-panel', '.auth-card', '.cart-panel', '.checkout-panel',
    '.state', '.toolbar', '.results-meta'
  ].join(',');

  let revealObserver = null;
  if ('IntersectionObserver' in window && !reducedMotion.matches) {
    revealObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('motion-visible');
        revealObserver.unobserve(entry.target);
      }
    }, { threshold: 0.08, rootMargin: '0px 0px -28px 0px' });
  }

  function decorate(root = app) {
    if (reducedMotion.matches) return;
    const nodes = [];
    if (root instanceof Element && root.matches(revealSelector)) nodes.push(root);
    if (root.querySelectorAll) nodes.push(...root.querySelectorAll(revealSelector));
    nodes.forEach((node, index) => {
      if (node.dataset.motionReveal === 'true') return;
      node.dataset.motionReveal = 'true';
      node.style.setProperty('--reveal-delay', `${Math.min(index % 5, 4) * 55}ms`);
      if (!revealObserver) {
        requestAnimationFrame(() => node.classList.add('motion-visible'));
      } else {
        revealObserver.observe(node);
      }
    });
  }

  decorate();
  const mutations = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) decorate(node);
      }
    }
  });
  mutations.observe(app, { childList: true, subtree: true });

  // A tiny cursor-following light makes the hero panel feel tactile on desktop.
  app.addEventListener('pointermove', (event) => {
    if (reducedMotion.matches || !event.target.closest('.hero__panel')) return;
    const panel = event.target.closest('.hero__panel');
    const rect = panel.getBoundingClientRect();
    panel.style.setProperty('--pointer-x', `${((event.clientX - rect.left) / rect.width) * 100}%`);
    panel.style.setProperty('--pointer-y', `${((event.clientY - rect.top) / rect.height) * 100}%`);
  }, { passive: true });

  // Button feedback is delegated so it works on every route, including future views.
  app.addEventListener('click', (event) => {
    const button = event.target.closest('.btn');
    if (!button || button.disabled || reducedMotion.matches) return;
    const rect = button.getBoundingClientRect();
    button.style.setProperty('--tap-x', `${event.clientX ? event.clientX - rect.left : rect.width / 2}px`);
    button.style.setProperty('--tap-y', `${event.clientY ? event.clientY - rect.top : rect.height / 2}px`);
    button.classList.remove('is-tapped');
    void button.offsetWidth;
    button.classList.add('is-tapped');
    window.setTimeout(() => button.classList.remove('is-tapped'), 520);
  });

  // Make the sticky header react softly to scroll, without changing layout.
  const header = document.querySelector('.site-header');
  const syncHeader = () => header?.classList.toggle('is-scrolled', window.scrollY > 8);
  syncHeader();
  window.addEventListener('scroll', syncHeader, { passive: true });

  // Animate cart badges when their displayed count changes.
  const badges = [...document.querySelectorAll('.cart-count')];
  if ('MutationObserver' in window) {
    const badgeObserver = new MutationObserver((records) => {
      if (reducedMotion.matches) return;
      for (const record of records) {
        const badge = record.target;
        if (badge.hidden) continue;
        badge.classList.remove('is-bumping');
        void badge.offsetWidth;
        badge.classList.add('is-bumping');
      }
    });
    badges.forEach((badge) => badgeObserver.observe(badge, { childList: true, characterData: true, subtree: true }));
  }

  reducedMotion.addEventListener?.('change', () => {
    if (!reducedMotion.matches) return;
    app.querySelectorAll('[data-motion-reveal]').forEach((node) => node.classList.add('motion-visible'));
    revealObserver?.disconnect();
  });
}
