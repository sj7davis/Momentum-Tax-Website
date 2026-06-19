// Standalone runner. To mount into your existing tools.momentumtax.com.au app instead,
// import the routers (see README) — but mind the Stripe raw-body ordering note below.

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const trafftWebhook = require('./src/routes/trafftWebhook');
const reviewQueue = require('./src/routes/reviewQueue');
const portalRoutes = require('./src/portal/portalRoutes');
const clientDocsRoutes = require('./src/portal/clientDocsRoutes');
const staffDocsRoutes = require('./src/portal/staffDocsRoutes');
const staffRoutes = require('./src/portal/staffRoutes');
const { requireStaffAuth, requireStaffPage } = require('./src/portal/staffAuth');

const app = express();

// IMPORTANT: the Stripe webhook must receive the RAW body for signature verification,
// so it is registered with express.raw() BEFORE the global express.json() parser.
// We mount the portal router here too so its /api/stripe-webhook handler sees raw bytes.
app.use('/portal/api/stripe-webhook', express.raw({ type: 'application/json' }));

// Global parsers for everything else.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Onboarding (Trafft -> review queue -> XPM)
app.use('/api/onboarding', trafftWebhook);
app.use('/api/onboarding', reviewQueue);

// ---- Public marketing site (served at /) ----
// Serve the whole site folder at root so the homepage's relative ./img/... asset
// paths resolve correctly. index.html is served automatically for GET /.
app.use('/', express.static(path.join(__dirname, 'src/public/site')));
// Keep /site/* working too (used by og:image / schema absolute URLs).
app.use('/site', express.static(path.join(__dirname, 'src/public/site')));

// Client portal API + pages
app.use('/portal', portalRoutes);
app.use('/portal/api', clientDocsRoutes);              // documents + forms (client, auth-gated)
// Serve the portal SPA + its assets. Scoped so only intended files are exposed.
app.get('/portal', (_req, res) =>
    res.sendFile(path.join(__dirname, 'src/public/portal.html')));
app.get('/portal/', (_req, res) =>
    res.sendFile(path.join(__dirname, 'src/public/portal.html')));

// ---- Staff auth + admin (all behind staff magic-link login) ----
app.use('/staff', staffRoutes);                         // /staff/api/login, /verify, /logout, /me
app.use('/api/portal-admin', requireStaffAuth, staffDocsRoutes);  // share/request docs, send forms, reminders

// Staff login page (public)
app.get('/staff/login', (_req, res) =>
    res.sendFile(path.join(__dirname, 'src/public/staff-login.html')));

// Staff onboarding review UI — staff only
app.get('/onboarding/review', requireStaffPage, (_req, res) =>
    res.sendFile(path.join(__dirname, 'src/public/review-queue.html')));

// Staff console (documents, forms, follow-ups) — staff only
app.get('/staff/console', requireStaffPage, (_req, res) =>
    res.sendFile(path.join(__dirname, 'src/public/staff-console.html')));

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Momentum portal + onboarding listening on :${PORT}`));
