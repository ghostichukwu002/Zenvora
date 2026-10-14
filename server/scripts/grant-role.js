// Grants or removes the administrator role for an existing account.
// Run this on the server, against the real database. There is no admin sign-up and no built-in admin login.
//
//   node scripts/grant-role.js you@example.com admin
//   node scripts/grant-role.js you@example.com customer      (removes admin access)
//
// The database is ZENVORA_DATA_DIR/zenvora.db, or server/data/zenvora.db by default.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';

const ROLES = ['customer', 'admin'];
const [email, role] = process.argv.slice(2);

if (!email || !ROLES.includes(role)) {
  console.error('Usage: node scripts/grant-role.js <email> <customer|admin>');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ZENVORA_DATA_DIR || join(here, '..', 'data');
const file = join(dataDir, 'zenvora.db');
if (!existsSync(file)) {
  console.error(`No database found at ${file}. Start the server once, then create the account in the app first.`);
  process.exit(1);
}

const db = openDatabase(file);
const cleanEmail = email.trim().toLowerCase();
const user = db.prepare('SELECT id, full_name, role FROM users WHERE email = ?').get(cleanEmail);
if (!user) {
  console.error(`No account for ${cleanEmail}. The person must register in the app first.`);
  process.exit(1);
}

db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
db.prepare('INSERT INTO audit_log (actor_user_id, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
  .run('system', 'account.role_changed', user.id, JSON.stringify({ role, via: 'command line' }), new Date().toISOString());
console.log(`${user.full_name} (${cleanEmail}) is now ${role}.`);
