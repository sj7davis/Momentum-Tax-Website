// Staff-facing document + form management.
// NOTE: protect with your portal's staff auth middleware in production:
//   router.use(requireStaffAuth);

const express = require('express');
const router = express.Router();
const db = require('../db/pool');
const storage = require('./storage');
const { sendMagicLink } = require('./email'); // reused transport
const { sendClientEmail } = require('./notify');

// ---------- find clients (for the staff picker) ----------
router.get('/clients', async (req, res) => {
    const q = `%${(req.query.q || '').toLowerCase()}%`;
    const { rows } = await db.query(
        `SELECT id, email, full_name, business_name, xpm_client_uuid
           FROM portal_clients
          WHERE status='active' AND (lower(email) LIKE $1 OR lower(coalesce(full_name,'')) LIKE $1
                OR lower(coalesce(business_name,'')) LIKE $1)
          ORDER BY created_at DESC LIMIT 50`,
        [q]
    );
    res.json({ clients: rows });
});

// ---------- DOCUMENTS: staff shares a file TO a client ----------
// Two-step like the client side: presign, then confirm.
router.post('/docs/presign', async (req, res) => {
    const { clientId, filename, contentType, sizeBytes } = req.body || {};
    if (!clientId || !filename) return res.status(400).json({ error: 'clientId and filename required' });
    const check = storage.validateUpload({ contentType, sizeBytes });
    if (!check.ok) return res.status(400).json({ error: check.reason });
    const key = storage.buildKey(clientId, filename);
    const url = await storage.presignUpload(key, contentType);
    res.json({ uploadUrl: url, storageKey: key });
});

router.post('/docs/confirm', async (req, res) => {
    const { clientId, storageKey, filename, contentType, sizeBytes, category, xpmJobNumber, note, notify } =
        req.body || {};
    if (!clientId || !storageKey || !filename) return res.status(400).json({ error: 'missing fields' });
    if (!storageKey.startsWith(`clients/${clientId}/`)) {
        return res.status(403).json({ error: 'key does not belong to that client' });
    }
    const { rows } = await db.query(
        `INSERT INTO portal_documents
            (client_id, storage_key, filename, content_type, size_bytes, direction,
             category, uploaded_by, xpm_job_number, note)
         VALUES ($1,$2,$3,$4,$5,'to_client',$6,'staff',$7,$8)
         RETURNING id`,
        [clientId, storageKey, filename, contentType || null, sizeBytes || null,
         category || 'General', xpmJobNumber || null, note || null]
    );
    if (notify) await notifyClient(clientId, 'A new document is available in your portal',
        `We've shared "${filename}" with you. Log in to view it.`);
    res.json({ ok: true, id: rows[0].id });
});

// ---------- DOCUMENTS: staff requests an upload FROM a client ----------
router.post('/doc-requests', async (req, res) => {
    const { clientId, title, description, dueDate, xpmJobNumber, notify } = req.body || {};
    if (!clientId || !title) return res.status(400).json({ error: 'clientId and title required' });
    const { rows } = await db.query(
        `INSERT INTO portal_document_requests
            (client_id, title, description, due_date, xpm_job_number)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [clientId, title, description || null, dueDate || null, xpmJobNumber || null]
    );
    if (notify) await notifyClient(clientId, 'Action needed: document request',
        `We need you to upload: ${title}. Log in to your portal to send it through.`);
    res.json({ ok: true, id: rows[0].id });
});

// staff view of a client's docs
router.get('/clients/:id/docs', async (req, res) => {
    const docs = (await db.query(
        `SELECT id, filename, direction, category, size_bytes, xpm_job_number, note, created_at
           FROM portal_documents WHERE client_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
        [req.params.id])).rows;
    const reqs = (await db.query(
        `SELECT id, title, status, due_date, created_at, fulfilled_at
           FROM portal_document_requests WHERE client_id=$1 ORDER BY created_at DESC`,
        [req.params.id])).rows;
    res.json({ documents: docs, requests: reqs });
});

