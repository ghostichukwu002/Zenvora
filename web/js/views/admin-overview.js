import * as api from '../api.js';
import { el } from '../dom.js';
import { formatCount, formatNaira } from '../format.js';
import { stateBox } from '../ui.js';

// The administrator's home screen: the day at a glance, a two-week trend, where the money comes
// from by storefront, what orders are doing, and what sells. Every figure is read from the server.

const STATUS_ORDER = [
  ['placed', 'Placed'],
  ['accepted', 'Accepted'],
  ['preparing', 'Preparing'],
  ['ready', 'Ready for pickup'],
  ['out_for_delivery', 'On the road'],
  ['delivered', 'Delivered'],
  ['delivery_failed', 'Delivery failed'],
  ['rejected', 'Rejected'],
];

const dayLabel = new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });

export async function overviewPanel(panel, { overview, goTo }) {
  const data = await api.get('/api/admin/insights');
  const dayName = new Intl.DateTimeFormat('en-NG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Lagos' }).format(new Date());

  const kpis = [
    kpi({ label: 'Orders today', value: formatCount(data.today.orders, 'order'), hint: formatNaira(data.today.revenueKobo) + ' taken today', tone: 'indigo' }),
    kpi({ label: 'Needs a rider', value: String(overview.unassigned), hint: overview.unassigned ? 'Assign one to keep orders moving' : 'Nothing waiting', tone: overview.unassigned ? 'amber' : 'green', onClick: () => goTo('dispatch') }),
    kpi({ label: 'On the road', value: String(overview.onTheRoad), hint: `${data.ridersOnline} rider${data.ridersOnline === 1 ? '' : 's'} online now`, tone: 'blue' }),
    kpi({ label: 'Last 14 days', value: formatNaira(data.last14Days.revenueKobo), hint: formatCount(data.last14Days.orders, 'order'), tone: 'orange' }),
  ];

  const attention = [
    overview.ridersAwaitingApproval ? { text: `${overview.ridersAwaitingApproval} rider application${overview.ridersAwaitingApproval === 1 ? '' : 's'} to review`, tab: 'riders' } : null,
    overview.failed ? { text: `${overview.failed} failed deliver${overview.failed === 1 ? 'y' : 'ies'} to follow up`, tab: 'dispatch' } : null,
  ].filter(Boolean);

  panel.replaceChildren(...[
    el('div', { class: 'dash-kpis' }, kpis),
    attention.length ? attentionCard(attention, goTo) : null,
    el('div', { class: 'dash-grid dash-grid--main' }, trendCard(data), sectionCard(data)),
    el('div', { class: 'dash-grid dash-grid--two' }, statusCard(data), topProductsCard(data)),
    el('p', { class: 'dash-foot muted', text: `Figures for ${dayName}. Revenue leaves out rejected orders.` }),
  ].filter(Boolean));
}

// Bar widths are set through the style property, not a style attribute: the site's Content
// Security Policy allows script-set styles but not inline style attributes.
function fill(tone, percent) {
  const node = el('span', { class: `dash-bar__fill ${tone}` });
  node.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  return node;
}

function kpi({ label, value, hint, tone, onClick }) {
  const body = el('div', { class: `dash-kpi dash-kpi--${tone}` },
    el('span', { class: 'dash-kpi__label', text: label }),
    el('strong', { class: 'dash-kpi__value', text: value }),
    el('span', { class: 'dash-kpi__hint', text: hint }),
  );
  if (!onClick) return body;
  body.setAttribute('role', 'button');
  body.tabIndex = 0;
  body.addEventListener('click', onClick);
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } });
  return body;
}

function card(title, subtitle, ...children) {
  return el('section', { class: 'dash-card' },
    el('header', { class: 'dash-card__head' },
      el('div', {}, el('h2', { text: title }), subtitle ? el('p', { class: 'muted', text: subtitle }) : null),
    ),
    ...children,
  );
}

