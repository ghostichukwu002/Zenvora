import * as api from '../api.js';
import { el, linkButton } from '../dom.js';
import { trustBadge } from '../components.js';
import { field, formMessage, guardedSubmit } from '../form.js';
import { formatNaira } from '../format.js';
import { refresh } from '../router.js';
import { stateBox, toast } from '../ui.js';
import { emptyView, formatDate, requireLogin } from './guard.js';

// Rider workspace: apply, wait for approval, then take the jobs ZENVORA dispatch assigns.
// The server decides every action. These screens only show the buttons that apply to a job.

const VEHICLES = [
  ['bicycle', 'Bicycle'],
  ['motorcycle', 'Motorcycle'],
  ['car', 'Car'],
  ['van', 'Van'],
];

const DELIVERY_LABEL = {
  assigned: 'Assigned',
  picked_up: 'On the way',
  delivered: 'Delivered',
  failed: 'Not delivered',
};

export async function renderRider() {
  const user = await requireLogin();
  if (!user) return emptyView();
  document.title = 'Rider · ZENVORA';

  let rider;
  try {
    ({ rider } = await api.get('/api/rider/me'));
  } catch (err) {
    return stateBox({ tone: 'error', title: 'Couldn’t load your rider account', body: err.message });
  }
  if (!rider) return applyPage();
  if (rider.status === 'pending') return pendingPage(rider);
  if (rider.status === 'suspended') {
    return el('div', { class: 'container section--tight' }, stateBox({
      tone: 'error',
      title: 'Your rider account is suspended',
      body: 'You can’t take deliveries right now. Contact ZENVORA support for details.',
      iconName: 'shield',
    }));
  }
  return dashboard(rider);
}

// ----- Applying -----

async function applyPage() {
  let areas = [];
  try {
    ({ items: areas } = await api.get('/api/areas'));
  } catch (err) {
    return stateBox({ tone: 'error', title: 'Couldn’t load delivery areas', body: err.message });
  }

  const vehicle = el('select', { class: 'select', id: 'rider-vehicle', name: 'vehicle', required: true },
    el('option', { value: '', text: 'Choose a vehicle', disabled: true, selected: true }),
    VEHICLES.map(([value, text]) => el('option', { value, text })),
  );
  const phone = field({ name: 'phone', label: 'Phone number', type: 'tel', autocomplete: 'tel', inputmode: 'tel', hint: 'Nigerian mobile number, for example 0803 123 4567.' });
  const areaInputs = areas.map((a) => {
    const input = el('input', { type: 'checkbox', name: 'areas', value: a.name, id: `area-${a.name.replace(/\W+/g, '-')}` });
    return el('label', { class: 'check', for: input.id }, input, el('span', { text: `${a.name}, ${a.city}` }));
  });
  const message = formMessage();
  const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--block', text: 'Send application' });
  const form = el(
    'form',
    { class: 'form', novalidate: true },
    el('div', { class: 'field' }, el('label', { for: 'rider-vehicle', text: 'Vehicle' }), vehicle),
    phone.node,
    el('fieldset', { class: 'field-group' },
      el('legend', { text: 'Areas you can deliver in' }),
      el('p', { class: 'muted', text: 'Pick every area you can cover. You will only be sent jobs in these areas.' }),
      areaInputs,
    ),
    message.node,
    submit,
  );

  guardedSubmit(form, submit, 'Sending…', async () => {
    message.show('');
    phone.setError('');
    if (!vehicle.value) return message.show('Choose the vehicle you deliver with.');
    const chosen = [...form.querySelectorAll('input[name=areas]:checked')].map((i) => i.value);
    if (!chosen.length) return message.show('Choose at least one area.');
    try {
      await api.post('/api/rider/apply', { vehicle: vehicle.value, phone: phone.value, areas: chosen });
      toast('Application sent');
      // Same route, so the hash alone would not redraw the page. Ask the router to render again.
      refresh();
    } catch (err) {
      if (err.code === 'phone_invalid') phone.setError(err.message);
      else message.show(err.message);
    }
  });

  return el(
    'div',
    { class: 'container auth' },
    el('div', { class: 'auth__card auth__card--wide' },
      el('h1', { text: 'Deliver with ZENVORA' }),
      el('p', { class: 'muted', text: 'Apply once. An administrator reviews every application and checks your details before you can take a delivery.' }),
      form,
      el('p', { class: 'auth__links' }, linkButton({ href: '#/account', text: 'Back to your account', variant: 'ghost', small: true })),
    ),
  );
}

