// Small DOM helpers. Text is always set with textContent, never innerHTML,
// so catalogue or user-supplied text cannot inject markup.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Icon from the sprite in index.html. Decorative by default.
export function icon(name, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function clear(node) {
  node.replaceChildren();
}

// A button-styled link (href) or button (onClick).
export function linkButton({ href, text, onClick, variant = 'primary', small = false }) {
  const classes = ['btn', `btn--${variant}`];
  if (small) classes.push('btn--small');
  if (href) return el('a', { class: classes.join(' '), href, text });
  return el('button', { type: 'button', class: classes.join(' '), text, onclick: onClick });
}

export function setMain(...children) {
  const main = document.getElementById('app');
  main.replaceChildren(...children.flat());
  return main;
}

export function focusMain() {
  const main = document.getElementById('app');
  main.focus({ preventScroll: true });
}
