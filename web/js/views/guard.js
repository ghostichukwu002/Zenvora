import { el } from '../dom.js';
import { ensureUser } from '../state.js';

// Pages that need an account call this first. This is a convenience for the visitor:
// the server independently refuses every protected request without a valid session.
// Returns the user, or null after sending the visitor to the login page.
export async function requireLogin() {
  const user = await ensureUser();
  if (user) return user;
  const here = window.location.hash || '#/';
  window.location.hash = `#/login?next=${encodeURIComponent(here)}`;
  return null;
}

export const emptyView = () => el('div');

const dateFormat = new Intl.DateTimeFormat('en-NG', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Lagos',
});

export function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dateFormat.format(d);
}

export const ORDER_STATUS_LABEL = {
  placed: 'Placed',
};

export const PAYMENT_LABEL = {
  cod_pending: 'Pay on delivery',
};
