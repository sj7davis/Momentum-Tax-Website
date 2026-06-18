const express = require('express');
const router = express.Router();
const db = require('../db/pool');
const verifyTrafftToken = require('../middleware/verifyToken');
const { parseTrafftPayload } = require('../services/trafft');
const dedup = require('../services/dedup');

// POST /api/onboarding/trafft
// Trafft "Appointment Booked" webhook lands here.
router.post('/trafft', verifyTrafftToken, async (req, res) => {
    try {
        const rec = parseTrafftPayload(req.body || {});

        // Idempotency: if we've already staged this appointment, ack and stop.
        if (rec.trafft_appointment_id) {
            const existing = await db.query(
                'SELECT id FROM onboarding_requests WHERE trafft_appointment_id = $1',
                [rec.trafft_appointment_id]
            );
            if (existing.rows.length) {
                return res.status(200).json({ ok: true, dedup: 'already_staged' });
            }
        }

        // Confidence-scored dedup against XPM (best-effort; failure doesn't block staging).
        let dedupUuid = null, dedupName = null, dedupLevel = 'none', dedupReasons = [];
        try {
            const match = await dedup.findDuplicate(rec);
            dedupLevel = match.level;
            dedupReasons = match.reasons;
            if (match.level !== 'none') { dedupUuid = match.uuid; dedupName = match.name; }
        } catch (_) { /* non-fatal */ }

        // exact email match -> definite duplicate; strong/possible -> needs review;
        // none -> normal pending_review.
        const status = dedupLevel === 'exact' ? 'duplicate' : 'pending_review';

        const { rows } = await db.query(
            `INSERT INTO onboarding_requests
                (trafft_appointment_id, raw_payload, first_name, last_name, email, phone,
                 entity_type, business_name, abn, service_name, intake, appointment_at,
                 status, dedup_match_uuid, dedup_match_name, dedup_level, dedup_reasons)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
             RETURNING id`,
            [
                rec.trafft_appointment_id, req.body, rec.first_name, rec.last_name,
                rec.email, rec.phone, rec.entity_type, rec.business_name, rec.abn,
                rec.service_name, rec.intake, rec.appointment_at, status, dedupUuid,
                dedupName, dedupLevel, JSON.stringify(dedupReasons),
            ]
        );

        // Always 200 quickly so Trafft doesn't retry.
        res.status(200).json({ ok: true, id: rows[0].id, status });
    } catch (err) {
        console.error('[trafft webhook] error:', err);
        // Still 200 to avoid Trafft retry storms; we log for investigation.
        res.status(200).json({ ok: false, error: 'logged' });
    }
});

module.exports = router;