// Orders per day as bars, with the naira total in each bar's tooltip. Built from numbers only.
function trendCard(data) {
  const days = data.days;
  const max = Math.max(1, ...days.map((d) => d.orders));
  const width = 640;
  const height = 200;
  const pad = 28;
  const slot = (width - pad * 2) / days.length;
  const bar = slot * 0.62;
  const bars = days.map((d, i) => {
    const h = Math.round((d.orders / max) * (height - pad - 12));
    const x = pad + i * slot + (slot - bar) / 2;
    const y = height - pad - h;
    const label = dayLabel.format(new Date(`${d.date}T12:00:00+01:00`));
    const title = `${label}: ${d.orders} order${d.orders === 1 ? '' : 's'}, ${formatNaira(d.revenueKobo)}`;
    const tickEvery = days.length > 7 ? 2 : 1;
    const tick = i % tickEvery === 0 || i === days.length - 1
      ? `<text x="${(x + bar / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle" class="dash-chart__tick">${label}</text>`
      : '';
    return `<g><title>${title}</title><rect x="${x.toFixed(1)}" y="${y}" width="${bar.toFixed(1)}" height="${Math.max(h, 2)}" rx="6" class="dash-chart__bar${i === days.length - 1 ? ' is-today' : ''}"/>${tick}</g>`;
  }).join('');
  const svg = el('div', { class: 'dash-chart', role: 'img', 'aria-label': `Orders per day for the last 14 days. ${data.last14Days.orders} orders in total.` });
  svg.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" focusable="false">${bars}</svg>`;

  return card('Orders, last 14 days', `${formatCount(data.last14Days.orders, 'order')} · ${formatNaira(data.last14Days.revenueKobo)}`, svg);
}

// Revenue split between the two storefronts.
function sectionCard(data) {
  const shop = data.sections.shop;
  const puff = data.sections.puff;
  const total = Math.max(1, shop.revenueKobo + puff.revenueKobo);
  const row = (name, tone, s) => {
    const share = Math.round((s.revenueKobo / total) * 100);
    return el('div', { class: 'dash-split__row' },
      el('div', { class: 'dash-split__head' },
        el('span', { class: `dash-dot dash-dot--${tone}` }),
        el('strong', { text: name }),
        el('span', { class: 'muted', text: `${formatCount(s.orders, 'order')}` }),
      ),
      el('div', { class: 'dash-bar', role: 'img', 'aria-label': `${name} is ${share} percent of revenue` },
        fill(`dash-bar__fill--${tone}`, share),
      ),
      el('div', { class: 'dash-split__foot' }, el('span', { text: formatNaira(s.revenueKobo) }), el('span', { class: 'muted', text: `${share}%` })),
    );
  };
  return card('Where sales come from', 'Shop n Delight and Puff & Sip', row('Shop n Delight', 'orange', shop), row('Puff & Sip', 'blue', puff));
}

function statusCard(data) {
  const counts = data.statuses;
  const total = Math.max(1, Object.values(counts).reduce((a, b) => a + b, 0));
  const rows = STATUS_ORDER.map(([key, label]) => {
    const n = counts[key] ?? 0;
    return el('li', { class: 'dash-status' },
      el('span', { class: 'dash-status__label', text: label }),
      el('div', { class: 'dash-bar dash-bar--thin', 'aria-hidden': 'true' }, fill('dash-bar__fill--indigo', Math.round((n / total) * 100))),
      el('strong', { class: 'dash-status__count', text: String(n) }),
    );
  });
  return card('Order status', 'Every order placed so far', el('ul', { class: 'dash-status-list' }, rows));
}

function topProductsCard(data) {
  const body = data.topProducts.length
    ? el('ol', { class: 'dash-top' }, data.topProducts.map((p) => el('li', { class: 'dash-top__item' },
        el('div', {}, el('strong', { text: p.name }), el('p', { class: 'muted', text: `${p.quantity} sold` })),
        el('span', { class: 'dash-top__amount', text: formatNaira(p.revenueKobo) }),
      )))
    : el('p', { class: 'muted', text: 'No sales yet. Top products appear here once orders come in.' });
  return card('Best sellers', 'By revenue, across both storefronts', body);
}

function attentionCard(items, goTo) {
  return el('section', { class: 'dash-card dash-card--attention', 'aria-labelledby': 'dash-attention' },
    el('h2', { id: 'dash-attention', text: 'Needs your attention' }),
    el('ul', { class: 'dash-attention' }, items.map((i) => el('li', {},
      el('span', { text: i.text }),
      el('button', { type: 'button', class: 'btn btn--secondary btn--small', text: 'Open', onclick: () => goTo(i.tab) }),
    ))),
  );
}

