// Accessible form fields: a visible label, an optional hint, and an inline error that is
// announced to screen readers and linked to the input.

import { el } from './dom.js';

let uid = 0;

export function field({ name, label, type = 'text', autocomplete, value = '', hint, required = true, inputmode, maxlength, rows, readonly = false }) {
  uid += 1;
  const id = `f-${name}-${uid}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const attrs = {
    id,
    name,
    class: 'input',
    autocomplete,
    inputmode,
    maxlength,
    value: rows ? undefined : value,
    required: required ? true : undefined,
    readonly: readonly ? true : undefined,
    'aria-describedby': hint ? `${hintId} ${errorId}` : errorId,
  };
  if (!rows) attrs.type = type;

  const input = rows ? el('textarea', { ...attrs, rows: String(rows) }) : el('input', attrs);
  if (rows) input.value = value;

  const error = el('p', { class: 'field-error', id: errorId, role: 'alert', hidden: true });
  const node = el(
    'div',
    { class: 'field' },
    el('label', { for: id, text: label + (required ? '' : ' (optional)') }),
    hint ? el('p', { class: 'field__hint', id: hintId, text: hint }) : null,
    input,
    error,
  );

  return {
    node,
    input,
    get value() {
      return input.value.trim();
    },
    setError(message) {
      error.textContent = message;
      error.hidden = !message;
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    },
  };
}

// Shows a form-level message (for example a server error) above the submit button.
export function formMessage() {
  const node = el('p', { class: 'form-error', role: 'alert', hidden: true });
  return {
    node,
    show(text) {
      node.textContent = text;
      node.hidden = !text;
    },
  };
}

// Runs an async submit handler once at a time and disables the button while it runs.
export function guardedSubmit(form, button, busyLabel, handler) {
  const label = button.textContent;
  let busy = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = busyLabel;
    try {
      await handler();
    } finally {
      busy = false;
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = label;
      }
    }
  });
}
