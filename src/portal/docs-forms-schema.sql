-- Momentum Tax — document exchange + templated forms
-- Run AFTER portal-schema.sql:
--   psql "$DATABASE_URL" -f src/portal/docs-forms-schema.sql

-- ============================ DOCUMENTS ====================================

-- Every file is stored in S3-compatible object storage; we keep only metadata +
-- the storage key here. Files are never served from disk.
CREATE TABLE IF NOT EXISTS portal_documents (
    id              BIGSERIAL PRIMARY KEY,
    client_id       BIGINT NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
    storage_key     TEXT NOT NULL,            -- object key in the bucket
    filename        TEXT NOT NULL,            -- original filename for display
    content_type    TEXT,
    size_bytes      BIGINT,
    direction       TEXT NOT NULL,            -- 'to_client' (we shared) | 'from_client' (they uploaded)
    category        TEXT DEFAULT 'General',   -- Tax Return, Financials, Signed, ID, etc.
    uploaded_by     TEXT NOT NULL,            -- 'client' | 'staff'
    xpm_job_number  TEXT,                     -- optional link to the XPM job
    request_id      BIGINT,                   -- set if this fulfils a document request
    note            TEXT,
    virus_scanned   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ               -- soft delete (we never hard-delete client docs)
);
CREATE INDEX IF NOT EXISTS idx_docs_client ON portal_documents (client_id) WHERE deleted_at IS NULL;

-- A staff request for the client to upload something ("please send your 2025 logbook").
CREATE TABLE IF NOT EXISTS portal_document_requests (
    id              BIGSERIAL PRIMARY KEY,
    client_id       BIGINT NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    description     TEXT,
    xpm_job_number  TEXT,
    status          TEXT NOT NULL DEFAULT 'open', -- open | fulfilled | cancelled
    due_date        DATE,
    created_by      TEXT NOT NULL DEFAULT 'staff',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    fulfilled_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_docreq_client ON portal_document_requests (client_id);

-- ============================ FORMS ========================================

-- A reusable form template (e.g. "Annual Tax Checklist", "New Employee Details").
-- Fields are a JSON schema: [{key,label,type,required,options?,help?}]
CREATE TABLE IF NOT EXISTS form_templates (
    id              BIGSERIAL PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    description     TEXT,
    fields          JSONB NOT NULL DEFAULT '[]',
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A form sent to a specific client (a "form request" / assignment).
CREATE TABLE IF NOT EXISTS form_assignments (
    id              BIGSERIAL PRIMARY KEY,
    template_id     BIGINT NOT NULL REFERENCES form_templates(id),
    client_id       BIGINT NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,            -- snapshot of template name at send time
    xpm_job_number  TEXT,
    status          TEXT NOT NULL DEFAULT 'sent', -- sent | in_progress | submitted | reviewed
    due_date        DATE,
    sent_by         TEXT NOT NULL DEFAULT 'staff',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_at    TIMESTAMPTZ,
    reminder_count  INT NOT NULL DEFAULT 0,
    last_reminder_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_formassign_client ON form_assignments (client_id);
CREATE INDEX IF NOT EXISTS idx_formassign_status ON form_assignments (status);

-- The client's submitted answers for an assignment.
CREATE TABLE IF NOT EXISTS form_responses (
    id              BIGSERIAL PRIMARY KEY,
    assignment_id   BIGINT NOT NULL REFERENCES form_assignments(id) ON DELETE CASCADE,
    answers         JSONB NOT NULL DEFAULT '{}',
    saved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (assignment_id)
);

-- ============================ SEED FORM TEMPLATES ==========================

INSERT INTO form_templates (code, name, description, fields) VALUES
 ('annual_tax_checklist','Annual Individual Tax Checklist',
  'Confirms the information we need to prepare your individual tax return.',
  '[
    {"key":"had_other_income","label":"Did you have income besides your main salary?","type":"boolean","required":true},
    {"key":"other_income_detail","label":"If yes, briefly describe","type":"textarea","required":false,"help":"e.g. interest, dividends, rental, side business"},
    {"key":"work_from_home","label":"Did you work from home this year?","type":"boolean","required":true},
    {"key":"wfh_hours","label":"Approx hours worked from home","type":"number","required":false},
    {"key":"vehicle_for_work","label":"Did you use your own car for work (not commuting)?","type":"boolean","required":true},
    {"key":"private_health","label":"Did you have private health insurance?","type":"boolean","required":true},
    {"key":"deductions_summary","label":"List any work-related expenses you want to claim","type":"textarea","required":false}
  ]'),
 ('new_business_details','New Business / Entity Details',
  'Collects the details we need to set up and advise a new entity.',
  '[
    {"key":"entity_name","label":"Proposed entity / business name","type":"text","required":true},
    {"key":"structure","label":"Preferred structure","type":"select","required":true,"options":["Not sure","Sole Trader","Company","Trust","Partnership"]},
    {"key":"industry","label":"Industry / what the business does","type":"text","required":true},
    {"key":"expected_turnover","label":"Expected first-year turnover (AUD)","type":"number","required":false},
    {"key":"gst_register","label":"Do you expect turnover above $75,000 (GST threshold)?","type":"boolean","required":true},
    {"key":"employees","label":"Will you have employees in year one?","type":"boolean","required":true}
  ]')
ON CONFLICT (code) DO NOTHING;
