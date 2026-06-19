// Passwordless (magic-link) auth for STAFF — mirrors the client portal auth.js.
//
// Authorised staff are an allow-list in the STAFF_EMAILS env var
// (comma-separated, e.g. "scott.davis@momentumtax.com.au,admin@momentumtax.com.au").
// Only those addresses can be issued a login link, and the allow-list is re-checked
// on every token verify and session lookup, so removing an email revokes access.

const crypto = require('crypto');
const db = require('../db/pool');

const TOKEN_TTL_MIN = 15;
const SESSION_TTL_DAYS = 7;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

function staffEmails() {
    return (process.env.STAFF_EMAILS || '')
        .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}
function isStaffEmail(email) {
    return staffEmails().includes(String(email || '').trim().toLowerCase());
}

// Issue a login token for a staff email. Returns the RAW token, or null if the
// address isn't on the allow-list (caller still responds generically).
async function issueStaffToken(email) {
    const normalised = String(email || '').trim().toLowerCase();
    if (!isStaffEmail(normalised)) return null;
    const raw = randomToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MIN * 60 * 1000);
    await db.query(
        'INSERT INTO staff_login_tokens (email, token_hash, expires_at) VALUES ($1,$2,$3)',
        [normalised, sha256(raw), expiresAt]
    );
    return raw;
}

// Verify a raw token; on success create a session and return { sessionId, email }.
async function verifyStaffToken(rawToken) {
    const { rows } = await db.query(
        `SELECT * FROM staff_login_tokens
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1`,
        [sha256(rawToken)]
    );
    const tok = rows[0];
    if (!tok || !isStaffEmail(tok.email)) return null;

    await db.query('UPDATE staff_login_tokens SET used_at = now() WHERE id = $1', [tok.id]);

    const sessionId = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400 * 1000);
    await db.query(
        'INSERT INTO staff_sessions (id, email, expires_at) VALUES ($1,$2,$3)',
        [sessionId, tok.email, expiresAt]
    );
    return { sessionId, email: tok.email };
}

async function getStaffBySession(sessionId) {
    if (!sessionId) return null;
    const { rows } = await db.query(
        'SELECT email FROM staff_sessions WHERE id = $1 AND expires_at > now()', [sessionId]
    );
    const s = rows[0];
    if (!s || !isStaffEmail(s.email)) return null; // revoked if removed from allow-list
    return { email: s.email };
}

async function destroyStaffSession(sessionId) {
    if (sessionId) await db.query('DELETE FROM staff_sessions WHERE id = $1', [sessionId]);
}

// API guard — JSON 401 when not authenticated.
async function requireStaffAuth(req, res, next) {
    const staff = await getStaffBySession(req.cookies && req.cookies.mt_staff);
    if (!staff) return res.status(401).json({ error: 'staff_auth_required' });
    req.staff = staff;
    next();
}

// Page guard — redirect to the staff login page (preserving where they were headed).
async function requireStaffPage(req, res, next) {
    const staff = await getStaffBySession(req.cookies && req.cookies.mt_staff);
    if (!staff) return res.redirect('/staff/login?next=' + encodeURIComponent(req.originalUrl));
    req.staff = staff;
    next();
}

module.exports = {
    issueStaffToken, verifyStaffToken, getStaffBySession, destroyStaffSession,
    requireStaffAuth, requireStaffPage, isStaffEmail, SESSION_TTL_DAYS,
};
