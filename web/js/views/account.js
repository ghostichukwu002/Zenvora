import * as api from '../api.js';
import { el, linkButton } from '../dom.js';
import { field, formMessage, guardedSubmit } from '../form.js';
import { formatNaira } from '../format.js';
import { trustBadge } from '../components.js';
import { loadCart, setUser } from '../state.js';
import { stateBox, toast } from '../ui.js';
import { emptyView, formatDate, ORDER_STATUS_LABEL, requireLogin } from './guard.js';

export async function renderAccount() {
  const user = await requireLogin();
  if (!user) return emptyView();
  document.title = 'Your account · Shop n Delight';

  // ----- Profile -----
  const name = field({ name: 'fullName', label: 'Full name', autocomplete: 'name', value: user.fullName, maxlength: 100 });
  const phone = field({
    name: 'phone',
    label: 'Phone number',
    type: 'tel',
    autocomplete: 'tel',
    inputmode: 'tel',
    required: false,
    value: user.phone ?? '',
    hint: 'Nigerian mobile number, for example 0803 123 4567.',
  });
  const email = field({ name: 'email', label: 'Email', value: user.email, readonly: true, hint: 'Your email can’t be changed here yet.' });
  const message = formMessage();
  const save = el('button', { type: 'submit', class: 'btn btn--primary', text: 'Save changes' });
  const form = el('form', { class: 'form', novalidate: true }, email.node, name.node, phone.node, message.node, save);

  guardedSubmit(form, save, 'Saving…', async () => {
    name.setError('');
    phone.setError('');
    message.show('');
    try {
      const res = await api.patch('/api/auth/profile', { fullName: name.value, phone: phone.value });
      setUser(res.user);
      phone.input.value = res.user.phone ?? '';
      toast('Profile saved');
    } catch (err) {
      if (err.code === 'name_invalid') name.setError(err.message);
      else if (err.code === 'phone_invalid') phone.setError(err.message);
      else message.show(err.message);
    }
  });

  // ----- Orders -----
  const ordersBox = el('div', { 'aria-busy': 'true' }, el('p', { class: 'muted', text: 'Loading your orders…' }));
  const loadOrders = async () => {
    try {
      const { items } = await api.get('/api/orders');
      if (!items.length) {
        ordersBox.replaceChildren(
          stateBox({
            title: 'No orders yet',
            body: 'When you place an order, it will show up here.',
            actions: [linkButton({ href: '#/shop', text: 'Start shopping' })],
            iconName: 'receipt',
          }),
        );
      } else {
        ordersBox.replaceChildren(el('ul', { class: 'order-list' }, items.map(orderRow)));
      }
    } catch (err) {
      ordersBox.replaceChildren(
        stateBox({
          tone: 'error',
          title: 'We couldn’t load your orders',
          body: err.message,
          actions: [linkButton({ text: 'Try again', variant: 'secondary', small: true, onClick: loadOrders })],
        }),
      );
    } finally {
      ordersBox.removeAttribute('aria-busy');
    }
  };
  loadOrders();

  const logout = el('button', {
    type: 'button',
    class: 'btn btn--secondary btn--small',
    text: 'Log out',
    onclick: async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await api.post('/api/auth/logout', {});
        setUser(null);
        await loadCart();
        toast('You’re logged out');
        window.location.hash = '#/';
      } catch (err) {
        button.disabled = false;
        toast(err.message, { tone: 'error' });
      }
    },
  });

  return el(
    'div',
    { class: 'container section--tight account-page' },
    el('div', { class: 'section__head account-hero' }, el('div', { class: 'account-hero__identity' }, el('div', { class: 'account-avatar', 'aria-hidden': 'true', text: (user.fullName || user.email || 'Z').trim().charAt(0).toUpperCase() }), el('div', { class: 'account-hero__copy' }, el('p', { class: 'account-kicker', text: 'YOUR Shop n Delight' }), el('h1', { tabindex: '-1', text: 'Your account' }, user.role === 'admin' ? trustBadge('admin') : null), el('p', { class: 'account-email', text: user.email }))), el('div', { class: 'account-hero__actions' }, logout)),
    el('nav', { class: 'account-links', 'aria-label': 'Your services' }, el('a', { class: 'account-link', href: '#/help' }, el('span', { class: 'account-link__icon', 'aria-hidden': 'true', text: '✳' }), el('span', { class: 'account-link__copy' }, el('strong', { text: 'Customer care' }), el('small', { text: 'Get help with an order' })), el('span', { class: 'account-link__arrow', 'aria-hidden': 'true', text: '↗' })), el('a', { class: 'account-link', href: '#/merchant' }, el('span', { class: 'account-link__icon', 'aria-hidden': 'true', text: '▦' }), el('span', { class: 'account-link__copy' }, el('strong', { text: 'Store dashboard' }), el('small', { text: 'Manage your store' })), el('span', { class: 'account-link__arrow', 'aria-hidden': 'true', text: '↗' })), el('a', { class: 'account-link', href: '#/rider' }, el('span', { class: 'account-link__icon', 'aria-hidden': 'true', text: '➜' }), el('span', { class: 'account-link__copy' }, el('strong', { text: 'Deliver with Shop n Delight' }), el('small', { text: 'Delivery partner tools' })), el('span', { class: 'account-link__arrow', 'aria-hidden': 'true', text: '↗' })), user.role === 'admin' ? el('a', { class: 'account-link account-link--admin', href: '#/admin' }, el('span', { class: 'account-link__icon', 'aria-hidden': 'true', text: '⌘' }), el('span', { class: 'account-link__copy' }, el('strong', { text: 'Administration' }), el('small', { text: 'Manage the marketplace' })), el('span', { class: 'account-link__arrow', 'aria-hidden': 'true', text: '↗' })) : null),
    el(
      'div',
      { class: 'account-grid' },
      el('section', { class: 'account-panel account-panel--orders', 'aria-labelledby': 'orders-title' }, el('div', { class: 'account-panel__head' }, el('div', {}, el('p', { class: 'account-kicker', text: 'YOUR ACTIVITY' }), el('h2', { id: 'orders-title', text: 'Your orders' })), el('a', { class: 'account-panel__link', href: '#/shop', text: 'Shop now ↗' })), ordersBox),
      el('section', { class: 'account-panel account-panel--profile', 'aria-labelledby': 'profile-title' }, el('div', { class: 'account-panel__head' }, el('div', {}, el('p', { class: 'account-kicker', text: 'YOUR DETAILS' }), el('h2', { id: 'profile-title', text: 'Profile' }))), form),
    ),
  );
}

function orderRow(order) {
  const count = order.items.reduce((n, i) => n + i.quantity, 0);
  return el(
    'li',
    { class: 'order-row' },
    el(
      'a',
      { class: 'order-row__link', href: `#/order/${encodeURIComponent(order.id)}` },
      el('span', { class: 'order-row__id', text: order.id }),
      el('span', { class: 'order-row__meta', text: `${order.merchant.name} · ${count} ${count === 1 ? 'item' : 'items'}` }),
      el('span', { class: 'order-row__meta', text: formatDate(order.createdAt) }),
    ),
    el('div', { class: 'order-row__right' }, el('span', { class: 'price', text: formatNaira(order.totalKobo) }), el('span', { class: 'badge', text: ORDER_STATUS_LABEL[order.status] ?? order.status })),
  );
}
