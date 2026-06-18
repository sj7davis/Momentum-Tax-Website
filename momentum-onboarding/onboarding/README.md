# Momentum Tax — Booking → Onboarding → XPM Module

Drop-in Node/Express module for `tools.momentumtax.com.au`.

Flow: **Trafft booking → webhook → dedup check → Postgres staging (pending_review) → you approve in portal → XPM client + job + template.**

## What's in this app (route map)

| Path | What |
|---|---|
| `/` | Public marketing site (rebuilt clean from the live site, real text + brand) |
| `/portal/` | Client portal — passwordless login, documents, forms, membership, FAQs |
| `/onboarding/review` | Staff: onboarding review queue + Service→XPM template mapping |
| `/staff/console` | Staff: share/request documents, send forms, follow-up reminders |
| `/health` | Health check (Railway) |

## Deploying to Railway (one app, one deploy)

The whole thing — marketing site, portal, onboarding, staff tools — runs as a single
Express app. To host on Railway:

1. **Push to a Git repo** (GitHub). `.gitignore` already excludes `node_modules` and `.env`.
2. **New Railway project → Deploy from repo.** Nixpacks auto-detects Node; `railway.json`
   sets the start command (`node server.js`) and health check (`/health`).
3. **Add a PostgreSQL plugin** in Railway — it injects `DATABASE_URL` automatically.
4. **Add a Storage Bucket** (for the document exchange) — set the `S3_*` vars from its
   credentials.
5. **Set the env variables** from `.env.example` in the service's Variables tab.
6. **Run migrations once:** from the Railway shell (or locally pointed at the DB),
   `npm run migrate`.
7. **Point your domain:** add `momentumtax.com.au` as a custom domain on the Railway
   service. Because the site is now Express, the apex domain serves the marketing site and
   `/portal` serves the client portal — no subdomain juggling.

> Moving off WordPress: once the Railway domain is live and verified, switch the DNS for
> `momentumtax.com.au` to Railway. Keep the WordPress site up until you've confirmed the
> new one renders, then cut over. `bookings.` and `myform.` subdomains are untouched.

## Local dev

```bash
npm install
cp .env.example .env       # fill in what you have; blanks fall back to dev behaviour
npm run migrate            # needs a reachable Postgres in DATABASE_URL
npm start                  # http://localhost:3000
```

---

## Why a review queue (not auto-create)

A completed booking does **not** create anything in Xero Practice Manager. It lands in a
staging table with status `pending_review`. You (or staff) approve it from the portal.
On approval the module creates the XPM client, opens the job, and applies the service
template. This keeps XPM clean (no junk clients from no-shows / tyre-kickers) and gives
you the natural place to run the **Tranche 2 AML/CTF identity-verification gate** before
anything is provisioned.

## Pieces

| File | Role |
|---|---|
| `src/routes/trafftWebhook.js` | Receives Trafft "Appointment Booked" POST, verifies token, stages it |
| `src/routes/reviewQueue.js`   | List / approve / reject endpoints for the portal |
| `src/services/xpm.js`         | XPM API client: OAuth2 token mgmt, client/search, client/add, job/add, applytemplate |
| `src/services/trafft.js`      | Parse Trafft payload + custom fields into a normalised client record |
| `src/db/schema.sql`           | Postgres staging + token tables |
| `src/db/pool.js`              | pg pool |
| `src/middleware/verifyToken.js` | Trafft verification-token check |
| `src/public/review-queue.html`  | Portal review UI (navy/teal brand) |
| `server.js`                   | Standalone runner (or mount the routers into your existing app) |

## Mounting into your existing app

```js
const trafftWebhook = require('./onboarding/src/routes/trafftWebhook');
const reviewQueue    = require('./onboarding/src/routes/reviewQueue');
app.use('/api/onboarding', trafftWebhook);   // POST /api/onboarding/trafft
app.use('/api/onboarding', reviewQueue);     // GET/POST /api/onboarding/queue...
```

## Environment variables

