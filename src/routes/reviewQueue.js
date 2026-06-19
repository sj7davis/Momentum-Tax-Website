const express = require('express');
const router = express.Router();
const db = require('../db/pool');
const xpm = require('../services/xpm');
const portalProvision = require('../portal/provision');
const { requireStaffAuth } = require('../portal/staffAuth');

// All review-queue + template-mapping endpoints are staff-only. The public Trafft
// webhook lives in a separate router (trafftWebhook.js), so it is unaffected.
router.use(requireStaffAuth);

// ---- Service -> XPM template mapping --------------------------------------

// GET /api/onboarding/xpm-templates — live job templates from XPM (for the dropdown).
router.get('/xpm-templates', async (_req, res) => {
    try {
        const templates = await xpm.listTemplates();
        res.json({ templates });
    } catch (e) {
        console.error('[xpm-templates] error:', e);
        res.status(502).json({ error: 'could_not_list_templates', detail: e.message });
    }
});

// GET /api/onboarding/service-map — current mappings + the distinct Trafft services
// we've actually received, so staff can map real services without typing them.
router.get('/service-map', async (_req, res) => {
    const maps = (await db.query(
        `SELECT service_name, template_name, template_uuid, updated_at
           FROM service_template_map ORDER BY service_name`
    )).rows;
    const seen = (await db.query(
        `SELECT DISTINCT service_name FROM onboarding_requests
          WHERE service_name IS NOT NULL ORDER BY service_name`
    )).rows.map(r => r.service_name);
    res.json({ mappings: maps, services_seen: seen });
});

