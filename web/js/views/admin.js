import * as api from '../api.js';
import { el, linkButton } from '../dom.js';
import { formatNaira } from '../format.js';
import { stateBox, toast } from '../ui.js';
import { trustBadge } from '../components.js';
import { storesPanel, supportPanel } from './admin-care.js';
import { emptyView, formatDate, requireLogin } from './guard.js';

// Administrator workspace. A dispatch desk: find the orders that need a rider, assign one,
// keep an eye on who is on the road, and check the record of changes.
// The server checks the admin role and every change. Hiding a section here is only a convenience.

// Queue order on the dispatch board. Open work first, finished deliveries last.
const QUEUES = [
  { state: 'unassigned', title: 'Needs a rider' },
  { state: 'failed', title: 'Delivery failed' },
  { state: 'assigned', title: 'Assigned, not picked up' },
  { state: 'picked_up', title: 'On the road' },
  { state: 'delivered', title: 'Delivered' },
];

const RIDER_LABEL = { pending: 'Awaiting review', approved: 'Approved', suspended: 'Suspended' };

// Audit entries are written as sentences. Unknown actions fall back to their raw name.
const AUDIT_SENTENCE = {
  'rider.apply': 'applied to deliver',
  'rider.review': 'changed a rider’s status',
  'delivery.assigned': 'assigned an order to a rider',
  'delivery.picked_up': 'marked an order picked up',
  'delivery.completed': 'marked an order delivered',
  'delivery.failed': 'reported a failed delivery',
  'delivery.declined': 'declined a job',
  'account.role_changed': 'changed an account’s role',
  'support.respond': 'answered a customer request',
  'store.verification': 'changed a store’s verification',
};

const plural = (n, word, pluralWord = `${word}s`) => `${n} ${n === 1 ? word : pluralWord}`;

// The order a staff member has just assigned. Its row gets one brief highlight on the next draw.
let justAssigned = null;

