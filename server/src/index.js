import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { categories, merchants, products } from './catalogue.js';
import { openDatabase } from './db.js';

const port = Number.parseInt(process.env.PORT ?? '4000', 10);
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', 'web');
const dataDir = process.env.ZENVORA_DATA_DIR ?? join(here, '..', 'data');
const isProduction = process.env.NODE_ENV === 'production';

mkdirSync(dataDir, { recursive: true });
const db = openDatabase(join(dataDir, 'zenvora.db'));

// No email provider is connected yet. In development the reset link is printed here so the
// flow can be tried. In production the token is never logged, so resets stay unavailable
// until a real mail provider is wired in.
async function sendResetEmail({ to, token, minutes }) {
  if (isProduction) {
    console.warn('Password reset requested but no email provider is configured. No email was sent.');
    return;
  }
  const link = `http://localhost:${port}/#/reset-password?token=${token}`;
  console.log(`[dev] Password reset for ${to} (valid ${minutes} min): ${link}`);
}

// Store claim codes, for example {"m-sample-kitchen":"a-long-random-code"}. Set them in the
// environment, never in the code. Without them, no account can be linked to a store.
let merchantClaimCodes = {};
if (process.env.ZENVORA_MERCHANT_CLAIM_CODES) {
  try {
    merchantClaimCodes = JSON.parse(process.env.ZENVORA_MERCHANT_CLAIM_CODES);
  } catch {
    console.error('ZENVORA_MERCHANT_CLAIM_CODES is not valid JSON. No store claims will work.');
  }
}

const server = createServer(
  createApp({
    catalogue: { categories, merchants, products },
    webRoot,
    db,
    sendResetEmail,
    merchantClaimCodes,
    // Set ZENVORA_TRUST_PROXY=1 only when a proxy you control (for example your host's load balancer)
    // is in front of this server, so it appends the real client address to X-Forwarded-For.
    trustProxy: process.env.ZENVORA_TRUST_PROXY === '1',
  }),
);

server.listen(port, () => {
  console.log(`ZENVORA running at http://localhost:${port}`);
  console.log('Catalogue is SAMPLE data for development. Orders and accounts are stored in', dataDir);
});

// Close cleanly on Ctrl+C so the process does not hang.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