```
DATABASE_URL=postgres://...
TRAFFT_WEBHOOK_TOKEN=<verification token from Trafft webhook setup>

# Xero Practice Manager (partner app — see note below)
XPM_CLIENT_ID=...
XPM_CLIENT_SECRET=...
XPM_REFRESH_TOKEN=...          # obtained via OAuth2 consent, then rotated
XPM_TENANT_ID=...              # the connected XPM org tenant id
XPM_DEFAULT_STAFF_UUID=...     # who jobs get assigned to (you)

# Map Trafft service name -> XPM job template name (JSON)
XPM_TEMPLATE_MAP={"Individual Tax Return":"ITR Standard","Company Setup":"Co Setup"}
```

## ⚠️ Before this works: XPM partner access

The XPM API is **gated**. You must register as a Xero **app partner** and complete the
**security self-assessment questionnaire** (email api@support.xero.com to start) before
Xero will grant the `practicemanager` scope. Start this early — it's the long pole, not
the code. Base URL: `https://api.xero.com/practicemanager/3.0/`. OAuth 2.0 only.

## One-time OAuth2 connection (bootstrap-oauth.js)

Once your XPM app is approved, connect it **once** to mint the first refresh token. After
this, the main app refreshes tokens automatically — you never repeat this unless the
connection is revoked or sits idle past Xero's 60-day refresh-token limit.

**Prerequisites**
1. Create an OAuth2 app at https://developer.xero.com, grant type **"Auth Code"** (this
   gives you a Client ID **and** a Client Secret).
