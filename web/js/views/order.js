import * as api from '../api.js';
import { el, icon, linkButton } from '../dom.js';
import { formatNaira } from '../format.js';
import { trustBadge } from '../components.js';
import { stateBox } from '../ui.js';
import { emptyView, formatDate, ORDER_STATUS_LABEL, PAYMENT_LABEL, requireLogin } from './guard.js';

export async function renderOrder({ params }) {
  const user = await requireLogin();
  if (!user) return emptyView();

  let order;
  try {
    ({ order } = await api.get(`/api/orders/${encodeURIComponent(params.id)}`));
  } catch (err) {
    if (err.status === 404) {
      return el('div', { class: 'container section--tight' }, stateBox({
        title: 'We couldn’t find that order',
        body: 'It may belong to a different account, or the link may be wrong.',
        actions: [linkButton({ href: '#/account', text: 'See your orders' })],
        iconName: 'receipt',
      }));
    }
    throw err;
  }

  document.title = `Order ${order.id} · Shop n Delight`;
  const d = order.delivery;

  return el(
    'div',
    { class: 'container' },
    el('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' }, el('ol', {}, el('li', {}, el('a', { href: '#/account', text: 'Account' })), el('li', { text: order.id }))),
    el(
      'div',
      { class: 'order-hero' },
      el('span', { class: 'order-hero__icon' }, icon('check')),
      el('div', {}, el('h1', { tabindex: '-1', text: 'Order placed' }), el('p', { class: 'muted', text: `${order.id} · ${formatDate(order.createdAt)}` })),
    ),
    el(
      'div',
      { class: 'cart-layout' },
      el(
        'div',
        { class: 'order-detail' },
        el(
          'section',
          { class: 'order-block' },
          el('h2', { text: 'Status' }),
          el('p', {}, el('span', { class: 'badge', text: ORDER_STATUS_LABEL[order.status] ?? order.status })),
          el('p', { class: 'muted', text: `${order.merchant.name} has your order. Reload this page to see the latest status.` }),
        ),
        order.rider
          ? el(
            'section',
            { class: 'order-block', 'aria-labelledby': 'order-rider-title' },
            el('h2', { id: 'order-rider-title', text: 'Your rider' }),
            el('p', {}, el('strong', { text: order.rider.firstName }), ` · ${order.rider.vehicle[0].toUpperCase()}${order.rider.vehicle.slice(1)} `, order.rider.verified ? trustBadge('rider') : null),
            el('p', { class: 'muted', text: 'Shop n Delight approves every rider before they can take a delivery. Pay them in cash on arrival.' }),
          )
          : null,
        el(
          'section',
          { class: 'order-block' },
          el('h2', { text: 'Items' }),
          el(
            'ul',
            { class: 'summary__lines' },
            order.items.map((i) => {
              const options = Object.values(i.variantChoice).join(', ');
              return el('li', { class: 'summary__row' }, el('span', { text: `${i.quantity} × ${i.name}${options ? ` (${options})` : ''}` }), el('span', { text: formatNaira(i.lineKobo) }));
            }),
          ),
        ),
        el(
          'section',
          { class: 'order-block' },
          el('h2', { text: 'Delivery' }),
          el('p', {}, el('strong', { text: d.name }), ` · ${d.phone}`),
          el('p', { text: `${d.address}` }),
          el('p', { class: 'muted', text: `${d.area}, ${d.city}, ${d.state}` }),
          d.notes ? el('p', { class: 'muted', text: `Note: ${d.notes}` }) : null,
        ),
      ),
      el(
        'aside',
        { class: 'summary', 'aria-labelledby': 'order-pay-title' },
        el('h2', { id: 'order-pay-title', text: 'Payment' }),
        el('div', { class: 'summary__row' }, el('span', { text: 'Subtotal' }), el('span', { text: formatNaira(order.subtotalKobo) })),
        el('div', { class: 'summary__row' }, el('span', { text: 'Delivery' }), el('span', { text: formatNaira(order.deliveryFeeKobo) })),
        el('div', { class: 'summary__row summary__row--total' }, el('span', { text: 'Total' }), el('span', { text: formatNaira(order.totalKobo) })),
        el('p', { class: 'summary__note' }, el('strong', { text: PAYMENT_LABEL[order.paymentStatus] ?? order.paymentStatus }), ' — pay the rider in cash on arrival. Nothing has been charged.'),
        linkButton({ href: '#/shop', text: 'Keep shopping', variant: 'secondary' }),
      ),
    ),
  );
}
