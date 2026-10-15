// Delivery dispatch: rider registration and approval, manual assignment by administrators,
// and the rider's pickup, delivery and failure steps.
//
// Rules this module enforces (never trusted from the browser):
// - Only an approved rider can take work, and only in an area they cover.
// - Only the rider a delivery is assigned to can pick it up, complete it or decline it.
// - A delivery is marked delivered only by the assigned rider, with proof and cash confirmed.
// - Every step is a conditional update inside a transaction, so a double tap cannot apply twice.
// - Every administrator and rider action is written to the audit log.

import { transaction } from './db.js';
import { normalizeNigerianPhone } from './auth.js';
import { serializeOrder } from './orders.js';
import { HttpError } from './router.js';

export const VEHICLES = ['bicycle', 'motorcycle', 'car', 'van'];
export const RIDER_STATUSES = ['pending', 'approved', 'suspended'];
const MAX_AREAS = 10;

function cleanNote(value, { min, max, field }) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (text.length < min || text.length > max) {
    throw new HttpError(422, `${field}_invalid`, `Check the ${field.replace('_', ' ')} and try again.`);
  }
  return text;
}

function parseAreas(value, allowedAreas) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_AREAS) {
    throw new HttpError(422, 'areas_invalid', 'Choose at least one area you can deliver in.');
  }
  const unique = [...new Set(value.map((v) => (typeof v === 'string' ? v : '')))];
  for (const area of unique) {
    if (!allowedAreas.has(area)) {
      throw new HttpError(422, 'areas_invalid', `"${area || 'That area'}" is not a delivery area we serve.`);
    }
  }
  return unique;
}

// Where the order's area is covered by this rider.
function riderCovers(rider, area) {
  return JSON.parse(rider.areas_json).includes(area);
}

// What a rider sees about one job. Cash is shown only while it is still owed.
function serializeJob(db, row) {
  const order = serializeOrder(db, row);
  const owesCash = order.paymentMethod === 'cash_on_delivery' && order.paymentStatus === 'cod_pending';
  return {
    orderId: order.id,
    orderStatus: order.status,
    deliveryStatus: row.d_status,
    pickup: { merchantName: order.merchant.name, city: row.merchant_city, state: row.merchant_state },
    dropoff: order.delivery,
    totalKobo: order.totalKobo,
    cashToCollectKobo: owesCash ? order.totalKobo : 0,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    assignedAt: row.assigned_at,
    pickedUpAt: row.picked_up_at,
    completedAt: row.completed_at,
    proofNote: row.proof_note,
    failureReason: row.failure_reason,
  };
}

