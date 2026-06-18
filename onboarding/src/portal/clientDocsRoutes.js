// Client-facing document exchange + forms (all require a logged-in client).
const express = require('express');
const router = express.Router();
const db = require('../db/pool');
const auth = require('./auth');
const storage = require('./storage');

router.use(auth.requireClient); // every route here needs an authenticated client

// ----- DOCUMENTS -----

// GET /portal/api/docs  -> the client's documents (both directions)
router.get('/docs', async (req, res) => {
    const { rows } = await db.query(
        `SELECT id, filename, content_type, size_bytes, direction, category,
                xpm_job_number, note, created_at
           FROM portal_documents
          WHERE client_id = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC`,
        [req.client.id]
    );
    res.json({ documents: rows });
});

// GET /portal/api/doc-requests -> outstanding upload requests for this client
router.get('/doc-requests', async (req, res) => {
    const { rows } = await db.query(
        `SELECT id, title, description, due_date, status, created_at
           FROM portal_document_requests
          WHERE client_id = $1 AND status = 'open'
          ORDER BY created_at DESC`,
        [req.client.id]
    );
    res.json({ requests: rows });
});

// POST /portal/api/docs/presign  { filename, contentType, sizeBytes, requestId? }
// Step 1 of upload: validate + return a presigned PUT URL and the storage key.
router.post('/docs/presign', async (req, res) => {
    const { filename, contentType, sizeBytes } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const check = storage.validateUpload({ contentType, sizeBytes });
    if (!check.ok) return res.status(400).json({ error: check.reason });

    const key = storage.buildKey(req.client.id, filename);
    try {
        const url = await storage.presignUpload(key, contentType);
        res.json({ uploadUrl: url, storageKey: key });
    } catch (e) {
        console.error('[docs presign] error:', e);
        res.status(500).json({ error: 'could not presign upload' });
    }
});

// POST /portal/api/docs/confirm  { storageKey, filename, contentType, sizeBytes, requestId? }
// Step 2: after the browser PUTs to storage, record the metadata.
router.post('/docs/confirm', async (req, res) => {
    const { storageKey, filename, contentType, sizeBytes, requestId } = req.body || {};
    if (!storageKey || !filename) return res.status(400).json({ error: 'missing fields' });
    // Ensure the key belongs to this client's namespace (defence in depth).
    if (!storageKey.startsWith(`clients/${req.client.id}/`)) {
        return res.status(403).json({ error: 'key does not belong to client' });
    }
    const { rows } = await db.query(
        `INSERT INTO portal_documents
            (client_id, storage_key, filename, content_type, size_bytes, direction,
             uploaded_by, request_id)
         VALUES ($1,$2,$3,$4,$5,'from_client','client',$6)
         RETURNING id`,
        [req.client.id, storageKey, filename, contentType || null, sizeBytes || null,
         requestId || null]
    );
    // If this fulfils a request, mark it fulfilled.
    if (requestId) {
        await db.query(
            `UPDATE portal_document_requests
                SET status='fulfilled', fulfilled_at=now()
              WHERE id=$1 AND client_id=$2`,
            [requestId, req.client.id]
        );
    }
    res.json({ ok: true, id: rows[0].id });
});

// GET /portal/api/docs/:id/download -> presigned download URL (must own the doc)
router.get('/docs/:id/download', async (req, res) => {
    const { rows } = await db.query(
        `SELECT storage_key, filename FROM portal_documents
          WHERE id=$1 AND client_id=$2 AND deleted_at IS NULL`,
        [req.params.id, req.client.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    try {
        const url = await storage.presignDownload(rows[0].storage_key, rows[0].filename);
        res.json({ url });
    } catch (e) {
        console.error('[docs download] error:', e);
        res.status(500).json({ error: 'could not presign download' });
    }
});

// ----- FORMS -----

// GET /portal/api/forms -> forms assigned to this client (with template fields)
router.get('/forms', async (req, res) => {
    const { rows } = await db.query(
        `SELECT a.id, a.title, a.status, a.due_date, a.created_at,
                t.fields, r.answers
           FROM form_assignments a
           JOIN form_templates t ON t.id = a.template_id
           LEFT JOIN form_responses r ON r.assignment_id = a.id
          WHERE a.client_id = $1
          ORDER BY (a.status='submitted'), a.created_at DESC`,
        [req.client.id]
    );
    res.json({ forms: rows });
});

// POST /portal/api/forms/:id/save  { answers, submit? }
// Save progress (submit=false) or submit the form (submit=true).
router.post('/forms/:id/save', async (req, res) => {
    const { answers, submit } = req.body || {};
    // Ownership check
    const a = (await db.query(
        'SELECT * FROM form_assignments WHERE id=$1 AND client_id=$2',
        [req.params.id, req.client.id]
    )).rows[0];
    if (!a) return res.status(404).json({ error: 'not found' });
    if (a.status === 'submitted' || a.status === 'reviewed') {
        return res.status(409).json({ error: 'already submitted' });
    }

    await db.query(
        `INSERT INTO form_responses (assignment_id, answers, saved_at)
         VALUES ($1,$2, now())
         ON CONFLICT (assignment_id) DO UPDATE SET answers=$2, saved_at=now()`,
        [a.id, JSON.stringify(answers || {})]
    );
    const newStatus = submit ? 'submitted' : 'in_progress';
    await db.query(
        `UPDATE form_assignments
            SET status=$1, submitted_at=$2
          WHERE id=$3`,
        [newStatus, submit ? new Date() : null, a.id]
    );
    res.json({ ok: true, status: newStatus });
});

module.exports = router;
