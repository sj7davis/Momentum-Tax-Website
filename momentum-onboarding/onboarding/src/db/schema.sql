-- Momentum Tax — onboarding staging schema
-- Run: psql "$DATABASE_URL" -f src/db/schema.sql

CREATE TABLE IF NOT EXISTS onboarding_requests (
    id                  BIGSERIAL PRIMARY KEY,
    -- raw + parsed
    trafft_appointment_id   TEXT,
    raw_payload             JSONB        NOT NULL,
    -- parsed client fields
    first_name          TEXT,
    last_name           TEXT,
    email               TEXT,
    phone               TEXT,
    entity_type         TEXT,            -- Individual / Company / Trust / Partnership / SMSF
    business_name       TEXT,
    abn                 TEXT,
    service_name        TEXT,            -- the Trafft service booked
    intake              JSONB,           -- all custom fields, normalised
    appointment_at      TIMESTAMPTZ,
    -- workflow
    status              TEXT NOT NULL DEFAULT 'pending_review',
        -- pending_review | duplicate | id_pending | approved | provisioned | rejected | error
    id_verified         BOOLEAN NOT NULL DEFAULT FALSE,
    dedup_match_uuid    TEXT,            -- XPM client UUID if a likely duplicate was found
    dedup_match_name    TEXT,            -- that client's name, for the reviewer
    dedup_level         TEXT NOT NULL DEFAULT 'none',  -- none | possible | strong | exact
    dedup_reasons       JSONB NOT NULL DEFAULT '[]',   -- why it matched (for the reviewer)
    link_existing       BOOLEAN NOT NULL DEFAULT FALSE, -- reviewer chose to link, not create
    review_note         TEXT,
    -- results after provisioning
    xpm_client_uuid     TEXT,
    xpm_job_number      TEXT,
    error_detail        TEXT,
    -- audit
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at         TIMESTAMPTZ,
    reviewed_by         TEXT,
    provisioned_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_onboarding_status ON onboarding_requests (status);
CREATE INDEX IF NOT EXISTS idx_onboarding_email  ON onboarding_requests (lower(email));

-- Idempotent column adds for installs created before these columns existed.
ALTER TABLE onboarding_requests ADD COLUMN IF NOT EXISTS dedup_level   TEXT NOT NULL DEFAULT 'none';
ALTER TABLE onboarding_requests ADD COLUMN IF NOT EXISTS dedup_match_name TEXT;
ALTER TABLE onboarding_requests ADD COLUMN IF NOT EXISTS dedup_reasons JSONB NOT NULL DEFAULT '[]';
ALTER TABLE onboarding_requests ADD COLUMN IF NOT EXISTS link_existing BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_onboarding_appt
    ON onboarding_requests (trafft_appointment_id)
    WHERE trafft_appointment_id IS NOT NULL;

-- Single-row token store for the XPM connection (refresh token rotates on each use)
CREATE TABLE IF NOT EXISTS xpm_oauth (
    id              INT PRIMARY KEY DEFAULT 1,
    access_token    TEXT,
    refresh_token   TEXT,
    expires_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT singleton CHECK (id = 1)
);
