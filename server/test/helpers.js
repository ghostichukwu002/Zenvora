import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { categories, merchants, products } from '../src/catalogue.js';
import { openDatabase } from '../src/db.js';

// Starts an isolated app (own database, own copy of the catalogue so stock changes never leak
// between tests) on a random port.
export async function startApp(options = {}) {
  const db = openDatabase(':memory:');
  const catalogue = structuredClone({ categories, merchants, products });
  const resetTokens = [];
  const server = createServer(
    createApp({
      catalogue,
      db,
      rateLimits: { authMax: 1000, loginPerEmailMax: 1000 },
      sendResetEmail: async ({ to, token }) => resetTokens.push({ to, token }),
      ...options,
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    db,
    catalogue,
    resetTokens,
    close: () => new Promise((resolve) => server.close(resolve)),
    // A client with its own cookie jar, like one browser.
    client() {
      const jar = new Map();
      return {
        jar,
        async request(method, path, body, extraHeaders = {}) {
          const headers = { ...extraHeaders };
          if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
          if (body !== undefined) headers['Content-Type'] = 'application/json';
          const res = await fetch(base + path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          for (const line of res.headers.getSetCookie()) {
            const [pair] = line.split(';');
            const eq = pair.indexOf('=');
            const name = pair.slice(0, eq);
            const value = pair.slice(eq + 1);
            if (/Max-Age=0/i.test(line) || value === '') jar.delete(name);
            else jar.set(name, value);
          }
          const text = await res.text();
          return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers, setCookies: res.headers.getSetCookie() };
        },
      };
    },
  };
}

export const validUser = (overrides = {}) => ({
  email: 'ada@example.com',
  password: 'correct horse battery',
  fullName: 'Ada Obi',
  phone: '0803 123 4567',
  ...overrides,
});

export const validDelivery = (overrides = {}) => ({
  name: 'Ada Obi',
  phone: '08031234567',
  state: 'Lagos',
  city: 'Lagos',
  address: '12 Example Street, Ikoyi',
  notes: 'Call at the gate',
  ...overrides,
});

// A fresh idempotency key per checkout attempt, like the browser creates.
export const newKey = () => `key_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}_xxxxxxxx`;