function pendingPage(rider) {
  return el('div', { class: 'container section--tight' },
    stateBox({
      title: 'Your application is under review',
      body: `We’ll switch on deliveries once an administrator approves you. You applied with a ${VEHICLES.find(([v]) => v === rider.vehicle)?.[1].toLowerCase() ?? rider.vehicle} for ${rider.areas.join(', ')}.`,
      iconName: 'truck',
      actions: [linkButton({ href: '#/account', text: 'Back to your account', variant: 'secondary', small: true })],
    }),
  );
}

// ----- Approved riders -----

function dashboard(rider) {
  const availability = el('input', { type: 'checkbox', role: 'switch', id: 'rider-available', checked: rider.available });
  const availabilityText = el('span', { class: 'muted', text: rider.available ? 'You are online and can be sent jobs.' : 'You are offline. No new jobs will reach you.' });
  availability.addEventListener('change', async () => {
    const next = availability.checked;
    availability.disabled = true;
    try {
      const res = await api.patch('/api/rider/me', { available: next });
      availability.checked = res.rider.available;
      availabilityText.textContent = res.rider.available ? 'You are online and can be sent jobs.' : 'You are offline. No new jobs will reach you.';
    } catch (err) {
      availability.checked = !next;
      toast(err.message, { tone: 'error' });
    } finally {
      availability.disabled = false;
    }
  });

  const activeBox = el('div', { 'aria-busy': 'true' }, el('p', { class: 'muted', text: 'Loading your jobs…' }));
  const historyBox = el('div');

  async function load() {
    try {
      const { active, history } = await api.get('/api/rider/jobs');
      activeBox.replaceChildren(
        active.length
          ? el('ul', { class: 'job-list' }, active.map((job) => jobCard(job, load)))
          : stateBox({ title: 'No active jobs', body: 'Jobs assigned to you by dispatch will appear here.', iconName: 'truck' }),
      );
      historyBox.replaceChildren(
        history.length
          ? el('section', { class: 'rider-section', 'aria-labelledby': 'history-title' },
            el('h2', { id: 'history-title', text: 'Recent deliveries' }),
            el('ul', { class: 'job-list job-list--compact' }, history.map((job) => jobCard(job, load))),
          )
          : null,
      );
    } catch (err) {
      activeBox.replaceChildren(stateBox({ tone: 'error', title: 'Couldn’t load your jobs', body: err.message, actions: [linkButton({ text: 'Try again', variant: 'secondary', small: true, onClick: load })] }));
    } finally {
      activeBox.removeAttribute('aria-busy');
    }
  }
  load();

  return el('div', { class: 'container section--tight' },
    el('div', { class: 'section__head' },
      el('div', {}, el('h1', { tabindex: '-1', text: 'Your deliveries' }), el('p', { class: 'muted' }, `${rider.vehicle[0].toUpperCase()}${rider.vehicle.slice(1)} · ${rider.areas.join(', ')} `, trustBadge('rider'))),
    ),
    el('div', { class: 'rider-availability' }, el('label', { class: 'availability__toggle', for: 'rider-available' }, availability, el('strong', { text: 'Available for jobs' })), availabilityText),
    el('section', { class: 'rider-section', 'aria-labelledby': 'active-title' }, el('h2', { id: 'active-title', text: 'Active' }), activeBox),
    historyBox,
  );
}

