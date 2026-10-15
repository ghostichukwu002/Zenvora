import * as api from '../api.js';
import { el, linkButton } from '../dom.js';
import { field, formMessage, guardedSubmit } from '../form.js';
import { loadCart, setUser } from '../state.js';
import { toast } from '../ui.js';

// Only same-app hash links are honoured after login, so the "next" value cannot send anyone elsewhere.
function safeNext(query) {
  const next = query.get('next') ?? '';
  return next.startsWith('#/') && !next.startsWith('#//') ? next : '#/account';
}

// Maps server error codes to the field they belong to.
const FIELD_FOR_CODE = {
  email_invalid: 'email',
  email_taken: 'email',
  password_invalid: 'password',
  name_invalid: 'fullName',
  phone_invalid: 'phone',
};

function shell(title, intro, ...children) {
  return el(
    'div',
    { class: 'container auth' },
    el(
      'div',
      { class: 'auth__card' },
      el('h1', { text: title }),
      intro ? el('p', { class: 'muted', text: intro }) : null,
      ...children,
    ),
  );
}

function applyServerError(err, fields, message) {
  const key = FIELD_FOR_CODE[err.code];
  if (key && fields[key]) {
    fields[key].setError(err.message);
    fields[key].input.focus();
  } else {
    message.show(err.message);
  }
}

export function renderLogin({ query }) {
  document.title = 'Log in · Shop n Delight';
  const next = safeNext(query);
  const email = field({ name: 'email', label: 'Email', type: 'email', autocomplete: 'email', inputmode: 'email', maxlength: 254 });
  const password = field({ name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password', maxlength: 128 });
  const message = formMessage();
  const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--block', text: 'Log in' });
  const form = el('form', { class: 'form', novalidate: true }, email.node, password.node, message.node, submit);

  guardedSubmit(form, submit, 'Logging in…', async () => {
    email.setError('');
    password.setError('');
    message.show('');
    if (!email.value) return email.setError('Enter your email.'), email.input.focus();
    if (!password.input.value) return password.setError('Enter your password.'), password.input.focus();
    try {
      const res = await api.post('/api/auth/login', { email: email.value, password: password.input.value });
      setUser(res.user);
      await loadCart();
      toast(`Welcome back, ${res.user.fullName.split(' ')[0]}`);
      window.location.hash = next;
    } catch (err) {
      message.show(err.message);
    }
  });

  return shell(
    'Log in',
    'Welcome back. Log in to check out and see your orders.',
    form,
    el('p', { class: 'auth__links' }, el('a', { href: '#/forgot-password', text: 'Forgot your password?' })),
    el(
      'p',
      { class: 'auth__links' },
      'New to Shop n Delight? ',
      el('a', { href: `#/register?next=${encodeURIComponent(next)}`, text: 'Create an account' }),
    ),
  );
}

export function renderRegister({ query }) {
  document.title = 'Create account · Shop n Delight';
  const next = safeNext(query);
  const fields = {
    fullName: field({ name: 'fullName', label: 'Full name', autocomplete: 'name', maxlength: 100 }),
    email: field({ name: 'email', label: 'Email', type: 'email', autocomplete: 'email', inputmode: 'email', maxlength: 254 }),
    phone: field({
      name: 'phone',
      label: 'Phone number',
      type: 'tel',
      autocomplete: 'tel',
      inputmode: 'tel',
      required: false,
      hint: 'Nigerian mobile number, for example 0803 123 4567.',
    }),
    password: field({
      name: 'password',
      label: 'Password',
      type: 'password',
      autocomplete: 'new-password',
      hint: 'At least 8 characters.',
      maxlength: 128,
    }),
  };
  const message = formMessage();
  const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--block', text: 'Create account' });
  const form = el(
    'form',
    { class: 'form', novalidate: true },
    fields.fullName.node,
    fields.email.node,
    fields.phone.node,
    fields.password.node,
    message.node,
    submit,
  );

  guardedSubmit(form, submit, 'Creating account…', async () => {
    for (const f of Object.values(fields)) f.setError('');
    message.show('');
    if (!fields.fullName.value) return fields.fullName.setError('Enter your full name.'), fields.fullName.input.focus();
    if (!fields.email.value) return fields.email.setError('Enter your email.'), fields.email.input.focus();
    if (fields.password.input.value.length < 8) {
      return fields.password.setError('Use at least 8 characters.'), fields.password.input.focus();
    }
    try {
      const res = await api.post('/api/auth/register', {
        fullName: fields.fullName.value,
        email: fields.email.value,
        phone: fields.phone.value,
        password: fields.password.input.value,
      });
      setUser(res.user);
      await loadCart();
      toast('Your account is ready');
      window.location.hash = next;
    } catch (err) {
      applyServerError(err, fields, message);
    }
  });

  return shell(
    'Create your account',
    'One account for all your orders.',
    form,
    el('p', { class: 'auth__links' }, 'Already have an account? ', el('a', { href: `#/login?next=${encodeURIComponent(next)}`, text: 'Log in' })),
  );
}

export function renderForgot() {
  document.title = 'Reset password · Shop n Delight';
  const email = field({ name: 'email', label: 'Email', type: 'email', autocomplete: 'email', inputmode: 'email', maxlength: 254 });
  const message = formMessage();
  const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--block', text: 'Send reset link' });
  const form = el('form', { class: 'form', novalidate: true }, email.node, message.node, submit);
  const done = el('div', { class: 'state', role: 'status', hidden: true });

  guardedSubmit(form, submit, 'Sending…', async () => {
    email.setError('');
    message.show('');
    if (!email.value) return email.setError('Enter your email.'), email.input.focus();
    try {
      const res = await api.post('/api/auth/forgot-password', { email: email.value });
      form.hidden = true;
      done.hidden = false;
      done.replaceChildren(
        el('h2', { text: 'Check your email' }),
        el('p', { text: res.message }),
        el('p', { class: 'muted', text: 'Email delivery is not connected in this build yet, so no email will arrive here.' }),
        linkButton({ href: '#/login', text: 'Back to log in', variant: 'secondary' }),
      );
    } catch (err) {
      message.show(err.message);
    }
  });

  return shell('Reset your password', 'Enter your email and we’ll send you a link to choose a new password.', form, done);
}

export function renderReset({ query }) {
  document.title = 'Choose a new password · Shop n Delight';
  const token = query.get('token') ?? '';
  const password = field({
    name: 'password',
    label: 'New password',
    type: 'password',
    autocomplete: 'new-password',
    hint: 'At least 8 characters.',
    maxlength: 128,
  });
  const message = formMessage();
  const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--block', text: 'Save new password' });
  const form = el('form', { class: 'form', novalidate: true }, password.node, message.node, submit);

  guardedSubmit(form, submit, 'Saving…', async () => {
    password.setError('');
    message.show('');
    if (password.input.value.length < 8) {
      return password.setError('Use at least 8 characters.'), password.input.focus();
    }
    try {
      await api.post('/api/auth/reset-password', { token, password: password.input.value });
      setUser(null);
      toast('Password changed. Please log in.');
      window.location.hash = '#/login';
    } catch (err) {
      if (err.code === 'password_invalid') password.setError(err.message);
      else message.show(err.message);
    }
  });

  if (!token) {
    return shell('Reset link missing', 'Open the link from your reset email, or request a new one.', linkButton({ href: '#/forgot-password', text: 'Request a new link' }));
  }
  return shell('Choose a new password', null, form);
}
