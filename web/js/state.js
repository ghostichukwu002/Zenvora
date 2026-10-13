// Client state. The server owns the cart. This module only caches the last
// priced cart the server returned, so the header badge can stay accurate.
// The delivery area is a per-browser convenience, kept in localStorage.

import * as api from './api.js';

const AREA_KEY = 'zv_area';
const listeners = new Set();
const areaListeners = new Set();

let cart = null;

export function getCart() {
  return cart;
}

export function onCartChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setCart(next) {
  cart = next;
  const count = next?.itemCount ?? 0;
  for (const id of ['cart-count', 'cart-count-mobile']) {
    const badge = document.getElementById(id);
    if (!badge) continue;
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
  const label = count === 1 ? 'Cart, 1 item' : `Cart, ${count} items`;
  document.querySelector('.site-header a[data-nav="cart"]')?.setAttribute('aria-label', label);
  for (const fn of listeners) fn(cart);
  return cart;
}

export async function loadCart() {
  try {
    return setCart(await api.get('/api/cart'));
  } catch {
    // The header badge is non-critical. Failing quietly here keeps the page usable.
    return cart;
  }
}

// ---------- Signed-in user ----------
// The server decides who is signed in (httpOnly cookie). This only caches what /api/auth/me returned,
// so pages can show the right links. It is never used to protect anything.

let user = null;
let userLoaded = false;
const userListeners = new Set();

export function getUser() {
  return user;
}

export function setUser(next) {
  user = next;
  userLoaded = true;
  const link = document.querySelector('.site-header a[data-nav="account"]');
  link?.setAttribute('aria-label', next ? `Account: ${next.fullName}` : 'Log in');
  for (const fn of userListeners) fn(user);
  return user;
}

export function onUserChange(fn) {
  userListeners.add(fn);
  return () => userListeners.delete(fn);
}

// Resolves once, then answers from the cache.
export async function ensureUser() {
  if (userLoaded) return user;
  try {
    const res = await api.get('/api/auth/me');
    return setUser(res.user);
  } catch {
    // If the check fails, treat the visitor as signed out. The server still enforces access.
    return setUser(null);
  }
}

export function getArea() {
  try {
    return localStorage.getItem(AREA_KEY) || null;
  } catch {
    return null;
  }
}

export function setArea(name) {
  try {
    if (name) localStorage.setItem(AREA_KEY, name);
    else localStorage.removeItem(AREA_KEY);
  } catch {
    // Storage can be blocked (private browsing, strict settings). The choice then lasts only this page view.
  }
  for (const fn of areaListeners) fn(name);
}

export function onAreaChange(fn) {
  areaListeners.add(fn);
  return () => areaListeners.delete(fn);
}