function jobCard(job, reload) {
  const d = job.dropoff;
  const isActive = job.deliveryStatus === 'assigned' || job.deliveryStatus === 'picked_up';
  const busy = { value: false };

  // Runs one job action. Refreshes the list whether it works or the job has moved on.
  const run = (path, body, successText) => async (event) => {
    if (busy.value) return;
    busy.value = true;
    event.currentTarget.disabled = true;
    try {
      await api.post(`/api/rider/jobs/${encodeURIComponent(job.orderId)}/${path}`, body);
      toast(successText);
      await reload();
    } catch (err) {
      toast(err.message, { tone: 'error' });
      busy.value = false;
      event.currentTarget.disabled = false;
      if (err.code === 'invalid_transition' || err.code === 'status_changed' || err.code === 'delivery_not_found') await reload();
    }
  };

  const meta = [
    el('span', { class: 'badge', text: DELIVERY_LABEL[job.deliveryStatus] ?? job.deliveryStatus }),
    el('span', { class: 'muted', text: formatDate(job.assignedAt) }),
  ];

  const pickup = el('p', { class: 'job-card__block' },
    el('span', { class: 'job-card__label', text: 'Pick up' }),
    el('strong', { text: job.pickup.merchantName }),
    el('br'),
    `${job.pickup.city}, ${job.pickup.state}`,
  );
  const dropoff = el('p', { class: 'job-card__block' },
    el('span', { class: 'job-card__label', text: 'Drop off' }),
    el('strong', { text: d.name }), ' · ', el('a', { href: `tel:${d.phone}`, text: d.phone }),
    el('br'),
    `${d.address}, ${d.area}, ${d.city}`,
    d.notes ? el('br') : null,
    d.notes ? `Note: ${d.notes}` : null,
  );
  const cash = job.cashToCollectKobo > 0
    ? el('p', { class: 'job-card__cash' }, `Collect ${formatNaira(job.cashToCollectKobo)} in cash`)
    : job.paymentMethod === 'cash_on_delivery' && job.paymentStatus === 'cod_collected'
      ? el('p', { class: 'muted', text: 'Cash collected' })
      : null;

  let actions = null;
  if (job.deliveryStatus === 'assigned') {
    const pick = el('button', { type: 'button', class: 'btn btn--primary btn--small', text: 'Picked up', onclick: run('pickup', {}, 'Picked up. Head to the drop-off.') });
    const decline = el('button', { type: 'button', class: 'btn btn--secondary btn--small', text: 'Decline', onclick: (event) => {
      if (!window.confirm('Decline this job? It goes back to dispatch.')) return;
      run('decline', {}, 'Job declined')(event);
    } });
    actions = el('div', { class: 'job-card__actions' }, pick, decline);
  } else if (job.deliveryStatus === 'picked_up') {
    actions = completeForm(job, run);
  }

  const outcome = job.deliveryStatus === 'delivered'
    ? el('p', { class: 'muted', text: `Delivered${job.proofNote ? ` · Proof: ${job.proofNote}` : ''}` })
    : job.deliveryStatus === 'failed'
      ? el('p', { class: 'muted', text: `Not delivered · ${job.failureReason}` })
      : null;

  return el('li', { class: 'job-card' },
    el('div', { class: 'job-card__head' }, el('strong', { text: job.orderId }), el('div', { class: 'job-card__meta' }, meta)),
    pickup,
    dropoff,
    cash,
    outcome,
    isActive ? actions : null,
  );
}

// Completing needs cash confirmed and a short proof note. Failing needs a reason.
function completeForm(job, run) {
  const cashBox = el('input', { type: 'checkbox', name: 'cashCollected', id: `cash-${job.orderId}` });
  const proof = field({ name: 'proofNote', label: 'Who received it?', autocomplete: 'off', maxlength: 300, hint: 'For example: “Ada at the gate”.' });
  const complete = el('button', { type: 'submit', class: 'btn btn--primary btn--small', text: 'Mark delivered' });
  const message = formMessage();
  const deliverForm = el('form', { class: 'job-card__form', novalidate: true },
    job.cashToCollectKobo > 0
      ? el('label', { class: 'check', for: cashBox.id }, cashBox, el('span', { text: `I collected ${formatNaira(job.cashToCollectKobo)} in cash` }))
      : null,
    proof.node,
    message.node,
    complete,
  );
  deliverForm.addEventListener('submit', (event) => {
    event.preventDefault();
    message.show('');
    const note = proof.value.trim();
    if (note.length < 2) return proof.setError('Say who received the order.'), proof.input.focus();
    if (job.cashToCollectKobo > 0 && !cashBox.checked) return message.show('Confirm the cash before marking it delivered.');
    run('complete', { cashCollected: job.cashToCollectKobo > 0 ? cashBox.checked : true, proofNote: note }, 'Delivery recorded')({ currentTarget: complete });
  });

  const reason = field({ name: 'reason', label: 'Why couldn’t it be delivered?', autocomplete: 'off', maxlength: 200 });
  const failButton = el('button', { type: 'button', class: 'btn btn--secondary btn--small', text: 'Couldn’t deliver' });
  const failMessage = formMessage();
  failButton.addEventListener('click', (event) => {
    failMessage.show('');
    const text = reason.value.trim();
    if (text.length < 2) return failMessage.show('Say why it couldn’t be delivered.');
    if (!window.confirm('Mark this order as not delivered? Dispatch will need to reassign it.')) return;
    run('fail', { reason: text }, 'Marked as not delivered')({ currentTarget: event.currentTarget });
  });

  return el('details', { class: 'job-card__details' },
    el('summary', { text: 'Complete or report this delivery' }),
    deliverForm,
    el('div', { class: 'job-card__form' }, reason.node, failMessage.node, failButton),
  );
}
