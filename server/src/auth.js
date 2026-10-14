// Accounts and sessions. Everything here is enforced on the server.
//
// - Passwords are hashed with scrypt and a per-user random salt. Never stored in plain text.
// - Session and reset tokens are random; only their SHA-256 hash is stored, so a leaked
//   database cannot be replayed as live sessions.
// - Login failures give one message for "no such email" and "wrong password".

import { createHash, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './router.js';

const scryptAsync = promisify(scrypt);

export const AUTH_COOKIE = 'zv_auth';
export const SESSION_DAYS = 30;
const RESET_MINUTES = 30;
const KEY_LEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const DAY_MS = 24 * 60 * 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Nigerian mobile numbers: 0803…, +234803…, 234803… -> +234803…
export function normalizeNigerianPhone(input) {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/[\s\-().]/g, '');
  let national;
  if (/^\+234\d{10}$/.test(digits)) national = digits.slice(4);
  else if (/^234\d{10}$/.test(digits)) national = digits.slice(3);
  else if (/^0\d{10}$/.test(digits)) national = digits.slice(1);
  else return null;
  // Mobile prefixes begin 7, 8 or 9 (for example 70x, 80x, 81x, 90x, 91x).
  if (!/^[789][01]\d{8}$/.test(national)) return null;
  return `+234${national}`;
}

export function validateEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

export function validatePassword(value) {
  if (typeof value !== 'string') return 'Enter a password.';
  if (value.length < 8) return 'Use at least 8 characters.';
  if (value.length > 128) return 'Use 128 characters or fewer.';
  return null;
}

function validateName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name.length >= 2 && name.length <= 100 ? name : null;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LEN, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// A fixed hash to compare against when the email is unknown, so timing does not reveal accounts.
const DUMMY_HASH = `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${Buffer.alloc(16).toString('base64')}$${scryptSync('dummy', Buffer.alloc(16), KEY_LEN, SCRYPT_PARAMS).toString('base64')}`;

export function publicUser(row) {
  return { id: row.id, email: row.email, fullName: row.full_name, phone: row.phone, role: row.role };
}

// Sliding-window limiter, in memory. Good for one process. Use a shared store when scaling out.
export function createRateLimiter({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map();
  return {
    // Returns seconds to wait when over the limit, otherwise 0.
    check(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((time) => t - time < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return Math.ceil((windowMs - (t - recent[0])) / 1000);
      }
      recent.push(t);
      hits.set(key, recent);
      return 0;
    },
    reset() {
      hits.clear();
    },
  };
}

export function createAuth(db, { now = () => new Date(), sendResetEmail, adminEmails = [] } = {}) {
  const admins = new Set(adminEmails);
  const iso = () => now().toISOString();

  function createSession(userId) {
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(now().getTime() + SESSION_DAYS * DAY_MS).toISOString();
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), userId, iso(), expires);
    return { token, maxAgeSeconds: SESSION_DAYS * 24 * 60 * 60 };
  }

  return {
    async register({ email, password, fullName, phone }) {
      const cleanEmail = validateEmail(email);
      if (!cleanEmail) throw new HttpError(422, 'email_invalid', 'Enter a valid email address.');
      const passwordProblem = validatePassword(password);
      if (passwordProblem) throw new HttpError(422, 'password_invalid', passwordProblem);
      const name = validateName(fullName);
      if (!name) throw new HttpError(422, 'name_invalid', 'Enter your full name.');
      let cleanPhone = null;
      if (phone !== undefined && phone !== null && phone !== '') {
        cleanPhone = normalizeNigerianPhone(phone);
        if (!cleanPhone) {
          throw new HttpError(422, 'phone_invalid', 'Enter a valid Nigerian mobile number, for example 0803 123 4567.');
        }
      }

      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(cleanEmail)) {
        throw new HttpError(409, 'email_taken', 'An account with this email already exists. Try logging in.');
      }

      const id = randomUUID();
      const hash = await hashPassword(password);
      try {
        db.prepare(
          'INSERT INTO users (id, email, password_hash, full_name, phone, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(id, cleanEmail, hash, name, cleanPhone, admins.has(cleanEmail) ? 'admin' : 'customer', iso());
      } catch {
        // Two sign-ups for one email at the same moment: the UNIQUE constraint decides.
        throw new HttpError(409, 'email_taken', 'An account with this email already exists. Try logging in.');
      }
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      return { user: publicUser(user), session: createSession(id) };
    },

    async login({ email, password }) {
      const cleanEmail = validateEmail(email);
      const fail = () => new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
      if (!cleanEmail || typeof password !== 'string' || password.length > 128) throw fail();

      const row = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
      const ok = await verifyPassword(password, row ? row.password_hash : DUMMY_HASH);
      if (!row || !ok) throw fail();
      return { user: publicUser(row), session: createSession(row.id) };
    },

    // Returns the user for a session token, or null. Expired sessions are removed.
    userForToken(token) {
      if (!token || token.length > 200) return null;
      const hash = sha256(token);
      const row = db
        .prepare(
          `SELECT u.*, s.expires_at AS session_expires FROM sessions s
           JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
        )
        .get(hash);
      if (!row) return null;
      if (new Date(row.session_expires) <= now()) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
        return null;
      }
      return row;
    },

    logout(token) {
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    },

    updateProfile(userId, { fullName, phone }) {
      const name = validateName(fullName);
      if (!name) throw new HttpError(422, 'name_invalid', 'Enter your full name.');
      let cleanPhone = null;
      if (phone !== undefined && phone !== null && phone !== '') {
        cleanPhone = normalizeNigerianPhone(phone);
        if (!cleanPhone) {
          throw new HttpError(422, 'phone_invalid', 'Enter a valid Nigerian mobile number, for example 0803 123 4567.');
        }
      }
      db.prepare('UPDATE users SET full_name = ?, phone = ? WHERE id = ?').run(name, cleanPhone, userId);
      return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
    },

    // Always behaves the same whether or not the email exists, so it cannot be used to probe accounts.
    async requestPasswordReset(email) {
      const cleanEmail = validateEmail(email);
      if (!cleanEmail) return;
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
      if (!user) return;

      const token = randomBytes(32).toString('base64url');
      const expires = new Date(now().getTime() + RESET_MINUTES * 60 * 1000).toISOString();
      db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(sha256(token), user.id, expires);
      if (sendResetEmail) await sendResetEmail({ to: user.email, token, minutes: RESET_MINUTES });
    },

    async resetPassword(token, newPassword) {
      const problem = validatePassword(newPassword);
      if (problem) throw new HttpError(422, 'password_invalid', problem);
      const invalid = () =>
        new HttpError(400, 'reset_invalid', 'This reset link is invalid or has expired. Request a new one.');
      if (typeof token !== 'string' || token.length > 200) throw invalid();

      const hash = sha256(token);
      const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(hash);
      if (!row || row.used_at || new Date(row.expires_at) <= now()) throw invalid();

      const passwordHash = await hashPassword(newPassword);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, row.user_id);
      db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(iso(), hash);
      // A reset signs the account out everywhere.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    },
  };
}