2. Add redirect URI **exactly**: `http://localhost:5055/callback`
3. In Xero Practice Manager, open **your own Staff profile**, scroll to the very bottom of
   page 2, and toggle ON **"Connect third-party add-ons"**. (Easy to miss — the connection
   silently won't work without it.)

**Run it**
```bash
XPM_CLIENT_ID=... XPM_CLIENT_SECRET=... DATABASE_URL=... node bootstrap-oauth.js
# open http://localhost:5055/ , click connect, choose your Practice Manager org
```
On success it stores the tokens in `xpm_oauth` and prints your `XPM_TENANT_ID` — copy that
into your environment.

**Note on per-user tokens:** Xero issues access tokens per *user*, tied to whoever runs
this consent flow. For a solo provisioning setup that's fine; just be aware the connection
runs under your login. Scopes requested: `openid profile email practicemanager offline_access`
(`offline_access` is what makes the refresh token possible).

**Health check:** `GET /api/onboarding/xpm-status` confirms the connection is alive without
touching client data. If a refresh ever returns `invalid_grant`, just re-run the bootstrap.

## Setup

```bash
npm install
psql "$DATABASE_URL" -f src/db/schema.sql
node server.js
```

## Trafft side

1. Features & Integrations → enable **Webhooks** (premium feature).
2. Create an **Appointment Booked** webhook → URL `https://tools.momentumtax.com.au/api/onboarding/trafft`.
3. Copy the **Verification Token** → set `TRAFFT_WEBHOOK_TOKEN`.
4. Add intake **Custom Fields** (entity type, ABN, service, etc.) so they ride in the payload.

---

# Client Portal (passwordless login · FAQs · membership tiers)

A logged-in client portal at `/portal`. Magic-link auth (no passwords stored), tier-aware
FAQs, and Gold/Silver/Bronze memberships billed through Stripe.

## Why magic-link (passwordless)

No password database to breach, no reset flows, no per-seat auth cost. The client enters
their email, gets a signed one-time link (15-min expiry, single-use), and a 14-day httpOnly
session cookie is set. Tokens are stored only as SHA-256 hashes; the raw token never hits
the database. Tested paths: no email enumeration, single-use enforcement, expiry rejection,
clean logout.

## Why Stripe Checkout + Customer Portal

Card entry is hosted by Stripe (Checkout in `subscription` mode) so **card data never
touches the server** — that keeps you out of PCI scope. The DB is kept in sync from
**webhooks** (`checkout.session.completed`, `customer.subscription.*`), and clients
self-manage (upgrade/downgrade/cancel/card update) via the **Stripe Customer Portal**.

> Keys live in env only — never hardcoded. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.

## Portal environment variables

```
PORTAL_BASE_URL=https://tools.momentumtax.com.au   # used in magic links + Stripe redirects
EMAIL_WEBHOOK_URL=                                  # POST target for sending email; blank = log to console (dev)
STRIPE_SECRET_KEY=sk_live_or_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_AUTOMATIC_TAX=true                           # optional: let Stripe Tax add GST
NODE_ENV=production                                 # makes session cookie Secure (HTTPS only)
```

## Migrate + run

```bash
npm install
npm run migrate          # runs schema.sql then portal-schema.sql
npm start
# Client portal:  /portal/
# Staff review:   /onboarding/review
```

## Stripe setup (one-time)

1. In Stripe, create a **Product + recurring Price** for each tier (Bronze/Silver/Gold).
2. Store each Price id on the tier: `UPDATE membership_tiers SET stripe_price_id='price_...' WHERE code='silver';`
3. Add a webhook endpoint in Stripe → `https://tools.momentumtax.com.au/portal/api/stripe-webhook`,
   subscribe to `checkout.session.completed` and `customer.subscription.*`, copy the signing
   secret → `STRIPE_WEBHOOK_SECRET`.
4. Enable the **Customer Portal** in Stripe billing settings (allows self-service).

## Tiers & FAQs are data, not code

Both live in tables (`membership_tiers`, `portal_faqs`) and are seeded with placeholder
values — the tier names, prices, taglines, and features are all editable with plain SQL.
FAQs can be tier-gated via `min_tier` (null = visible to everyone; `silver` = Silver and
above, etc.). Market note: AU advisory firms commonly floor the entry tier around
$500/mo with Silver as the "most popular" sweet spot — the seeds reflect that, adjust freely.

## Linking portal clients to onboarding

When you approve an onboarding request, a `portal_clients` record is **automatically
created/linked** (keyed on email, idempotent) so the client can log into the portal
straight away. The `portal_clients.xpm_client_uuid` column ties the portal account to the
XPM client. Pass `create_portal_client: false` in the approve body to skip this.

## De-duplication against XPM (no auto-duplicates)

Every incoming booking is checked against existing XPM clients **before** anything is
created, using a confidence-scored match (`src/services/dedup.js`):

| Level | Trigger | What happens |
|---|---|---|
| `exact` | Email matches an existing XPM client | Staged as **duplicate**; reviewer links instead of creating |
| `strong` | ABN matches, or full name + business name match | Flagged in review with a **Link to existing** button |
| `possible` | Name matches but no email/ABN confirmation | Flagged for a human to eyeball |
| `none` | Nothing credible | Normal create-new flow |

In the review queue, a matched request shows the existing client and the match reasons,
with two choices:
- **Link to existing & open job** → opens the new job against the existing XPM client
  (`link_to_uuid`), so no duplicate client is created.
- **Approve → create in XPM** → creates a fresh client + job (use when it's genuinely new).

Because XPM's `client.api/search` is a broad text match, a raw hit is never treated as
proof on its own — only an exact email (or ABN/name corroboration) escalates confidence.
The link target is re-fetched with `client.api/get/[uuid]` at approval time to confirm it
still exists before the job is attached.

## Email delivery

`src/portal/email.js` is provider-agnostic. Set `EMAIL_WEBHOOK_URL` to a transactional
endpoint (your own, Make.com, Postmark/SES proxy, etc.) and it POSTs `{to,subject,text,html}`.
Left blank, it logs the link to the console so you can develop before wiring email.

---

# Document Exchange + Templated Forms

Secure per-client file exchange and reusable follow-up forms — the features that make
clients log in repeatedly rather than once.

## Document exchange (S3-compatible, storage-agnostic)

Files are **never stored on the app's disk**. Clients and staff upload/download directly
to/from object storage using short-lived **presigned URLs**; the server only brokers
permission and records metadata. Works with **Railway Buckets**, AWS S3, Cloudflare R2,
or MinIO — only the env changes.

```
S3_ENDPOINT=https://storage.railway.app   # omit for real AWS S3
S3_REGION=auto
S3_BUCKET=momentum-portal
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=                       # 'true' for MinIO / older buckets
```

Security built in: every storage key is namespaced per client (`clients/{id}/…`) and
the upload-confirm step rejects any key outside the caller's own namespace (tested).
Uploads are size-capped (50 MB) and type-restricted (PDF, Office, images, CSV). Client
documents are **soft-deleted**, never hard-deleted.

Flow: client picks a file → `POST /portal/api/docs/presign` (validates, returns presigned
PUT URL) → browser PUTs straight to storage → `POST /portal/api/docs/confirm` records it.
Download is the mirror: `GET /portal/api/docs/:id/download` returns a short-lived GET URL.

**Document requests:** staff can ask a client to upload something specific
(`POST /api/portal-admin/doc-requests`). It appears in the client's portal with an
"Upload this" button; uploading against it auto-marks the request fulfilled.

## Templated forms + follow-ups

Reusable form templates (seeded: *Annual Individual Tax Checklist*, *New Business / Entity
Details*) are JSON field schemas — text, number, boolean, select, textarea, each
optionally required. Staff send a template to a client
(`POST /api/portal-admin/forms/send`); the client fills it in the portal with
save-as-you-go progress, then submits. Re-submission is blocked once submitted.

**Chasing outstanding work:** `GET /api/portal-admin/outstanding` lists every unsubmitted
form and open document request across all clients, with reminder counts — your follow-up
queue. `POST /api/portal-admin/forms/:id/remind` and `.../doc-requests/:id/remind` send a
branded reminder email and increment the counter.

Everything optionally links to an XPM job via `xpm_job_number`, so document requests and
forms are tied to the engagement they belong to.

## Migrate

`npm run migrate` now runs all three schema files (core, portal, docs-forms) in order.

## Service → XPM template auto-mapping

The hand-maintained `XPM_TEMPLATE_MAP` env JSON is replaced by a live, DB-backed mapping
managed from the onboarding review page.

- The review page (`/onboarding/review`) has a **Service → XPM template mapping** panel.
  Click *Refresh templates from XPM* and it pulls your live job templates via
  `GET /template.api/list`. Each Trafft service that has appeared in a booking shows a
  dropdown of real XPM templates — pick one, it saves instantly.
- At approval time, provisioning resolves the template by priority:
  **DB mapping (case-insensitive) → `XPM_TEMPLATE_MAP` env JSON → none.** So existing env
  config keeps working as a fallback, but anything you set in the UI wins.
- Mapping is stored in `service_template_map` (run the new migration; it's included in
  `npm run migrate`). Both create-new and link-to-existing approval paths use it.

This means once a new Trafft service appears, it surfaces in the mapping panel
automatically — no code or config edits to wire it to the right XPM job template.

## Staff console UI

A single branded page at **`/staff/console`** that drives all the admin endpoints by
clicking instead of calling the API:

- **Share & Request** — search/select a client, upload a file to share with them, or
  request a specific upload. Shows that client's full document history and open requests.
- **Forms** — send any template to the selected client, and build new templates with a
  visual field builder (text / number / yes-no / dropdown / long-text, each optionally
  required). Field keys auto-generate from labels.
- **Follow-ups** — the chase queue: every unsubmitted form and open document request
  across all clients, each with a one-click **Send reminder** button and a reminder count.

All ten underlying endpoints are tested end-to-end (client search, share presign/confirm
with email notify, document request, template list/create, form send, outstanding queue,
reminders).

> **Auth:** like the other `/staff/*` and `/api/portal-admin/*` routes, mount this behind
> your existing staff login on `tools.momentumtax.com.au`. The endpoints carry a
> `requireStaffAuth` marker where your middleware hooks in — they are NOT client-auth gated.