// staff download of any client doc
router.get('/docs/:id/download', async (req, res) => {
    const { rows } = await db.query(
        'SELECT storage_key, filename FROM portal_documents WHERE id=$1 AND deleted_at IS NULL',
        [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const url = await storage.presignDownload(rows[0].storage_key, rows[0].filename);
    res.json({ url });
});

// ---------- FORM TEMPLATES ----------
router.get('/form-templates', async (_req, res) => {
    const { rows } = await db.query(
        'SELECT id, code, name, description, fields, active FROM form_templates ORDER BY name');
    res.json({ templates: rows });
});

router.post('/form-templates', async (req, res) => {
    const { code, name, description, fields } = req.body || {};
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    try {
        const { rows } = await db.query(
            `INSERT INTO form_templates (code, name, description, fields)
             VALUES ($1,$2,$3,$4) RETURNING id`,
            [code, name, description || null, JSON.stringify(fields || [])]);
        res.json({ ok: true, id: rows[0].id });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ---------- SEND A FORM TO A CLIENT ----------
router.post('/forms/send', async (req, res) => {
    const { clientId, templateId, dueDate, xpmJobNumber, notify } = req.body || {};
    if (!clientId || !templateId) return res.status(400).json({ error: 'clientId and templateId required' });
    const tpl = (await db.query('SELECT * FROM form_templates WHERE id=$1', [templateId])).rows[0];
    if (!tpl) return res.status(404).json({ error: 'template not found' });
    const { rows } = await db.query(
        `INSERT INTO form_assignments (template_id, client_id, title, due_date, xpm_job_number)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [templateId, clientId, tpl.name, dueDate || null, xpmJobNumber || null]);
    if (notify) await notifyClient(clientId, `Please complete: ${tpl.name}`,
        `We've sent you a form to complete: ${tpl.name}. Log in to your portal to fill it in.`);
    res.json({ ok: true, id: rows[0].id });
});

// ---------- FOLLOW-UPS / REMINDERS ----------
// List outstanding items (forms not submitted, doc requests still open) for chasing.
router.get('/outstanding', async (_req, res) => {
    const forms = (await db.query(
        `SELECT a.id, a.title, a.status, a.due_date, a.reminder_count, a.last_reminder_at,
                c.id AS client_id, c.email, c.full_name, c.business_name
           FROM form_assignments a JOIN portal_clients c ON c.id=a.client_id
          WHERE a.status IN ('sent','in_progress')
          ORDER BY a.due_date NULLS LAST, a.created_at`)).rows;
    const docs = (await db.query(
        `SELECT r.id, r.title, r.due_date, c.id AS client_id, c.email, c.full_name, c.business_name
           FROM portal_document_requests r JOIN portal_clients c ON c.id=r.client_id
          WHERE r.status='open'
          ORDER BY r.due_date NULLS LAST, r.created_at`)).rows;
    res.json({ forms, doc_requests: docs });
});

// Send a reminder for a specific form assignment.
router.post('/forms/:id/remind', async (req, res) => {
    const a = (await db.query(
        `SELECT a.*, c.email, c.full_name FROM form_assignments a
           JOIN portal_clients c ON c.id=a.client_id WHERE a.id=$1`, [req.params.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'not found' });
    await notifyClient(a.client_id, `Reminder: ${a.title}`,
        `Just a friendly reminder to complete "${a.title}" in your portal when you have a moment.`);
    await db.query(
        `UPDATE form_assignments SET reminder_count=reminder_count+1, last_reminder_at=now()
          WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
});

// Send a reminder for a document request.
router.post('/doc-requests/:id/remind', async (req, res) => {
    const r = (await db.query(
        'SELECT * FROM portal_document_requests WHERE id=$1', [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'not found' });
    await notifyClient(r.client_id, `Reminder: ${r.title}`,
        `A quick reminder that we're still waiting on "${r.title}". You can upload it in your portal.`);
    res.json({ ok: true });
});

// review a submitted form (mark reviewed + see answers)
router.get('/forms/:id', async (req, res) => {
    const a = (await db.query(
        `SELECT a.*, t.fields, r.answers, c.email, c.full_name, c.business_name
           FROM form_assignments a
           JOIN form_templates t ON t.id=a.template_id
           LEFT JOIN form_responses r ON r.assignment_id=a.id
           JOIN portal_clients c ON c.id=a.client_id
          WHERE a.id=$1`, [req.params.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'not found' });
    res.json(a);
});

router.post('/forms/:id/reviewed', async (req, res) => {
    await db.query(`UPDATE form_assignments SET status='reviewed' WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
});

// ---------- helper ----------
async function notifyClient(clientId, subject, body) {
    const c = (await db.query('SELECT email FROM portal_clients WHERE id=$1', [clientId])).rows[0];
    if (!c) return;
    const loginUrl = `${process.env.PORTAL_BASE_URL || 'http://localhost:3000'}/portal/`;
    try {
        await sendClientEmail(c.email, subject, `${body}\n\n${loginUrl}`);
    } catch (e) {
        console.warn('[notify] email failed (non-fatal):', e.message);
    }
}

module.exports = router;
