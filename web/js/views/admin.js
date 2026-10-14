import * as api from '../api.js';
import { el, linkButton } from '../dom.js';
import { formatNaira } from '../format.js';
import { stateBox, toast } from '../ui.js';
import { emptyView, formatDate, requireLogin } from './guard.js';

// Administrator workspace: dispatch, rider approvals and the audit log.
// The server checks the admin role on every request. Hiding the page is only a convenience.

const DISPATCH_LABEL = {
  unassigned: 'Needs a rider',
  assigned: 'Assigned, not picked up',
  picked_up: 'On the way',
  failed: 'Delivery failed',
  delivered: 'Delivered',
};

const RIDER_LABEL = { pending: 'Awaiting approval', approved: 'Approved', suspended: 'Suspended' };

const TABS = [
  ['dispatch', 'Dispatch'],
  ['riders', 'Riders'],
  ['audit', 'Audit log'],
];

export async function renderAdmin() {
  const user = await requireLogin();
  if (!user) return emptyView();
  document.title = 'Administration · ZENVORA';

  let overview;
  try {
    overview = await api.get('/api/admin/overview');
  } catch (err) {
    if (err.status === 403) {
      return el('div', { class: 'container section--tight' }, stateBox({
        title: 'Administrators only',
        body: 'This area is for ZENVORA staff. If you should have access, ask an administrator.',
        iconName: 'shield',
        actions: [linkButton({ href: '#/account', text: 'Back to your account', variant: 'secondary', small: true })],
      }));
    }
    return stateBox({ tone: 'error', title: 'Couldn’t open administration', body: err.message });
  }

  const summaryBox = el('dl', { class: 'admin-summary', 'aria-live': 'polite' });
  const panel = el('div', { class: 'admin-panel', 'aria-busy': 'true' });
  let current = 'dispatch';

  const tabButtons = TABS.map(([key, label]) => el('button', {
    type: 'button',
    role: 'tab',
    id: `tab-${key}`,
    'aria-controls': 'admin-panel',
    'aria-selected': String(key === current),
    tabindex: key === current ? '0' : '-1',
    text: label,
    onclick: () => show(key),
  }));
  const tabList = el('div', { class: 'admin-tabs', role: 'tablist', 'aria-label': 'Administration sections' }, tabButtons);

  function paintSummary(o) {
    const rows = [
      ['Riders awaiting approval', o.ridersAwaitingApproval],
      ['Ready for pickup', o.readyForPickup],
      ['Need a rider', o.unassigned],
      ['On the road', o.onTheRoad],
      ['Delivery failed', o.failed],
    ];
    summaryBox.replaceChildren(...rows.map(([label, n]) => el('div', { class: 'admin-summary__item' }, el('dt', { text: label }), el('dd', { text: String(n) }))));
  }
  paintSummary(overview);

  async function refreshOverview() {
    paintSummary(await api.get('/api/admin/overview'));
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
      else await auditPanel(panel);
    } catch (err) {
      panel.replaceChildren(stateBox({ tone: 'error', title: 'Couldn’t load this section', body: err.message, actions: [linkButton({ text: 'Try again', variant: 'secondary', small: true, onClick: () => loadPanel(key) })] }));
    } finally {
      panel.removeAttribute('aria-busy');
    }
  }

  panel.id = 'admin-panel';
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', 'tab-dispatch');
  show('dispatch');

  return el('div', { class: 'container section--tight' },
    el('div', { class: 'section__head' }, el('div', {}, el('h1', { tabindex: '-1', text: 'Administration' }), el('p', { class: 'muted', text: 'Dispatch, riders and the record of changes.' }))),
    summaryBox,
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

  // Open work first, finished deliveries last. Empty groups are not shown.
  const sections = ['unassigned', 'failed', 'assigned', 'picked_up', 'delivered']
    .map((state) => ({ state, orders: orders.filter((o) => o.dispatch.state === state) }))
    .filter((g) => g.orders.length)
    .map((g) => dispatchGroup(g, approved, reload, refreshOverview));
  if (!orders.length) {
    sections.unshift(stateBox({ title: 'Nothing to dispatch', body: 'Orders appear here once the kitchen, market or shop marks them ready.', iconName: 'truck' }));
  }
  panel.replaceChildren(...sections);
}

function dispatchGroup({ state, orders }, approved, reload, refreshOverview) {
  return el('section', { class: 'admin-group', 'aria-labelledby': `group-${state}` },
    el('h2', { id: `group-${state}`, text: `${DISPATCH_LABEL[state]} (${orders.length})` }),
    el('ul', { class: 'admin-list' }, orders.map((o) => dispatchRow(o, approved, reload, refreshOverview))),
  );
}

