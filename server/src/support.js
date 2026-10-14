// Customer care requests. Only signed-in customers can write, so every request has an account to
// reply to. Replies are shown in the app; no email is sent until an email provider is connected.

import { transaction } from './db.js';
import { HttpError } from './router.js';
import { randomBytes } from 'node:crypto';

export const TOPICS = ['order', 'payment', 'delivery', 'account', 'other'];
export const SUPPORT_STATUSES = ['open', 'answered', 'closed'];
const MAX_OPEN_PER_CUSTOMER = 5;
const ORDER_ID_RE = /^ZV-[0-9A-F]{10}$/;

function serialize(row) {
  return {
    id: row.id,
    topic: row.topic,
    orderId: row.order_id,
    message: row.message,
    status: row.status,
    reply: row.reply,
    repliedAt: row.replied_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSupport(db, { now = () => new Date() } = {}) {
  const iso = () => now().toISOString();

  function audit(actorId, action, target, detail = {}) {
    db.prepare('INSERT INTO audit_log (actor_user_id, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(actorId, action, target, JSON.stringify(detail), iso());
  }

  return {
    create(user, input) {
      const body = input && typeof input === 'object' ? input : {};
      if (!TOPICS.includes(body.topic)) {
        throw new HttpError(422, 'topic_invalid', 'Choose what your message is about.');
      }
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (message.length < 10 || message.length > 1000) {
        throw new HttpError(422, 'message_invalid', 'Write between 10 and 1000 characters so we can help.');
      }

      let orderId = null;
      if (typeof body.orderId === 'string' && body.orderId.trim() !== '') {
        orderId = body.orderId.trim().toUpperCase();
        if (!ORDER_ID_RE.test(orderId)) {
          throw new HttpError(422, 'order_invalid', 'Order numbers look like ZV-XXXXXXXXXX.');
        }
        // Customers can only attach their own orders, so a request cannot point at someone else's.
        if (!db.prepare('SELECT 1 FROM orders WHERE id = ? AND user_id = ?').get(orderId, user.id)) {
          throw new HttpError(422, 'order_not_yours', 'That order is not on your account.');
        }
      }

      const open = db.prepare("SELECT COUNT(*) AS n FROM support_requests WHERE user_id = ? AND status = 'open'").get(user.id).n;
      if (open >= MAX_OPEN_PER_CUSTOMER) {
        throw new HttpError(409, 'too_many_open', `You already have ${MAX_OPEN_PER_CUSTOMER} open requests. We will reply to them first.`);
      }

      const id = `SR-${randomBytes(4).toString('hex').toUpperCase()}`;
      const at = iso();
      db.prepare(
        `INSERT INTO support_requests (id, user_id, topic, order_id, message, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
      ).run(id, user.id, body.topic, orderId, message, at, at);
      return serialize(db.prepare('SELECT * FROM support_requests WHERE id = ?').get(id));
    },

    listMine(userId) {
      return db.prepare('SELECT * FROM support_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
        .all(userId)
        .map(serialize);
    },

    adminList(status) {
      const filter = SUPPORT_STATUSES.includes(status) ? 'WHERE r.status = ?' : '';
      const params = filter ? [status] : [];
      return db.prepare(
        `SELECT r.*, u.full_name AS customer_name, u.email AS customer_email
         FROM support_requests r LEFT JOIN users u ON u.id = r.user_id
         ${filter} ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 200`,
      ).all(...params).map((r) => ({
        ...serialize(r),
        customer: { name: r.customer_name, email: r.customer_email },
      }));
    },

    // Staff answer a request and set its status. A reply is optional, so a status can change alone.
    respond(actorId, requestId, input) {
      const body = input && typeof input === 'object' ? input : {};
      if (!SUPPORT_STATUSES.includes(body.status)) {
        throw new HttpError(422, 'status_invalid', 'Choose open, answered or closed.');
      }
      let reply = null;
      if (body.reply !== undefined && body.reply !== null && String(body.reply).trim() !== '') {
        reply = String(body.reply).trim().replace(/\s+/g, ' ');
        if (reply.length > 2000) throw new HttpError(422, 'reply_invalid', 'Keep replies under 2000 characters.');
      }
      const row = db.prepare('SELECT * FROM support_requests WHERE id = ?').get(requestId);
      if (!row) throw new HttpError(404, 'request_not_found', 'Support request not found.');

      transaction(db, () => {
        db.prepare(
          `UPDATE support_requests SET status = ?, reply = COALESCE(?, reply),
             replied_at = CASE WHEN ? IS NULL THEN replied_at ELSE ? END, updated_at = ? WHERE id = ?`,
        ).run(body.status, reply, reply, iso(), iso(), requestId);
        audit(actorId, 'support.respond', requestId, { status: body.status, replied: reply !== null });
      });
      return serialize(db.prepare('SELECT * FROM support_requests WHERE id = ?').get(requestId));
    },
  };
}
