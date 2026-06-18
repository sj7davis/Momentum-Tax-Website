const express = require('express');
const router = express.Router();
const db = require('../db/pool');
const auth = require('./auth');
const { sendMagicLink } = require('./email');
const stripeSvc = require('./stripe');

const isProd = process.env.NODE_ENV === 'production';
const COOKIE_OPTS = {
    httpOnly: true,
    secure: isProd,            // requires HTTPS in production
    sameSite: 'lax',
    maxAge: auth.SESSION_TTL_DAYS * 86400 * 1000,
    path: '/',
};

// ---- AUTH -------------------------------------------------------------------

// POST /portal/api/login  { email }   -> always 200 (no email enumeration)
router.post('/api/login', async (req, res) => {
    try {
        const email = (req.body && req.body.email) || '';
        const raw = await auth.issueLoginToken(email);
        if (raw) {
            const link = `${process.env.PORTAL_BASE_URL || 'http://localhost:3000'}` +
                         `/portal/api/verify?token=${encodeURIComponent(raw)}`;
            await sendMagicLink(email.trim().toLowerCase(), link);
        }
        res.json({ ok: true, message: 'If that email is registered, a login link is on its way.' });
    } catch (e) {
        console.error('[portal login] error:', e);
        res.json({ ok: true, message: 'If that email is registered, a login link is on its way.' });
    }
});

// GET /portal/api/verify?token=...  -> sets cookie, redirects into portal
router.get('/api/verify', async (req, res) => {
    const result = await auth.verifyLoginToken(req.query.token || '');
    if (!result) {
        return res.redirect('/portal/?error=invalid_or_expired');
    }
    res.cookie('mt_session', result.sessionId, COOKIE_OPTS);
    res.redirect('/portal/?welcome=1');
});

// POST /portal/api/logout
router.post('/api/logout', async (req, res) => {
    await auth.destroySession(req.cookies && req.cookies.mt_session);
    res.clearCookie('mt_session', { path: '/' });
    res.json({ ok: true });
});

// GET /portal/api/me  -> current client + subscription, or 401
router.get('/api/me', auth.requireClient, async (req, res) => {
    const sub = await stripeSvc.currentSubscription(req.client.id);
    res.json({
        client: {
            id: req.client.id,
            email: req.client.email,
            full_name: req.client.full_name,
            business_name: req.client.business_name,
            entity_type: req.client.entity_type,
        },
        subscription: sub,
    });
});

// ---- FAQs (tier-aware) ------------------------------------------------------

const TIER_RANK = { bronze: 1, silver: 2, gold: 3 };

// GET /portal/api/faqs  -> visible FAQs (gated by the client's tier if logged in)
router.get('/api/faqs', async (req, res) => {
    // Determine viewer tier (if authenticated)
    let viewerRank = 0;
    const client = await auth.getClientBySession(req.cookies && req.cookies.mt_session);
    if (client) {
        const sub = await stripeSvc.currentSubscription(client.id);
        if (sub && ['active', 'trialing'].includes(sub.status) && sub.tier_code) {
            viewerRank = TIER_RANK[sub.tier_code] || 0;
        }
    }
    const { rows } = await db.query(
        'SELECT category, question, answer, min_tier, sort_order FROM portal_faqs WHERE active = TRUE ORDER BY category, sort_order'
    );
    const visible = rows.filter(f => !f.min_tier || (TIER_RANK[f.min_tier] || 99) <= viewerRank);
    // group by category
    const grouped = {};
    for (const f of visible) {
        (grouped[f.category] = grouped[f.category] || []).push({ question: f.question, answer: f.answer });
    }
    res.json({ categories: grouped });
});

// ---- MEMBERSHIP TIERS -------------------------------------------------------

// GET /portal/api/tiers  -> public tier list for the pricing display
router.get('/api/tiers', async (_req, res) => {
    const { rows } = await db.query(
        `SELECT code, name, tagline, price_monthly, features, is_popular
           FROM membership_tiers WHERE active = TRUE ORDER BY sort_order`
    );
    res.json({ tiers: rows });
});

// POST /portal/api/checkout  { tier }  -> returns Stripe Checkout URL (auth required)
router.post('/api/checkout', auth.requireClient, async (req, res) => {
    try {
        const url = await stripeSvc.createCheckoutSession(req.client, req.body.tier);
        res.json({ url });
    } catch (e) {
        console.error('[checkout] error:', e);
        res.status(400).json({ error: e.message });
    }
});

// POST /portal/api/billing-portal  -> returns Stripe Customer Portal URL (auth required)
router.post('/api/billing-portal', auth.requireClient, async (req, res) => {
    try {
        const url = await stripeSvc.createBillingPortalSession(req.client);
        res.json({ url });
    } catch (e) {
        console.error('[billing-portal] error:', e);
        res.status(400).json({ error: e.message });
    }
});

// ---- STRIPE WEBHOOK ---------------------------------------------------------
// IMPORTANT: this route needs the RAW body for signature verification. It is mounted
// with express.raw() in server.js BEFORE the JSON body parser. See server.js.
router.post('/api/stripe-webhook', async (req, res) => {
    let event;
    try {
        event = stripeSvc.constructEvent(req.body, req.get('stripe-signature'));
    } catch (e) {
        console.error('[stripe webhook] signature verification failed:', e.message);
        return res.status(400).send(`Webhook Error: ${e.message}`);
    }
    try {
        await stripeSvc.handleEvent(event);
        res.json({ received: true });
    } catch (e) {
        console.error('[stripe webhook] handler error:', e);
        res.status(500).json({ error: 'handler_failed' });
    }
});

module.exports = router;
