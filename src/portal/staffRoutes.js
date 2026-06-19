// Staff auth routes, mounted at /staff. Only the /api/* endpoints live here;
// the page routes (/staff/login, /staff/console, /onboarding/review) are wired
// in server.js so they can use the requireStaffPage guard.

const express = require('express');
const router = express.Router();
const staffAuth = require('./staffAuth');
const { send, brandShell } = require('./mailer');

const isProd = process.env.NODE_ENV === 'production';
const COOKIE_OPTS = {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: staffAuth.SESSION_TTL_DAYS * 86400 * 1000,
    path: '/',
};

const safeNext = v => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//')) ? v : '/staff/console';

// POST /staff/api/login  { email, next? }  -> always 200 (no enumeration)
router.post('/api/login', async (req, res) => {
    try {
        const email = (req.body && req.body.email) || '';
        const next = safeNext(req.body && req.body.next);
        const raw = await staffAuth.issueStaffToken(email);
        if (raw) {
            const base = process.env.PORTAL_BASE_URL || 'http://localhost:3000';
            const link = `${base}/staff/api/verify?token=${encodeURIComponent(raw)}&next=${encodeURIComponent(next)}`;
            await send({
                to: email.trim().toLowerCase(),
                subject: 'Your Momentum Tax staff login link',
                html: brandShell(
                    `<p>Here is your secure staff login link:</p>
                     <p><a href="${link}" style="display:inline-block;background:#16314f;color:#fff;
                            padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:600">Log in to staff console &rarr;</a></p>
                     <p style="color:#5d6b7a;font-size:13px">This link expires in 15 minutes and can only be used once.
                        If you didn't request it, ignore this email.</p>`
                ),
                text: `Your staff login link (expires in 15 minutes, single use):\n\n${link}`,
            });
        }
        res.json({ ok: true, message: 'If that address is an authorised staff member, a login link is on its way.' });
    } catch (e) {
        console.error('[staff login] error:', e);
        res.json({ ok: true, message: 'If that address is an authorised staff member, a login link is on its way.' });
    }
});

// GET /staff/api/verify?token=...&next=... -> set cookie, redirect into the console
router.get('/api/verify', async (req, res) => {
    const result = await staffAuth.verifyStaffToken(req.query.token || '');
    if (!result) return res.redirect('/staff/login?error=invalid_or_expired');
    res.cookie('mt_staff', result.sessionId, COOKIE_OPTS);
    res.redirect(safeNext(req.query.next));
});

// POST /staff/api/logout
router.post('/api/logout', async (req, res) => {
    await staffAuth.destroyStaffSession(req.cookies && req.cookies.mt_staff);
    res.clearCookie('mt_staff', { path: '/' });
    res.json({ ok: true });
});

// GET /staff/api/me -> current staff identity, or 401
router.get('/api/me', staffAuth.requireStaffAuth, (req, res) => res.json({ staff: req.staff }));

module.exports = router;
