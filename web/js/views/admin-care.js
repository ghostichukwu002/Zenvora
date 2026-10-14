import * as api from '../api.js';
import { el } from '../dom.js';
import { stateBox, toast } from '../ui.js';
import { formatDate } from './guard.js';

// Administrator panels for customer care requests and store verification.
// The server checks the admin role and records every change in the activity log.

const TOPIC_LABEL = { order: 'My order', payment: 'Payment or refund', delivery: 'Delivery', account: 'My account', other: 'Something else' };
const STATUS_LABEL = { open: 'Open', answered: 'Answered', closed: 'Closed' };
const STATUS_FILTERS = [['open', 'Open'], ['answered', 'Answered'], ['closed', 'Closed'], ['all', 'All']];

export async function supportPanel(panel) {
  const body = el('div', { 'aria-live': 'polite' });
  const buttons = STATUS_FILTERS.map(([value, label]) => el('button', {
    type: 'button',
    class: 'btn btn--small btn--secondary',
    'aria-pressed': 'false',
    text: label,
    dataset: { value },
    onclick: () => load(value),
  }));
  panel.replaceChildren(el('div', { class: 'care-filter', role: 'group', 'aria-label': 'Filter requests' }, buttons), body);

  async function load(filter) {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === filter));
    const query = filter === 'all' ? '' : `?status=${filter}`;
    const { items } = await api.get(`/api/admin/support${query}`);
    if (!items.length) {
      body.replaceChildren(stateBox({
        title: filter === 'open' ? 'No open requests' : 'Nothing here',
        body: 'Customer requests appear here as they arrive.',
        iconName: 'receipt',
      }));
      return;
    }
    body.replaceChildren(el('table', { class: 'admin-table support-table' },
      el('caption', { class: 'visually-hidden', text: 'Customer care requests' }),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col', text: 'Request' }),
        el('th', { scope: 'col', text: 'Customer' }),
        el('th', { scope: 'col', text: 'Message' }),
        el('th', { scope: 'col', text: 'Reply and status' }),
      )),
      el('tbody', {}, items.map((r) => requestRow(r, () => load(currentFilter(buttons))))),
    ));
  }

  await load('open');
}

const currentFilter = (buttons) => buttons.find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.value ?? 'open';

function requestRow(r, reloadList) {
  const reply = el('textarea', {
    class: 'input care-reply',
    rows: 3,
    maxlength: 2000,
    placeholder: r.reply ? 'Send another reply' : 'Write a reply the customer will see in their account',
    'aria-label': `Reply to ${r.id}`,
  });
  const status = el('select', { class: 'select admin-table__select', 'aria-label': `Status for ${r.id}` },
    ['open', 'answered', 'closed'].map((value) => el('option', { value, text: STATUS_LABEL[value], selected: value === r.status })),
  );
  const save = el('button', { type: 'button', class: 'btn btn--primary btn--small', text: 'Save' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const body = { status: status.value };
      if (reply.value.trim()) body.reply = reply.value.trim();
      await api.patch(`/api/admin/support/${encodeURIComponent(r.id)}`, body);
      toast(body.reply ? 'Reply saved for the customer' : 'Status saved');
      reloadList();
    } catch (err) {
      toast(err.message, { tone: 'error' });
      save.disabled = false;
    }
  });

  const order = r.orderId ? el('p', { class: 'muted', text: `Order ${r.orderId}` }) : null;
  return el('tr', {},
    el('td', { 'data-label': 'Request' },
      el('span', { class: 'admin-id', text: r.id }),
      el('div', {}, el('strong', { text: TOPIC_LABEL[r.topic] ?? r.topic })),
      order,
      el('p', { class: 'muted', text: formatDate(r.createdAt) }),
    ),
    el('td', { 'data-label': 'Customer' }, el('div', {}, r.customer.name ?? 'Deleted account'), el('p', { class: 'muted', text: r.customer.email ?? '' })),
    el('td', { 'data-label': 'Message' }, el('p', { text: r.message }), r.reply ? el('p', { class: 'muted', text: `Last reply: ${r.reply}` }) : null),
    el('td', { 'data-label': 'Reply and status' },
      el('div', { class: 'admin-table__assign' }, status, save),
      reply,
    ),
  );
}

export async function storesPanel(panel, refreshOverview) {
  const { items } = await api.get('/api/admin/stores');
  const table = el('table', { class: 'admin-table stores-table' },
    el('caption', { class: 'visually-hidden', text: 'Stores and verification' }),
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col', text: 'Store' }),
      el('th', { scope: 'col', text: 'Location' }),
      el('th', { scope: 'col', text: 'Verification' }),
      el('th', { scope: 'col', text: 'Action' }),
    )),
    el('tbody', {}, items.map((store) => storeRow(store, () => storesPanel(panel, refreshOverview)))),
  );
  panel.replaceChildren(table);
}

function storeRow(store, reload) {
  const button = el('button', {
    type: 'button',
    class: `btn btn--small ${store.verified ? 'btn--secondary' : 'btn--primary'}`,
    text: store.verified ? 'Remove verification' : 'Verify store',
  });
  button.addEventListener('click', async () => {
    if (store.verified && !window.confirm(`Remove the verified badge from ${store.name}?`)) return;
    button.disabled = true;
    try {
      await api.patch(`/api/admin/stores/${encodeURIComponent(store.id)}`, { verified: !store.verified });
      toast(store.verified ? `${store.name} is no longer verified` : `${store.name} is verified`);
      await reload();
    } catch (err) {
      toast(err.message, { tone: 'error' });
      button.disabled = false;
    }
  });
  return el('tr', { class: store.verified ? 'is-verified' : undefined },
    el('td', { 'data-label': 'Store' }, el('strong', { text: store.name })),
    el('td', { 'data-label': 'Location', text: `${store.city}, ${store.state}` }),
    el('td', { 'data-label': 'Verification' },
      el('span', { class: `badge ${store.verified ? 'badge--approved' : 'badge--pending'}`, text: store.verified ? 'Verified' : 'Not verified' }),
      store.verified && store.verifiedAt ? el('p', { class: 'muted', text: `Since ${formatDate(store.verifiedAt)}` }) : null,
    ),
    el('td', { 'data-label': 'Action' }, el('div', { class: 'admin-table__actions' }, button)),
  );
}
