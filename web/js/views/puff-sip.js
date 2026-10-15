import { el, icon, linkButton } from '../dom.js';

function collectionCard({ eyebrow, title, body, href, iconName, tone }) {
  return el(
    'a',
    { class: `puff-collection-card puff-collection-card--${tone}`, href, 'data-reveal': '' },
    el('span', { class: 'puff-collection-card__icon', 'aria-hidden': 'true' }, icon(iconName)),
    el('span', { class: 'puff-collection-card__eyebrow', text: eyebrow }),
    el('strong', { class: 'puff-collection-card__title', text: title }),
    el('span', { class: 'puff-collection-card__body', text: body }),
    el('span', { class: 'puff-collection-card__arrow', 'aria-hidden': 'true', text: '↗' }),
  );
}

export function renderPuffSip() {
  const hero = el(
    'section',
    { class: 'puff-hero' },
    el(
      'div',
      { class: 'puff-hero__copy' },
      el('p', { class: 'puff-eyebrow' }, el('span', { class: 'puff-eyebrow__dot', 'aria-hidden': 'true' }), 'THE PUFF & SIP SECTION'),
      el('h1', {}, 'Little treats. ', el('span', { text: 'Big mood.' })),
      el('p', {
        class: 'puff-hero__lede',
        text: 'Meet your new favourite corner of the shop. Take a look around, find your picks, and make the moment yours.',
      }),
      el(
        'div',
        { class: 'puff-hero__actions' },
        linkButton({ href: '#/puff-sip/shop', text: 'Explore the collection' }),
        linkButton({ href: '#/puff-sip/shop?q=sip', text: 'Find your sip', variant: 'secondary' }),
      ),
      el(
        'div',
        { class: 'puff-hero__note' },
        el('span', { class: 'puff-hero__note-mark', 'aria-hidden': 'true', text: '✳' }),
        el('span', { text: 'For adults 18 and over. A little something for your kind of day.' }),
      ),
    ),
    el(
      'aside',
      { class: 'puff-art', 'aria-label': 'Puff and Sip brand artwork' },
      el('span', { class: 'puff-art__orbit puff-art__orbit--one', 'aria-hidden': 'true' }),
      el('span', { class: 'puff-art__orbit puff-art__orbit--two', 'aria-hidden': 'true' }),
      el('span', { class: 'puff-art__spark puff-art__spark--one', 'aria-hidden': 'true' }, '✳'),
      el('span', { class: 'puff-art__spark puff-art__spark--two', 'aria-hidden': 'true' }, '✦'),
      el(
        'div',
        { class: 'puff-art__badge puff-art__badge--puff' },
        el('span', { class: 'puff-art__badge-kicker', text: 'THE' }),
        el('strong', { text: 'PUFF' }),
        el('span', { text: 'SIDE OF THE MOOD' }),
      ),
      el(
        'div',
        { class: 'puff-art__cup', 'aria-hidden': 'true' },
        el('span', { class: 'puff-art__straw' }),
        el('span', { class: 'puff-art__cup-rim' }),
        el('span', { class: 'puff-art__cup-label', text: 'SIP' }),
        el('span', { class: 'puff-art__cup-shine' }),
      ),
      el('span', { class: 'puff-art__caption', text: 'GOOD THINGS, GOOD ENERGY.' }),
    ),
  );

  const collections = el(
    'section',
    { class: 'puff-section', 'aria-labelledby': 'puff-collections-title' },
    el(
      'div',
      { class: 'puff-section__head' },
      el('div', {},
        el('p', { class: 'puff-section__kicker', text: 'PICK YOUR LANE' }),
        el('h2', { id: 'puff-collections-title' }, 'What are we in the mood for?'),
        el('p', { class: 'puff-section__lede', text: 'Start with a vibe. The collection is only a tap away.' }),
      ),
      el('a', { class: 'puff-text-link', href: '#/puff-sip/shop', text: 'Browse everything ↗' }),
    ),
    el(
      'div',
      { class: 'puff-collection-grid' },
      collectionCard({
        eyebrow: 'THE PUFF SIDE',
        title: 'Puff picks',
        body: 'Explore the puff side of the collection.',
        href: '#/puff-sip/shop?q=puff',
        iconName: 'box',
        tone: 'orange',
      }),
      collectionCard({
        eyebrow: 'THE SIP SIDE',
        title: 'Sip picks',
        body: 'Find something that hits the spot.',
        href: '#/puff-sip/shop?q=sip',
        iconName: 'drop',
        tone: 'navy',
      }),
      collectionCard({
        eyebrow: 'A LITTLE OF BOTH',
        title: 'Good together',
        body: 'Look for pairings and easy favourites.',
        href: '#/puff-sip/shop?q=vape',
        iconName: 'basket',
        tone: 'cream',
      }),
    ),
  );

  const promise = el(
    'section',
    { class: 'puff-promise', 'aria-labelledby': 'puff-promise-title' },
    el(
      'div',
      { class: 'puff-promise__copy' },
      el('p', { class: 'puff-section__kicker', text: 'MADE TO FEEL EASY' }),
      el('h2', { id: 'puff-promise-title' }, 'Your favourites, without the fuss.'),
      el('p', { text: 'Browse at your pace, check the details, and add what you came for. We’re shaping the shopping flow around the way this store actually works.' }),
    ),
    el(
      'div',
      { class: 'puff-promise__steps' },
      el('div', { class: 'puff-promise__step' }, el('span', { class: 'puff-promise__number', text: '01' }), el('div', {}, el('strong', { text: 'Find your picks' }), el('p', { text: 'Use the collection links or search the catalogue.' }))),
      el('div', { class: 'puff-promise__step' }, el('span', { class: 'puff-promise__number', text: '02' }), el('div', {}, el('strong', { text: 'Check your order' }), el('p', { text: 'Keep your order details handy after checkout.' }))),
      el('div', { class: 'puff-promise__step' }, el('span', { class: 'puff-promise__number', text: '03' }), el('div', {}, el('strong', { text: 'Stay in the loop' }), el('p', { text: 'Order collection and dispatch details will be shown as the checkout flow is completed.' }))),
    ),
  );

  const closing = el(
    'section',
    { class: 'puff-closing' },
    el('span', { class: 'puff-closing__asterisk', 'aria-hidden': 'true' }, '✳'),
    el('div', {},
      el('p', { class: 'puff-section__kicker', text: 'YOUR NEXT FAVOURITE IS OUT THERE' }),
      el('h2', { text: 'Come find your thing.' }),
    ),
    linkButton({ href: '#/puff-sip/shop', text: 'Browse all products' }),
  );

  return el(
    'div',
    { class: 'puff-sip-page' },
    el('div', { class: 'puff-topline' }, el('span', { text: 'PUFF & SIP' }), el('span', { class: 'puff-topline__separator', 'aria-hidden': 'true' }), el('span', { text: 'A SHOP N DELIGHT SECTION' })),
    el('div', { class: 'container puff-sip-page__content' }, hero, collections, promise, closing),
  );
}
