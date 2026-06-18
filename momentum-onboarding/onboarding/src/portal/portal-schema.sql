-- Momentum Tax — client portal schema
-- Run AFTER schema.sql:  psql "$DATABASE_URL" -f src/portal/portal-schema.sql

-- Portal clients. Linked to the XPM client created at onboarding where available.
CREATE TABLE IF NOT EXISTS portal_clients (
    id                  BIGSERIAL PRIMARY KEY,
    email               TEXT NOT NULL UNIQUE,
    full_name           TEXT,
    business_name       TEXT,
    entity_type         TEXT,
    xpm_client_uuid     TEXT,                 -- link back to XPM
    stripe_customer_id  TEXT,                 -- set on first checkout
    status              TEXT NOT NULL DEFAULT 'active', -- active | disabled
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_portal_clients_email ON portal_clients (lower(email));
CREATE INDEX IF NOT EXISTS idx_portal_clients_stripe ON portal_clients (stripe_customer_id);

-- Magic-link login tokens. Single-use, short-lived. We store only a HASH of the token.
CREATE TABLE IF NOT EXISTS portal_login_tokens (
    id              BIGSERIAL PRIMARY KEY,
    email           TEXT NOT NULL,
    token_hash      TEXT NOT NULL,            -- sha256 of the raw token
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_hash ON portal_login_tokens (token_hash);

-- Active sessions (httpOnly cookie carries the session id).
CREATE TABLE IF NOT EXISTS portal_sessions (
    id              TEXT PRIMARY KEY,         -- random session id
    client_id       BIGINT NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_client ON portal_sessions (client_id);

-- Membership tiers (editable — rename / reprice freely).
CREATE TABLE IF NOT EXISTS membership_tiers (
    id              BIGSERIAL PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,     -- bronze | silver | gold
    name            TEXT NOT NULL,
    tagline         TEXT,
    price_monthly   NUMERIC(10,2) NOT NULL,   -- AUD ex-GST display value
    stripe_price_id TEXT,                     -- Stripe recurring price id (set per env)
    features        JSONB NOT NULL DEFAULT '[]',
    is_popular      BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order      INT NOT NULL DEFAULT 0,
    active          BOOLEAN NOT NULL DEFAULT TRUE
);

-- A client's current subscription, kept in sync from Stripe webhooks.
CREATE TABLE IF NOT EXISTS portal_subscriptions (
    id                      BIGSERIAL PRIMARY KEY,
    client_id               BIGINT NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
    tier_code               TEXT,
    stripe_subscription_id  TEXT UNIQUE,
    stripe_customer_id      TEXT,
    status                  TEXT,             -- active | trialing | past_due | canceled | incomplete
    current_period_end      TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subs_client ON portal_subscriptions (client_id);

-- FAQs (grouped, ordered, can be tier-gated).
CREATE TABLE IF NOT EXISTS portal_faqs (
    id              BIGSERIAL PRIMARY KEY,
    category        TEXT NOT NULL DEFAULT 'General',
    question        TEXT NOT NULL,
    answer          TEXT NOT NULL,            -- markdown allowed
    min_tier        TEXT,                     -- null = visible to all; else bronze/silver/gold
    sort_order      INT NOT NULL DEFAULT 0,
    active          BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---- seed data (edit to taste) ---------------------------------------------

INSERT INTO membership_tiers (code, name, tagline, price_monthly, features, is_popular, sort_order)
VALUES
 ('bronze','Bronze','Compliance, handled', 500.00,
   '["Annual tax return & financials","BAS/IAS lodgement","Xero file review","Email support (2 business days)","Annual tax-planning checklist"]',
   FALSE, 1),
 ('silver','Silver','Compliance + quarterly advisory', 1200.00,
   '["Everything in Bronze","Quarterly strategy & cashflow review","90-day action plan","Priority support (1 business day)","Unlimited phone/email queries","Annual structure & Div 7A check"]',
   TRUE, 2),
 ('gold','Gold','Embedded advisory partner', 2500.00,
   '["Everything in Silver","Monthly management reporting","Virtual CFO sessions","Budget & forecast modelling","Tax-effective structuring & planning","Same-day priority support"]',
   FALSE, 3)
ON CONFLICT (code) DO NOTHING;

INSERT INTO portal_faqs (category, question, answer, sort_order) VALUES
 ('Getting started','How do I log in to the portal?','Enter your email on the login page. We''ll email you a secure one-time link — click it and you''re in. No password to remember.',1),
 ('Getting started','How do I book an appointment?','Use the Book Now button on our website. Once booked, we set up your job and you''ll see it reflected here.',2),
 ('Tax & lodgement','When is my tax return due?','For most individuals, 31 October if self-lodging, or later if lodged through us as your registered tax agent. We''ll confirm your specific deadline.',1),
 ('Tax & lodgement','What records do I need to provide?','Income statements, deduction receipts, and any investment or business records. We''ll send a tailored checklist based on your situation.',2),
 ('Billing & membership','How does membership billing work?','Memberships are billed monthly in advance. You can view invoices and manage your plan from the Membership section of the portal.',1),
 ('Billing & membership','Can I change tiers later?','Yes — upgrade or downgrade anytime from the Membership section. Changes apply from your next billing cycle.',2)
ON CONFLICT DO NOTHING;
