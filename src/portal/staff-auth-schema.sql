-- Staff magic-link auth (mirrors the client portal auth tables).
-- Authorised staff are defined by the STAFF_EMAILS env allow-list, not a table,
-- so there is no staff "accounts" table — just tokens and sessions.

CREATE TABLE IF NOT EXISTS staff_login_tokens (
    id          BIGSERIAL PRIMARY KEY,
    email       TEXT NOT NULL,
    token_hash  TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_login_tokens_hash ON staff_login_tokens(token_hash);

CREATE TABLE IF NOT EXISTS staff_sessions (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_sessions_expires ON staff_sessions(expires_at);
