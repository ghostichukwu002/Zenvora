// Carts are keyed by an opaque, server-issued session id held in an httpOnly cookie.
// The browser never sends prices or totals; it only sends intent ("add product X, qty 2").
//
// DEVELOPMENT ONLY: this is an in-memory Map, so carts are lost on restart and
// are not shared between server instances. Replace with a database table before
// any real deployment.

import { randomUUID } from 'node:crypto';
import { emptyCart } from './cart.js';

export const SESSION_COOKIE = 'zv_sid';

export function createCartStore() {
  const carts = new Map();

  return {
    newSessionId() {
      return randomUUID();
    },
    get(sessionId) {
      return carts.get(sessionId) ?? emptyCart();
    },
    set(sessionId, cart) {
      carts.set(sessionId, cart);
      return cart;
    },
    size() {
      return carts.size;
    },
  };
}

// Reads one cookie value from a raw Cookie header without adding a dependency.
export function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (rawKey === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}