function dispatchRow(order, approved, reload, refreshOverview) {
  const d = order.delivery;
  const info = el('div', { class: 'admin-row__info' },
    el('div', { class: 'admin-row__head' }, el('strong', { text: order.id }), el('span', { class: 'badge', text: DISPATCH_LABEL[order.dispatch.state] })),
    el('p', { class: 'muted', text: `${order.merchant.name} → ${d.area}, ${d.city} · ${formatNaira(order.totalKobo)} · ${order.paymentStatus === 'cod_collected' ? 'Cash collected' : 'Cash on delivery'}` }),
    el('p', { class: 'muted', text: `${d.name} · ${d.phone} · ${d.address}` }),
  );

  const { state } = order.dispatch;
  const details = [];
  if (order.dispatch.rider) {
    details.push(el('p', { class: 'admin-row__rider', text: `Rider: ${order.dispatch.rider.name} · ${order.dispatch.rider.phone}` }));
  }
  if (order.dispatch.proofNote) details.push(el('p', { class: 'muted', text: `Proof: ${order.dispatch.proofNote}` }));
  if (order.dispatch.failureReason) details.push(el('p', { class: 'muted', text: `Reason: ${order.dispatch.failureReason}` }));

  // Only ready or failed orders can be assigned. Riders must cover the order's area.
  const assignable = state === 'unassigned' || state === 'assigned' || state === 'failed';
  let controls = null;
  if (assignable) {
    const eligible = approved.filter((r) => r.areas.includes(d.area));
    const select = el('select', { class: 'select', 'aria-label': `Rider for order ${order.id}` },
      el('option', { value: '', text: eligible.length ? 'Choose a rider' : `No approved rider covers ${d.area}`, selected: true, disabled: true }),
      eligible.map((r) => el('option', { value: r.userId, text: `${r.name} · ${r.vehicle}${r.available ? '' : ' (offline)'}${r.activeCount ? ` · ${r.activeCount} active` : ''}` })),
    );
    const button = el('button', { type: 'button', class: 'btn btn--primary btn--small', text: state === 'unassigned' ? 'Assign' : 'Reassign', disabled: !eligible.length });
    button.addEventListener('click', async () => {
      if (!select.value) return toast('Choose a rider first.', { tone: 'error' });
      button.disabled = true;
      try {
        await api.post(`/api/admin/orders/${encodeURIComponent(order.id)}/assign`, { riderUserId: select.value });
        toast(`Assigned ${order.id}`);
        await reload();
        await refreshOverview();
      } catch (err) {
        toast(err.message, { tone: 'error' });
        button.disabled = false;
        if (err.code === 'status_changed' || err.code === 'invalid_transition') await reload();
      }
    });
    controls = el('div', { class: 'admin-row__controls' }, select, button);
  }

  return el('li', { class: 'admin-row' }, info, ...details, controls);
}

// ----- Riders -----

async function ridersPanel(panel, refreshOverview, reload) {
  const { items } = await api.get('/api/admin/riders');
  if (!items.length) {
    panel.replaceChildren(stateBox({ title: 'No rider applications yet', body: 'Applications from people who want to deliver with ZENVORA appear here.', iconName: 'truck' }));
    return;
  }
  panel.replaceChildren(el('ul', { class: 'admin-list' }, items.map((r) => riderRow(r, reload, refreshOverview))));
}

function riderRow(rider, reload, refreshOverview) {
  const note = el('input', { class: 'input', type: 'text', maxlength: 300, placeholder: 'Note (optional)', 'aria-label': `Note for ${rider.name}`, value: rider.adminNote ?? '' });
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
        toast(`${rider.name}: ${RIDER_LABEL[status].toLowerCase()}`);
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
  if (rider.status === 'suspended' || rider.status === 'approved') act('pending', 'Return to review', false);

  return el('li', { class: 'admin-row' },
    el('div', { class: 'admin-row__info' },
      el('div', { class: 'admin-row__head' }, el('strong', { text: rider.name }), el('span', { class: `badge badge--${rider.status}`, text: RIDER_LABEL[rider.status] })),
      el('p', { class: 'muted', text: `${rider.email} · ${rider.phone} · ${rider.vehicle}` }),
      el('p', { class: 'muted', text: `Areas: ${rider.areas.join(', ')}` }),
      el('p', { class: 'muted', text: `${rider.status === 'approved' ? (rider.available ? 'Online' : 'Offline') : 'Not taking jobs'} · ${rider.activeCount} active · applied ${formatDate(rider.createdAt)}` }),
    ),
    el('div', { class: 'admin-row__controls' }, note, ...actions),
  );
}

// ----- Audit log -----

async function auditPanel(panel) {
  const { items } = await api.get('/api/admin/audit');
  if (!items.length) {
    panel.replaceChildren(stateBox({ title: 'No activity yet', body: 'Dispatch and rider changes are recorded here.', iconName: 'receipt' }));
    return;
  }
  panel.replaceChildren(el('ul', { class: 'admin-list admin-list--audit' }, items.map((entry) =>
    el('li', { class: 'admin-row admin-row--audit' },
      el('div', { class: 'admin-row__head' }, el('strong', { text: entry.action }), el('span', { class: 'muted', text: formatDate(entry.createdAt) })),
      el('p', { class: 'muted', text: `${entry.actor.name ?? 'System'}${entry.actor.email ? ` (${entry.actor.email})` : ''} → ${entry.target}` }),
      Object.keys(entry.detail).length ? el('p', { class: 'muted admin-row__detail', text: JSON.stringify(entry.detail) }) : null,
    ),
  )));
}