// POST /api/onboarding/service-map  { service_name, template_name, template_uuid? }
// Upsert one mapping.
router.post('/service-map', async (req, res) => {
    const { service_name, template_name, template_uuid, reviewer } = req.body || {};
    if (!service_name) return res.status(400).json({ error: 'service_name required' });
    await db.query(
        `INSERT INTO service_template_map (service_name, template_name, template_uuid, updated_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (service_name) DO UPDATE
           SET template_name = EXCLUDED.template_name,
               template_uuid = EXCLUDED.template_uuid,
               updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [service_name, template_name || null, template_uuid || null, reviewer || 'staff']
    );
    res.json({ ok: true });
});

// DELETE /api/onboarding/service-map/:service — remove a mapping.
router.post('/service-map/delete', async (req, res) => {
    if (!req.body || !req.body.service_name) return res.status(400).json({ error: 'service_name required' });
    await db.query('DELETE FROM service_template_map WHERE service_name = $1', [req.body.service_name]);
    res.json({ ok: true });
});

// GET /api/onboarding/xpm-status — confirm the XPM connection is alive.
router.get('/xpm-status', async (_req, res) => {
    try {
        res.json(await xpm.connectionStatus());
    } catch (e) {
        res.status(500).json({ connected: false, error: e.message });
    }
});

// GET /api/onboarding/queue?status=pending_review
router.get('/queue', async (req, res) => {
    const status = req.query.status || 'pending_review';
    const { rows } = await db.query(
        `SELECT id, trafft_appointment_id, first_name, last_name, email, phone,
                entity_type, business_name, abn, service_name, intake, appointment_at,
                status, id_verified, dedup_match_uuid, dedup_match_name,
                dedup_level, dedup_reasons, review_note,
                xpm_client_uuid, xpm_job_number, error_detail, created_at
           FROM onboarding_requests
          WHERE ($1 = 'all' OR status = $1)
          ORDER BY created_at DESC
          LIMIT 200`,
        [status]
    );
    res.json({ requests: rows });
});

// POST /api/onboarding/queue/:id/id-verified   { verified: true }
// Records the Tranche 2 AML/CTF identity check outcome.
router.post('/queue/:id/id-verified', async (req, res) => {
    const verified = req.body && req.body.verified === true;
    await db.query(
        'UPDATE onboarding_requests SET id_verified = $1 WHERE id = $2',
        [verified, req.params.id]
    );
    res.json({ ok: true, id_verified: verified });
});

// POST /api/onboarding/queue/:id/reject  { note }
router.post('/queue/:id/reject', async (req, res) => {
    await db.query(
        `UPDATE onboarding_requests
            SET status = 'rejected', review_note = $1,
                reviewed_at = now(), reviewed_by = $2
          WHERE id = $3`,
        [req.body?.note || null, req.body?.reviewer || 'staff', req.params.id]
    );
    res.json({ ok: true });
});

// POST /api/onboarding/queue/:id/approve
// Provisions client + job + template in XPM. Blocks unless ID is verified.
// POST /api/onboarding/queue/:id/approve
//   body: { reviewer?, override_id_gate?, link_to_uuid?, create_portal_client? }
//
// Modes:
//   - link_to_uuid present  -> DO NOT create a new XPM client; open the job against
//                              that existing client UUID (avoids duplicates).
//   - otherwise             -> create a fresh XPM client + job + template.
// In both modes, unless create_portal_client === false, a portal_clients record is
// created/linked so the client can log into the portal.
router.post('/queue/:id/approve', async (req, res) => {
    const id = req.params.id;
    const { rows } = await db.query(
        'SELECT * FROM onboarding_requests WHERE id = $1', [id]
    );
    const rec = rows[0];
    if (!rec) return res.status(404).json({ error: 'not found' });
    if (rec.status === 'provisioned') {
        return res.json({ ok: true, already: true,
            xpm_client_uuid: rec.xpm_client_uuid, xpm_job_number: rec.xpm_job_number });
    }

    // Tranche 2 gate: do not create/link the XPM client until ID is verified.
    const skipIdGate = req.body && req.body.override_id_gate === true;
    if (!rec.id_verified && !skipIdGate) {
        await db.query(
            `UPDATE onboarding_requests SET status = 'id_pending' WHERE id = $1`, [id]
        );
        return res.status(409).json({
            error: 'identity_not_verified',
            message: 'Complete AML/CTF identity verification before provisioning, ' +
                     'or pass override_id_gate=true to bypass.',
        });
    }

    const linkToUuid = req.body && req.body.link_to_uuid;
    const wantPortal = !(req.body && req.body.create_portal_client === false);

    try {
        let clientUuid, jobNumber, linked = false;

        if (linkToUuid) {
            // Link mode: confirm the client still exists, then open a job on it.
            const existing = await xpm.getClient(linkToUuid);
            if (!existing) {
                return res.status(400).json({ error: 'link_target_not_found',
                    detail: `XPM client ${linkToUuid} not found — cannot link.` });
            }
            const templateName = await xpm.resolveTemplateName(rec.service_name);
            jobNumber = await xpm.addJob({
                clientUuid: linkToUuid,
                name: rec.service_name || 'New engagement',
                description: `Linked from Trafft booking ${rec.trafft_appointment_id || ''}`.trim(),
                staffUuid: process.env.XPM_DEFAULT_STAFF_UUID,
                startDate: new Date().toISOString().slice(0, 10),
                state: 'Planned',
            });
            await xpm.applyTemplate(jobNumber, templateName);
            clientUuid = linkToUuid;
            linked = true;
        } else {
            // Create mode: fresh client + job + template.
            const result = await xpm.provision(rec);
            clientUuid = result.clientUuid;
            jobNumber = result.jobNumber;
        }

        // Auto-create / link the portal client.
        let portal = null;
        if (wantPortal) {
            try {
                portal = await portalProvision.upsertPortalClient(rec, clientUuid);
            } catch (e) {
                console.warn('[approve] portal client upsert failed (non-fatal):', e.message);
            }
        }

        await db.query(
            `UPDATE onboarding_requests
                SET status = 'provisioned', xpm_client_uuid = $1, xpm_job_number = $2,
                    link_existing = $3, error_detail = NULL, reviewed_at = now(),
                    reviewed_by = $4, provisioned_at = now()
              WHERE id = $5`,
            [clientUuid, jobNumber, linked, req.body?.reviewer || 'staff', id]
        );
        res.json({ ok: true, linked, xpm_client_uuid: clientUuid,
                   xpm_job_number: jobNumber, portal_client: portal });
    } catch (err) {
        console.error('[approve] provisioning failed:', err);
        await db.query(
            `UPDATE onboarding_requests SET status = 'error', error_detail = $1 WHERE id = $2`,
            [String(err.message).slice(0, 1000), id]
        );
        res.status(502).json({ error: 'provisioning_failed', detail: err.message });
    }
});

module.exports = router;
