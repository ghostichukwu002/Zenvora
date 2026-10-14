// Verification for stores. A store is verified only when an administrator says so, and that decision
// is stored, so it survives restarts. The catalogue holds the flag so public pages can show the badge.
// Rider verification is not stored separately: an approved rider is verified (see dispatch.js).

import { transaction } from './db.js';
import { HttpError } from './router.js';

export function createTrust(db, { catalogue, now = () => new Date() }) {
  const iso = () => now().toISOString();

  // Restore verified stores into the catalogue at startup.
  for (const row of db.prepare('SELECT merchant_id FROM store_verifications').all()) {
    const merchant = catalogue.merchants.find((m) => m.id === row.merchant_id);
    if (merchant) merchant.verified = true;
  }

  return {
    storesForAdmin() {
      const rows = db.prepare('SELECT merchant_id, verified_at FROM store_verifications').all();
      const at = new Map(rows.map((r) => [r.merchant_id, r.verified_at]));
      return catalogue.merchants.map((m) => ({
        id: m.id,
        name: m.name,
        city: m.city,
        state: m.state,
        verified: m.verified === true,
        verifiedAt: at.get(m.id) ?? null,
      }));
    },

    setStoreVerified(actorId, merchantId, verified) {
      if (typeof verified !== 'boolean') throw new HttpError(422, 'verified_invalid', 'Choose verified or not verified.');
      const merchant = catalogue.merchants.find((m) => m.id === merchantId);
      if (!merchant) throw new HttpError(404, 'store_not_found', 'Store not found.');

      transaction(db, () => {
        if (verified) {
          db.prepare('INSERT OR REPLACE INTO store_verifications (merchant_id, verified_at, verified_by) VALUES (?, ?, ?)')
            .run(merchantId, iso(), actorId);
        } else {
          db.prepare('DELETE FROM store_verifications WHERE merchant_id = ?').run(merchantId);
        }
        db.prepare('INSERT INTO audit_log (actor_user_id, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(actorId, 'store.verification', merchantId, JSON.stringify({ verified }), iso());
      });
      merchant.verified = verified;
      return this.storesForAdmin().find((s) => s.id === merchantId);
    },
  };
}
