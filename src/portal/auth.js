// Passwordless (magic-link) auth for the client portal.
//
// Flow:
//   1. Client submits email -> we mint a random token, store ONLY its sha256 hash,
//      email the raw token as a link (15-min expiry, single use).
//   2. Client clicks link -> we hash the presented token, match an unused/unexpired
//      row, mark it used, create a session, set an httpOnly cookie.
//
// We never store passwords and never store the raw token.

const crypto = require('crypto');
const db = require('../db/pool');

const TOKEN_TTL_MIN = 15;
const SESSION_TTL_DAYS = 14;

function sha256(s) {
    return crypto.createHash('sha256').update(String(s)).digest('hex');
}
function randomToken() {
    return crypto.randomBytes(32).toString('base64url'); // URL-safe
}

// Issue a login token for an email. Returns the RAW token (to put in the link).
// Only issues for emails that exist as portal clients — but we don't reveal that
// to the caller (the route always responds the same to avoid email enumeration).
async function issueLoginToken(email) {
    const normalised = String(email || '').trim().toLowerCase();
    const { rows } = await db.query(
        'SELECT id FROM portal_clients WHERE lower(email) = $1 AND status = $2',
        [normalised, 'active']
    );
    if (!rows.length) return null; // caller still responds 200 generically

    const raw = randomToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MIN * 60 * 1000);
    await db.query(
        'INSERT INTO portal_login_tokens (email, token_hash, expires_at) VALUES ($1,$2,$3)',
        [normalised, sha256(raw), expiresAt]
    );
    return raw;
}

// Verify a raw token; on success create a session and return { sessionId, client }.
async function verifyLoginToken(rawToken) {
    const hash = sha256(rawToken);
    const { rows } = await db.query(
        `SELECT * FROM portal_login_tokens
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1`,
        [hash]
    );
    const tok = rows[0];
    if (!tok) return null;

    await db.query('UPDATE portal_login_tokens SET used_at = now() WHERE id = $1', [tok.id]);

    const client = (await db.query(
        'SELECT * FROM portal_clients WHERE lower(email) = $1', [tok.email]
    )).rows[0];
    if (!client) return null;

    await db.query('UPDATE portal_clients SET last_login_at = now() WHERE id = $1', [client.id]);

    const sessionId = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400 * 1000);
    await db.query(
        'INSERT INTO portal_sessions (id, client_id, expires_at) VALUES ($1,$2,$3)',
        [sessionId, client.id, expiresAt]
    );
    return { sessionId, client };
}

// Resolve a session id (from cookie) to a client, or null.
async function getClientBySession(sessionId) {
    if (!sessionId) return null;
    const { rows } = await db.query(
        `SELECT c.* FROM portal_sessions s
           JOIN portal_clients c ON c.id = s.client_id
          WHERE s.id = $1 AND s.expires_at > now() AND c.status = 'active'`,
        [sessionId]
    );
    return rows[0] || null;
}

async function destroySession(sessionId) {
    if (sessionId) await db.query('DELETE FROM portal_sessions WHERE id = $1', [sessionId]);
}

// Express middleware to require a logged-in client.
async function requireClient(req, res, next) {
    const sessionId = req.cookies && req.cookies.mt_session;
    const client = await getClientBySession(sessionId);
    if (!client) return res.status(401).json({ error: 'not_authenticated' });
    req.client = client;
    next();
}

module.exports = {
    issueLoginToken, verifyLoginToken, getClientBySession,
    destroySession, requireClient, SESSION_TTL_DAYS,
};
