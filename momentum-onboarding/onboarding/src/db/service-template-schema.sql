-- Momentum Tax — Trafft service -> XPM job template mapping
-- Run AFTER schema.sql:  psql "$DATABASE_URL" -f src/db/service-template-schema.sql
--
-- Replaces the hand-maintained XPM_TEMPLATE_MAP env JSON. Provisioning resolves the
-- template name from here first, falling back to the env var only if no row exists.

CREATE TABLE IF NOT EXISTS service_template_map (
    id              BIGSERIAL PRIMARY KEY,
    service_name    TEXT NOT NULL UNIQUE,     -- the Trafft service name, as it arrives in the booking
    template_name   TEXT,                     -- the XPM job template Name to apply (null = no template)
    template_uuid   TEXT,                     -- optional: the XPM template UUID for reference
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT
);