export async function renderAdmin() {
  const user = await requireLogin();
  if (!user) return emptyView();
  document.title = 'Administration · Shop n Delight';

  let overview;
  try {
    overview = await api.get('/api/admin/overview');
  } catch (err) {
    if (err.status === 403) {
      return el('div', { class: 'container section--tight' }, stateBox({
        title: 'Administrators only',
        body: 'This area is for Shop n Delight staff. If you should have access, ask an administrator to grant it.',
        iconName: 'shield',
        actions: [linkButton({ href: '#/account', text: 'Back to your account', variant: 'secondary', small: true })],
      }));
    }
    return stateBox({ tone: 'error', title: 'Couldn’t open administration', body: err.message });
  }

  const status = el('p', { class: 'admin-status', 'aria-live': 'polite' });
  const panel = el('div', { class: 'admin-panel', id: 'admin-panel', role: 'tabpanel', 'aria-busy': 'true' });
  const tabs = [
    ['dispatch', 'Dispatch'],
    ['riders', 'Riders'],
    ['support', 'Support'],
    ['stores', 'Stores'],
    ['audit', 'Activity'],
  ];
  let current = 'dispatch';
  const tabButtons = tabs.map(([key, label]) => el('button', {
    type: 'button',
    role: 'tab',
    id: `tab-${key}`,
    'aria-controls': 'admin-panel',
    text: label,
    onclick: () => show(key),
  }));
  const tabList = el('div', { class: 'admin-tabs', role: 'tablist', 'aria-label': 'Administration sections' }, tabButtons);

  function paintStatus(o) {
    const parts = [];
    if (o.unassigned) parts.push(`${plural(o.unassigned, 'order')} ${o.unassigned === 1 ? 'needs' : 'need'} a rider`);
    if (o.failed) parts.push(`${plural(o.failed, 'delivery', 'deliveries')} failed`);
    if (o.onTheRoad) parts.push(`${plural(o.onTheRoad, 'order')} on the road`);
    if (o.ridersAwaitingApproval) parts.push(`${plural(o.ridersAwaitingApproval, 'rider')} awaiting review`);
    status.textContent = parts.length ? `${parts.join('. ')}.` : 'Nothing needs attention right now.';
    const riderTab = tabButtons[1];
    riderTab.dataset.count = o.ridersAwaitingApproval ? String(o.ridersAwaitingApproval) : '';
  }
  paintStatus(overview);

  async function refreshOverview() {
    paintStatus(await api.get('/api/admin/overview'));
  }

  function show(key) {
    current = key;
    for (const b of tabButtons) {
      const selected = b.id === `tab-${key}`;
      b.setAttribute('aria-selected', String(selected));
      b.tabIndex = selected ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', `tab-${key}`);
    loadPanel(key);
  }

  async function loadPanel(key) {
    panel.setAttribute('aria-busy', 'true');
    try {
      if (key === 'dispatch') await dispatchPanel(panel, refreshOverview, () => loadPanel('dispatch'));
      else if (key === 'riders') await ridersPanel(panel, refreshOverview, () => loadPanel('riders'));
      else if (key === 'support') await supportPanel(panel);
      else if (key === 'stores') await storesPanel(panel, refreshOverview);
      else await auditPanel(panel);
    } catch (err) {
      panel.replaceChildren(stateBox({ tone: 'error', title: 'Couldn’t load this section', body: err.message, actions: [linkButton({ text: 'Try again', variant: 'secondary', small: true, onClick: () => loadPanel(key) })] }));
    } finally {
      panel.removeAttribute('aria-busy');
    }
  }

  show('dispatch');

  return el('div', { class: 'container section--tight admin' },
    el('header', { class: 'admin-head' },
      el('div', {},
        el('h1', { tabindex: '-1', text: 'Operations' }, trustBadge('admin')),
        status,
      ),
      el('button', { type: 'button', class: 'btn btn--secondary btn--small', text: 'Refresh', onclick: () => { refreshOverview(); loadPanel(current); } }),
    ),
    tabList,
    panel,
  );
}

// ----- Dispatch -----

async function dispatchPanel(panel, refreshOverview, reload) {
  const [{ items: orders }, { items: riders }] = await Promise.all([
    api.get('/api/admin/orders'),
    api.get('/api/admin/riders'),
  ]);
  const approved = riders.filter((r) => r.status === 'approved');

  if (!orders.length) {
    panel.replaceChildren(stateBox({
      title: 'Nothing to dispatch',
      body: 'Orders appear here once a store marks them ready for pickup.',
      iconName: 'truck',
    }));
    return;
  }

  const groups = QUEUES
    .map((q) => ({ ...q, orders: orders.filter((o) => o.dispatch.state === q.state) }))
    .filter((q) => q.orders.length);

  const table = el('table', { class: 'admin-table dispatch-table' },
    el('caption', { class: 'visually-hidden', text: 'Orders by dispatch state' }),
    el('thead', {},
      el('tr', {},
        el('th', { scope: 'col', text: 'Order' }),
        el('th', { scope: 'col', text: 'Route' }),
        el('th', { scope: 'col', text: 'Customer' }),
        el('th', { scope: 'col', text: 'Total' }),
        el('th', { scope: 'col', text: 'Status' }),
        el('th', { scope: 'col', text: 'Rider' }),
      ),
    ),
    groups.map((g) => el('tbody', { class: 'admin-group', 'data-state': g.state },
      el('tr', { class: 'admin-group__row' },
        el('th', { colspan: 6, scope: 'colgroup', text: `${g.title} · ${g.orders.length}` }),
      ),
      g.orders.map((o) => dispatchRow(o, approved, reload, refreshOverview)),
    )),
  );

  panel.replaceChildren(table);
  justAssigned = null;
}

function dispatchRow(order, approved, reload, refreshOverview) {
  const d = order.delivery;
  const state = order.dispatch.state;
  const cash = order.paymentStatus === 'cod_collected' ? 'Cash collected' : 'Cash on delivery';

  const rider = order.dispatch.rider
    ? el('span', {}, el('strong', { text: order.dispatch.rider.name }), el('br'), el('a', { href: `tel:${order.dispatch.rider.phone}`, text: order.dispatch.rider.phone }))
    : el('span', { class: 'muted', text: '—' });

  let riderCell = rider;
  if (state === 'unassigned' || state === 'assigned' || state === 'failed') {
    const eligible = approved.filter((r) => r.areas.includes(d.area));
    const select = el('select', { class: 'select admin-table__select', 'aria-label': `Rider for order ${order.id}` },
      el('option', { value: '', text: eligible.length ? 'Choose a rider' : `No approved rider covers ${d.area}`, selected: true, disabled: true }),
      eligible.map((r) => el('option', {
        value: r.userId,
        text: `${r.name}, ${r.vehicle}${r.available ? '' : ', offline'}${r.activeCount ? `, ${r.activeCount} active` : ''}`,
      })),
    );
    const button = el('button', {
      type: 'button',
      class: `btn btn--small ${state === 'unassigned' ? 'btn--primary' : 'btn--secondary'}`,
      text: state === 'unassigned' ? 'Assign' : 'Reassign',
      disabled: !eligible.length,
    });
    button.addEventListener('click', async () => {
      if (!select.value) return toast('Choose a rider first.', { tone: 'error' });
      button.disabled = true;
      try {
        await api.post(`/api/admin/orders/${encodeURIComponent(order.id)}/assign`, { riderUserId: select.value });
        justAssigned = order.id;
        toast(`Assigned ${order.id} to ${select.selectedOptions[0].textContent.split(',')[0]}`);
        await reload();
        await refreshOverview();
      } catch (err) {
        toast(err.message, { tone: 'error' });
        button.disabled = false;
        if (err.code === 'status_changed' || err.code === 'invalid_transition') await reload();
      }
    });
    riderCell = el('div', { class: 'admin-table__assign' }, select, button);
  }

  const notes = [];
  if (order.dispatch.proofNote) notes.push(`Received by ${order.dispatch.proofNote}`);
  if (order.dispatch.failureReason) notes.push(`Reason: ${order.dispatch.failureReason}`);

  return el('tr', { class: justAssigned === order.id ? 'is-updated' : null },
    el('td', { 'data-label': 'Order' },
      el('strong', { class: 'admin-id', text: order.id }),
      el('span', { class: 'muted admin-time', text: formatDate(order.createdAt) }),
    ),
    el('td', { 'data-label': 'Route' },
      el('span', { text: order.merchant.name }),
      el('span', { class: 'muted', text: `to ${d.area}, ${d.city}` }),
    ),
    el('td', { 'data-label': 'Customer' },
      el('span', { text: d.name }),
      el('a', { href: `tel:${d.phone}`, text: d.phone, class: 'muted' }),
      el('span', { class: 'muted', text: d.address }),
    ),
    el('td', { 'data-label': 'Total' },
      el('span', { class: 'admin-money', text: formatNaira(order.totalKobo) }),
      el('span', { class: 'muted', text: cash }),
    ),
    el('td', { 'data-label': 'Status' },
      el('span', { class: `badge badge--${state}`, text: QUEUES.find((q) => q.state === state)?.title ?? state }),
      notes.length ? el('span', { class: 'muted', text: notes.join('. ') }) : null,
    ),
    el('td', { 'data-label': 'Rider' }, riderCell),
  );
}

// ----- Riders -----

async function ridersPanel(panel, refreshOverview, reload) {
  const { items } = await api.get('/api/admin/riders');
  if (!items.length) {
    panel.replaceChildren(stateBox({
      title: 'No rider applications yet',
      body: 'People who apply to deliver with Shop n Delight appear here for review.',
      iconName: 'truck',
    }));
    return;
  }
  const table = el('table', { class: 'admin-table riders-table' },
    el('caption', { class: 'visually-hidden', text: 'Riders and their applications' }),
    el('thead', {},
      el('tr', {},
        el('th', { scope: 'col', text: 'Rider' }),
        el('th', { scope: 'col', text: 'Vehicle and areas' }),
        el('th', { scope: 'col', text: 'Status' }),
        el('th', { scope: 'col', text: 'Note' }),
        el('th', { scope: 'col', text: 'Actions' }),
      ),
    ),
    el('tbody', {}, items.map((r) => riderRow(r, reload, refreshOverview))),
  );
  panel.replaceChildren(table);
}

function riderRow(rider, reload, refreshOverview) {
  const note = el('input', { class: 'input admin-table__note', type: 'text', maxlength: 300, placeholder: 'Add a note', 'aria-label': `Note for ${rider.name}`, value: rider.adminNote ?? '' });
  const actions = [];
  const act = (status, label, primary) => {
    const button = el('button', { type: 'button', class: `btn btn--small ${primary ? 'btn--primary' : 'btn--secondary'}`, text: label });
    button.addEventListener('click', async () => {
      if (status === 'suspended' && !window.confirm(`Suspend ${rider.name}? Jobs they have not picked up will go back to dispatch.`)) return;
      button.disabled = true;
      try {
        const body = { status };
        if (note.value.trim()) body.adminNote = note.value.trim();
        await api.patch(`/api/admin/riders/${encodeURIComponent(rider.userId)}`, body);
        toast(`${rider.name} is now ${RIDER_LABEL[status].toLowerCase()}`);
        await reload();
        await refreshOverview();
      } catch (err) {
        toast(err.message, { tone: 'error' });
        button.disabled = false;
      }
    });
    actions.push(button);
  };
  if (rider.status !== 'approved') act('approved', rider.status === 'suspended' ? 'Reinstate' : 'Approve', true);
  if (rider.status === 'approved') act('suspended', 'Suspend', false);
  if (rider.status === 'suspended' || rider.status === 'approved') act('pending', 'Send back to review', false);

  const presence = rider.status !== 'approved'
    ? 'Not taking jobs'
    : rider.available ? 'Online' : 'Offline';

  return el('tr', {},
    el('td', { 'data-label': 'Rider' },
      el('strong', { text: rider.name }),
      el('span', { class: 'muted', text: rider.email }),
      el('a', { href: `tel:${rider.phone}`, class: 'muted', text: rider.phone }),
    ),
    el('td', { 'data-label': 'Vehicle and areas' },
      el('span', { text: rider.vehicle[0].toUpperCase() + rider.vehicle.slice(1) }),
      el('span', { class: 'muted', text: rider.areas.join(', ') }),
    ),
    el('td', { 'data-label': 'Status' },
      el('span', { class: `badge badge--${rider.status}`, text: RIDER_LABEL[rider.status] }),
      el('span', { class: 'muted', text: `${presence} · ${plural(rider.activeCount, 'active job')}` }),
    ),
    el('td', { 'data-label': 'Note' }, note),
    el('td', { 'data-label': 'Actions' }, el('div', { class: 'admin-table__actions' }, actions)),
  );
}

// ----- Activity -----

async function auditPanel(panel) {
  const { items } = await api.get('/api/admin/audit');
  if (!items.length) {
    panel.replaceChildren(stateBox({
      title: 'No activity yet',
      body: 'Rider and dispatch changes appear here as they happen.',
      iconName: 'receipt',
    }));
    return;
  }
  panel.replaceChildren(el('ol', { class: 'timeline', 'aria-label': 'Recent activity' }, items.map((entry) => {
    const who = entry.actor.name ?? 'System';
    const what = AUDIT_SENTENCE[entry.action] ?? entry.action;
    const detail = describeDetail(entry);
    return el('li', { class: 'timeline__item' },
      el('time', { class: 'timeline__time muted', datetime: entry.createdAt, text: formatDate(entry.createdAt) }),
      el('p', {}, el('strong', { text: who }), ` ${what}`, referenceFor(entry)),
      detail ? el('p', { class: 'muted timeline__detail', text: detail }) : null,
    );
  })));
}

function describeDetail(entry) {
  const d = entry.detail ?? {};
  if (entry.action === 'rider.review') {
    const parts = [`Set to ${RIDER_LABEL[d.status]?.toLowerCase() ?? d.status}`];
    if (d.released) parts.push(plural(d.released, 'job returned to dispatch', 'jobs returned to dispatch'));
    if (d.adminNote) parts.push(`Note: ${d.adminNote}`);
    return parts.join('. ');
  }
  if (entry.action === 'delivery.assigned') {
    return d.previousStatus === 'delivery_failed' ? 'Reassigned after a failed delivery' : null;
  }
  if (entry.action === 'delivery.completed' && d.proof) return `Received by ${d.proof}`;
  if (entry.action === 'delivery.failed' && d.reason) return `Reason: ${d.reason}`;
  return null;
}

// Orders keep their readable ID. Riders and accounts are shown by name in the sentence,
// so their raw database identifiers are left out.
function referenceFor(entry) {
  const isIdentifier = /^[0-9a-f-]{36}$/i.test(entry.target);
  return isIdentifier ? null : el('span', { class: 'muted', text: ` · ${entry.target}` });
}
