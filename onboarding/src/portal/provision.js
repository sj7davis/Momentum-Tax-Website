// Creates (or links) a portal_clients record from an approved onboarding request,
// so the client can immediately log into the portal after onboarding.
//
// Idempotent on email: if a portal client already exists for that email we update
// the XPM link rather than creating a duplicate portal account.

const db = require('../db/pool');

async function upsertPortalClient(rec, xpmClientUuid) {
    const email = (rec.email || '').trim().toLowerCase();
    if (!email) return null; // can't create a portal login without an email

    const fullName = `${rec.first_name || ''} ${rec.last_name || ''}`.trim() || null;

    const { rows } = await db.query(
        `INSERT INTO portal_clients (email, full_name, business_name, entity_type, xpm_client_uuid)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (email) DO UPDATE
           SET full_name      = COALESCE(portal_clients.full_name, EXCLUDED.full_name),
               business_name  = COALESCE(EXCLUDED.business_name, portal_clients.business_name),
               entity_type    = COALESCE(EXCLUDED.entity_type, portal_clients.entity_type),
               xpm_client_uuid = COALESCE(EXCLUDED.xpm_client_uuid, portal_clients.xpm_client_uuid)
         RETURNING id, email`,
        [email, fullName, rec.business_name || null, rec.entity_type || null, xpmClientUuid || null]
    );
    return rows[0];
}

module.exports = { upsertPortalClient };
