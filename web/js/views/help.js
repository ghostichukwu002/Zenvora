import * as api from '../api.js';
import { el, linkButton } from '../dom.js';
import { field, formMessage, guardedSubmit } from '../form.js';
import { toast } from '../ui.js';
import { emptyView, formatDate, requireLogin } from './guard.js';

// Customer care. Signed-in customers send a request and read replies here. Nothing is emailed yet,
// so the page says plainly where replies appear.

const TOPICS = [
  ['order', 'My order'],
  ['payment', 'Payment or refund'],
  ['delivery', 'Delivery'],
  ['account', 'My account'],
  ['other', 'Something else'],
];
const TOPIC_LABEL = Object.fromEntries(TOPICS);
const STATUS_LABEL = { open: 'Waiting for reply', answered: 'Answered', closed: 'Closed' };

export async function renderHelp() {
  const user = await requireLogin();
  if (!user) return emptyView();
  document.title = 'Customer care · Shop n Delight';

  const topicId = 'support-topic';
  const topic = el(
    'select',
    { class: 'select', id: topicId, name: 'topic', required: true },
    TOPICS.map(([value, label]) => el('option', { value, text: label })),
  );
  const topicField = el('div', { class: 'field' }, el('label', { for: topicId, text: 'What is it about?' }), topic);
  const orderField = field({
    name: 'orderId',
    label: 'Order number',
    required: false,
    maxlength: 13,
    hint: 'Looks like ZV-1A2B3C4D5E. Leave it out if the question is not about an order.',
  });
  orderField.input.setAttribute('autocomplete', 'off');
  orderField.input.setAttribute('spellcheck', 'false');
  const messageField = field({
    name: 'message',
    label: 'Tell us what happened',
    rows: 5,
    maxlength: 1000,
    hint: 'At least 10 characters. Never share your password or card details.',
  });
  const counter = el('p', { class: 'help__count', 'aria-live': 'polite', text: '0 / 1000' });
  messageField.input.addEventListener('input', () => {
    counter.textContent = `${messageField.input.value.length} / 1000`;
  });

  const message = formMessage();
  const submit = el('button', { type: 'submit', class: 'btn btn--primary', text: 'Send request' });
  const form = el('form', { class: 'help__form', novalidate: true }, topicField, orderField.node, messageField.node, counter, message.node, submit);

  const list = el('div', { 'aria-live': 'polite' });

  async function loadRequests() {
    list.setAttribute('aria-busy', 'true');
    try {
      const { items } = await api.get('/api/support/mine');
      list.replaceChildren(items.length ? el('ul', { class: 'help__list' }, items.map(requestItem)) : el('p', { class: 'help__lead', text: 'You have not sent any requests yet.' }));
    } catch (err) {
      list.replaceChildren(el('p', { class: 'form-error', role: 'alert', text: err.message }));
    } finally {
      list.removeAttribute('aria-busy');
    }
  }

  guardedSubmit(form, submit, 'Sending…', async () => {
    message.show('');
    const body = {
      topic: topic.value,
      message: messageField.value,
      orderId: orderField.value || undefined,
    };
    try {
      await api.post('/api/support', body);
      form.reset();
      counter.textContent = '0 / 1000';
      toast('Sent. Replies appear in this page.');
      await loadRequests();
    } catch (err) {
      message.show(err.message);
    }
  });

  loadRequests();

  return el('div', { class: 'container section--tight' },
    el('header', { class: 'section__head' },
      el('div', {},
        el('h1', { tabindex: '-1', text: 'Customer care' }),
        el('p', { class: 'help__lead', text: 'Tell us what went wrong and a Shop n Delight team member will reply here, in your account.' }),
      ),
      linkButton({ href: '#/account', text: 'Back to your account', variant: 'secondary', small: true }),
    ),
    el('div', { class: 'help' },
      el('section', { class: 'help__panel', 'aria-labelledby': 'help-new' },
        el('h2', { id: 'help-new', text: 'Send a request' }),
        el('p', { class: 'help__lead', text: 'Replies are not emailed yet, so check back here for an answer.' }),
        form,
      ),
      el('section', { class: 'help__panel', 'aria-labelledby': 'help-mine' },
        el('h2', { id: 'help-mine', text: 'Your requests' }),
        list,
      ),
    ),
  );
}

function requestItem(r) {
  const orderLine = r.orderId ? el('p', { class: 'muted' }, `Order ${r.orderId}`) : null;
  return el('li', { class: 'help__item' },
    el('div', { class: 'help__item-head' },
      el('strong', { text: TOPIC_LABEL[r.topic] ?? r.topic }),
      el('span', { class: `help__status help__status--${r.status}`, text: STATUS_LABEL[r.status] ?? r.status }),
    ),
    el('p', { class: 'muted', text: `${r.id} · ${formatDate(r.createdAt)}` }),
    orderLine,
    el('p', { text: r.message }),
    r.reply
      ? el('div', { class: 'help__reply' },
        el('strong', { text: `Shop n Delight replied${r.repliedAt ? ` · ${formatDate(r.repliedAt)}` : ''}` }),
        el('p', { text: r.reply }),
      )
      : null,
  );
}