function serializeRider(row) {
  return {
    userId: row.user_id,
    status: row.status,
    vehicle: row.vehicle,
    phone: row.phone,
    areas: JSON.parse(row.areas_json),
    available: row.available === 1,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

export function createDispatch(db, { catalogue, now = () => new Date() }) {
  const iso = () => now().toISOString();
  const allowedAreas = new Set(catalogue.merchants.flatMap((m) => m.serviceAreas));
  const merchantLocation = new Map(catalogue.merchants.map((m) => [m.id, { city: m.city, state: m.state }]));

  function audit(actorId, action, target, detail = {}) {
    db.prepare('INSERT INTO audit_log (actor_user_id, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(actorId, action, target, JSON.stringify(detail), iso());
  }

  function jobsFor(riderUserId, whereSql, params = []) {
    const rows = db
      .prepare(
        `SELECT o.*, d.status AS d_status, d.assigned_at, d.picked_up_at, d.completed_at, d.proof_note, d.failure_reason
         FROM deliveries d JOIN orders o ON o.id = d.order_id
         WHERE d.rider_user_id = ? ${whereSql} ORDER BY d.assigned_at DESC LIMIT 100`,
      )
      .all(riderUserId, ...params);
    return rows.map((row) => {
      const loc = merchantLocation.get(row.merchant_id) ?? {};
      return serializeJob(db, { ...row, merchant_city: loc.city, merchant_state: loc.state });
    });
  }

  function riderRow(userId) {
    return db.prepare('SELECT * FROM riders WHERE user_id = ?').get(userId);
  }

  function requireApprovedRider(userId) {
    const row = riderRow(userId);
    if (!row) throw new HttpError(403, 'not_a_rider', 'Apply to become a rider first.');
    if (row.status !== 'approved') {
      throw new HttpError(403, 'rider_not_approved', row.status === 'suspended'
        ? 'Your rider account is suspended. Contact ZENVORA support.'
        : 'Your rider application is still waiting for approval.');
    }
    return row;
  }

  // The job row for one order, if it is assigned to this rider.
  function ownJob(riderUserId, orderId) {
    const row = db
      .prepare(
        `SELECT o.*, d.status AS d_status, d.assigned_at, d.picked_up_at, d.completed_at, d.proof_note, d.failure_reason
         FROM deliveries d JOIN orders o ON o.id = d.order_id
         WHERE d.order_id = ? AND d.rider_user_id = ?`,
      )
      .get(orderId, riderUserId);
    if (!row) throw new HttpError(404, 'delivery_not_found', 'That delivery is not assigned to you.');
    return row;
  }

  function jobForRider(userId, orderId) {
    const row = db
      .prepare(
        `SELECT o.*, d.status AS d_status, d.assigned_at, d.picked_up_at, d.completed_at, d.proof_note, d.failure_reason
         FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE d.order_id = ? AND d.rider_user_id = ?`,
      )
      .get(orderId, userId);
    if (!row) return null;
    const loc = merchantLocation.get(row.merchant_id) ?? {};
    return serializeJob(db, { ...row, merchant_city: loc.city, merchant_state: loc.state });
  }

  function adminRiders() {
    const rows = db
      .prepare(
        `SELECT r.*, u.full_name, u.email,
                (SELECT COUNT(*) FROM deliveries d WHERE d.rider_user_id = r.user_id AND d.status IN ('assigned','picked_up')) AS active_count
         FROM riders r JOIN users u ON u.id = r.user_id
         ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, r.created_at`,
      )
      .all();
    return rows.map((row) => ({
      ...serializeRider(row),
      name: row.full_name,
      email: row.email,
      adminNote: row.admin_note,
      activeCount: row.active_count,
    }));
  }

  function changeOrder(orderId, fromStatus, toStatus, extraSql = '', extraParams = []) {
    const result = db
      .prepare(`UPDATE orders SET status = ?${extraSql} WHERE id = ? AND status = ?`)
      .run(toStatus, ...extraParams, orderId, fromStatus);
    if (result.changes !== 1) {
      throw new HttpError(409, 'status_changed', 'This delivery was just updated. Refresh and try again.');
    }
  }

  return {
    // ----- Riders -----

    applyAsRider(userId, input) {
      const body = input && typeof input === 'object' ? input : {};
      if (!VEHICLES.includes(body.vehicle)) {
        throw new HttpError(422, 'vehicle_invalid', 'Choose the vehicle you deliver with.');
      }
      const phone = normalizeNigerianPhone(body.phone);
      if (!phone) {
        throw new HttpError(422, 'phone_invalid', 'Enter a valid Nigerian mobile number, for example 0803 123 4567.');
      }
      const areas = parseAreas(body.areas, allowedAreas);

      if (riderRow(userId)) {
        throw new HttpError(409, 'already_applied', 'You have already applied. We will be in touch after review.');
      }
      transaction(db, () => {
        db.prepare(
          `INSERT INTO riders (user_id, status, vehicle, phone, areas_json, available, created_at)
           VALUES (?, 'pending', ?, ?, ?, 0, ?)`,
        ).run(userId, body.vehicle, phone, JSON.stringify(areas), iso());
        audit(userId, 'rider.apply', userId, { vehicle: body.vehicle, areas });
      });
      return serializeRider(riderRow(userId));
    },

    riderProfile(userId) {
      const row = riderRow(userId);
      return row ? serializeRider(row) : null;
    },

    setAvailability(userId, available) {
      requireApprovedRider(userId);
      if (typeof available !== 'boolean') {
        throw new HttpError(422, 'availability_invalid', 'Choose whether you are available.');
      }
      db.prepare('UPDATE riders SET available = ? WHERE user_id = ?').run(available ? 1 : 0, userId);
      return serializeRider(riderRow(userId));
    },

    riderJobs(userId) {
      requireApprovedRider(userId);
      const active = jobsFor(userId, "AND d.status IN ('assigned', 'picked_up')");
      const history = jobsFor(userId, "AND d.status IN ('delivered', 'failed')");
      return { active, history };
    },

    pickUp(userId, orderId) {
      requireApprovedRider(userId);
      const job = ownJob(userId, orderId);
      if (job.d_status !== 'assigned' || job.status !== 'ready') {
        throw new HttpError(409, 'invalid_transition', 'This order is not ready for pickup.');
      }
      transaction(db, () => {
        changeOrder(orderId, 'ready', 'out_for_delivery');
        db.prepare("UPDATE deliveries SET status = 'picked_up', picked_up_at = ? WHERE order_id = ? AND rider_user_id = ? AND status = 'assigned'")
          .run(iso(), orderId, userId);
        audit(userId, 'delivery.picked_up', orderId);
      });
      return jobForRider(userId, orderId);
    },

    complete(userId, orderId, input) {
      requireApprovedRider(userId);
      const body = input && typeof input === 'object' ? input : {};
      const job = ownJob(userId, orderId);
      if (job.d_status !== 'picked_up' || job.status !== 'out_for_delivery') {
        throw new HttpError(409, 'invalid_transition', 'Pick the order up before marking it delivered.');
      }
      const proof = cleanNote(body.proofNote, { min: 2, max: 300, field: 'proof_note' });
      // Cash on delivery: the rider must confirm the cash was received before the order closes.
      if (job.payment_method === 'cash_on_delivery' && body.cashCollected !== true) {
        throw new HttpError(422, 'cash_not_confirmed', 'Confirm you collected the cash before marking the order delivered.');
      }
      const paymentStatus = job.payment_method === 'cash_on_delivery' ? 'cod_collected' : job.payment_status;
      const completedAt = iso();
      transaction(db, () => {
        changeOrder(orderId, 'out_for_delivery', 'delivered', ', payment_status = ?', [paymentStatus]);
        db.prepare("UPDATE deliveries SET status = 'delivered', completed_at = ?, proof_note = ? WHERE order_id = ? AND rider_user_id = ?")
          .run(completedAt, proof, orderId, userId);
        audit(userId, 'delivery.completed', orderId, { proof });
      });
      return jobForRider(userId, orderId);
    },

    fail(userId, orderId, input) {
      requireApprovedRider(userId);
      const body = input && typeof input === 'object' ? input : {};
      const job = ownJob(userId, orderId);
      if (job.d_status !== 'picked_up' || job.status !== 'out_for_delivery') {
        throw new HttpError(409, 'invalid_transition', 'Only an order you have picked up can be marked as not delivered.');
      }
      const reason = cleanNote(body.reason, { min: 2, max: 200, field: 'reason' });
      transaction(db, () => {
        changeOrder(orderId, 'out_for_delivery', 'delivery_failed');
        db.prepare("UPDATE deliveries SET status = 'failed', completed_at = ?, failure_reason = ? WHERE order_id = ? AND rider_user_id = ?")
          .run(iso(), reason, orderId, userId);
        audit(userId, 'delivery.failed', orderId, { reason });
      });
      return jobForRider(userId, orderId);
    },

    // A rider who cannot take an assigned job before pickup hands it back to the queue.
    decline(userId, orderId) {
      requireApprovedRider(userId);
      const job = ownJob(userId, orderId);
      if (job.d_status !== 'assigned') {
        throw new HttpError(409, 'invalid_transition', 'You can only decline a job before you pick it up.');
      }
      transaction(db, () => {
        db.prepare("DELETE FROM deliveries WHERE order_id = ? AND rider_user_id = ? AND status = 'assigned'").run(orderId, userId);
        audit(userId, 'delivery.declined', orderId);
      });
      return { declined: true };
    },

    // What a customer may see about the rider on their order: a first name, the vehicle and whether
    // the rider is verified. Never a phone number, address or any other detail.
    publicRiderFor(orderId) {
      const row = db.prepare(
        `SELECT u.full_name, r.vehicle, r.status AS rider_status
         FROM deliveries d JOIN users u ON u.id = d.rider_user_id JOIN riders r ON r.user_id = d.rider_user_id
         WHERE d.order_id = ? AND d.status IN ('assigned', 'picked_up')`,
      ).get(orderId);
      if (!row || row.rider_status !== 'approved') return null;
      return { firstName: row.full_name.split(' ')[0], vehicle: row.vehicle, verified: true };
    },

    // ----- Administrators -----

    adminRiders,

    // Figures for the administrator dashboard. Days are Lagos days (UTC+1, no daylight saving).
    // Rejected orders are left out of every money figure.
    adminInsights() {
      const LAGOS_OFFSET_MS = 60 * 60 * 1000;
      const lagosDay = (date) => new Date(date.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
      const current = now();
      const today = lagosDay(current);
      const sinceIso = new Date(current.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

      const byDay = new Map();
      for (const row of db.prepare(
        `SELECT date(created_at, '+1 hour') AS day, COUNT(*) AS orders, COALESCE(SUM(total_kobo), 0) AS revenue
         FROM orders WHERE status != 'rejected' AND created_at >= ? GROUP BY day`,
      ).all(sinceIso)) {
        byDay.set(row.day, { orders: row.orders, revenueKobo: row.revenue });
      }
      const days = [];
      for (let i = 13; i >= 0; i -= 1) {
        const key = lagosDay(new Date(current.getTime() - i * 24 * 60 * 60 * 1000));
        days.push({ date: key, ...(byDay.get(key) ?? { orders: 0, revenueKobo: 0 }) });
      }

      const sectionOfMerchant = new Map(catalogue.merchants.map((m) => [m.id, m.section ?? 'shop']));
      const sections = { shop: { orders: 0, revenueKobo: 0 }, puff: { orders: 0, revenueKobo: 0 } };
      for (const row of db.prepare(
        "SELECT merchant_id, COUNT(*) AS orders, COALESCE(SUM(total_kobo), 0) AS revenue FROM orders WHERE status != 'rejected' GROUP BY merchant_id",
      ).all()) {
        const key = sectionOfMerchant.get(row.merchant_id) === 'puff' ? 'puff' : 'shop';
        sections[key].orders += row.orders;
        sections[key].revenueKobo += row.revenue;
      }

      const statuses = Object.fromEntries(
        db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all().map((r) => [r.status, r.n]),
      );

      const topProducts = db.prepare(
        `SELECT oi.name AS name, SUM(oi.quantity) AS quantity, SUM(oi.line_kobo) AS revenue
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.status != 'rejected' GROUP BY oi.product_id, oi.name ORDER BY revenue DESC LIMIT 5`,
      ).all().map((r) => ({ name: r.name, quantity: r.quantity, revenueKobo: r.revenue }));

      const latest = days[days.length - 1];
      const totals = days.reduce((acc, d) => ({ orders: acc.orders + d.orders, revenueKobo: acc.revenueKobo + d.revenueKobo }), { orders: 0, revenueKobo: 0 });
      return {
        today: { date: today, orders: latest.orders, revenueKobo: latest.revenueKobo },
        last14Days: totals,
        days,
        sections,
        statuses,
        topProducts,
        ridersOnline: db.prepare("SELECT COUNT(*) AS n FROM riders WHERE status = 'approved' AND available = 1").get().n,
      };
    },

    adminOverview() {
      const count = (sql, ...params) => db.prepare(sql).get(...params).n;
      return {
        ridersAwaitingApproval: count("SELECT COUNT(*) AS n FROM riders WHERE status = 'pending'"),
        readyForPickup: count("SELECT COUNT(*) AS n FROM orders WHERE status = 'ready'"),
        unassigned: count("SELECT COUNT(*) AS n FROM orders o WHERE o.status = 'ready' AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.order_id = o.id)"),
        onTheRoad: count("SELECT COUNT(*) AS n FROM orders WHERE status = 'out_for_delivery'"),
        failed: count("SELECT COUNT(*) AS n FROM orders WHERE status = 'delivery_failed'"),
      };
    },

    adminOrders() {
      const rows = db
        .prepare(
          `SELECT o.*, d.status AS d_status, d.rider_user_id, d.assigned_at, d.picked_up_at, d.completed_at,
                  d.proof_note, d.failure_reason, u.full_name AS rider_name, r.phone AS rider_phone
           FROM orders o
           LEFT JOIN deliveries d ON d.order_id = o.id
           LEFT JOIN users u ON u.id = d.rider_user_id
           LEFT JOIN riders r ON r.user_id = d.rider_user_id
           WHERE o.status IN ('ready', 'out_for_delivery', 'delivery_failed', 'delivered')
           ORDER BY o.created_at DESC, o.id DESC LIMIT 200`,
        )
        .all();
      return rows.map((row) => {
        const state = row.status === 'ready'
          ? (row.d_status ? 'assigned' : 'unassigned')
          : row.status === 'out_for_delivery' ? 'picked_up'
          : row.status === 'delivery_failed' ? 'failed' : 'delivered';
        return {
          ...serializeOrder(db, row),
          dispatch: {
            state,
            rider: row.rider_user_id ? { userId: row.rider_user_id, name: row.rider_name, phone: row.rider_phone } : null,
            assignedAt: row.assigned_at ?? null,
            completedAt: row.completed_at ?? null,
            proofNote: row.proof_note ?? null,
            failureReason: row.failure_reason ?? null,
          },
        };
      });
    },

    // Approve, suspend or return a rider to pending. Suspending releases jobs not yet picked up.
    reviewRider(actorId, riderUserId, input) {
      const body = input && typeof input === 'object' ? input : {};
      if (!RIDER_STATUSES.includes(body.status)) {
        throw new HttpError(422, 'status_invalid', 'Choose approved, suspended or pending.');
      }
      const note = body.adminNote === undefined || body.adminNote === ''
        ? null
        : cleanNote(body.adminNote, { min: 1, max: 300, field: 'admin_note' });
      if (!riderRow(riderUserId)) throw new HttpError(404, 'rider_not_found', 'Rider not found.');

      transaction(db, () => {
        const approvedAt = body.status === 'approved' ? iso() : null;
        db.prepare(
          `UPDATE riders SET status = ?, admin_note = ?, available = CASE WHEN ? = 'approved' THEN available ELSE 0 END,
             approved_at = COALESCE(?, approved_at) WHERE user_id = ?`,
        ).run(body.status, note, body.status, approvedAt, riderUserId);
        let released = 0;
        if (body.status !== 'approved') {
          const jobs = db
            .prepare("SELECT order_id FROM deliveries WHERE rider_user_id = ? AND status = 'assigned'")
            .all(riderUserId);
          for (const job of jobs) {
            db.prepare("DELETE FROM deliveries WHERE order_id = ? AND status = 'assigned'").run(job.order_id);
            released += 1;
          }
        }
        audit(actorId, 'rider.review', riderUserId, { status: body.status, adminNote: note, released });
      });
      return adminRiders().find((r) => r.userId === riderUserId);
    },

    // Manual dispatch. Works for orders ready for pickup, or whose last delivery failed.
    assignDelivery(actorId, orderId, riderUserId) {
      if (typeof riderUserId !== 'string') throw new HttpError(422, 'rider_required', 'Choose a rider.');
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!order) throw new HttpError(404, 'order_not_found', 'Order not found.');
      if (!['ready', 'delivery_failed'].includes(order.status)) {
        throw new HttpError(409, 'invalid_transition', 'Only orders ready for pickup, or with a failed delivery, can be assigned.');
      }
      const rider = riderRow(riderUserId);
      if (!rider) throw new HttpError(404, 'rider_not_found', 'Rider not found.');
      if (rider.status !== 'approved') {
        throw new HttpError(409, 'rider_not_approved', 'Only approved riders can be assigned deliveries.');
      }
      if (!riderCovers(rider, order.delivery_area)) {
        throw new HttpError(409, 'outside_rider_area', `This rider does not cover ${order.delivery_area}.`);
      }

      transaction(db, () => {
        if (order.status === 'delivery_failed') {
          changeOrder(orderId, 'delivery_failed', 'ready');
        }
        // Replacing a previous assignment is allowed while it has not been picked up.
        db.prepare("DELETE FROM deliveries WHERE order_id = ? AND status IN ('assigned', 'failed')").run(orderId);
        db.prepare("INSERT INTO deliveries (order_id, rider_user_id, status, assigned_at) VALUES (?, ?, 'assigned', ?)")
          .run(orderId, riderUserId, iso());
        audit(actorId, 'delivery.assigned', orderId, { riderUserId, previousStatus: order.status });
      });
      return serializeOrder(db, db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
    },

    auditLog(limit = 200) {
      return db
        .prepare(
          `SELECT a.id, a.action, a.target, a.detail_json, a.created_at, u.email AS actor_email, u.full_name AS actor_name
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
           ORDER BY a.id DESC LIMIT ?`,
        )
        .all(limit)
        .map((r) => ({
          id: r.id,
          action: r.action,
          target: r.target,
          detail: JSON.parse(r.detail_json),
          createdAt: r.created_at,
          actor: { name: r.actor_name, email: r.actor_email },
        }));
    },
  };
}
