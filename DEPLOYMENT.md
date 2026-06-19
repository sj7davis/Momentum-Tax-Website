# Go-live checklist — booking → payment → XPM

The whole pipeline is built. What remains is account setup and wiring, in dependency
order. **Start the XPM partner application first — it's the long pole.**

The chain: **Trafft booking → webhook → dedup vs XPM → review queue → approve (AML gate)
→ XPM client + job + template → portal login → Stripe membership.**

---

## 0. XPM Partner API access — START TODAY (gates the XPM half)

- [ ] Apply for **Xero App Partner** status and **Practice Manager API** access at
      <https://developer.xero.com>. This requires passing Xero's **security
      self-assessment questionnaire**. It is the slowest step — everything XPM waits on it.
- [ ] Create an **OAuth2 app** (grant type *Auth Code*). Set the redirect URI to exactly:
      `http://localhost:5055/callback`
- [ ] In **Xero Practice Manager → your Staff profile**, scroll to the bottom of page 2 and
      toggle ON **"Connect third-party add-ons"** (connections silently fail without it).
- [ ] Note your `XPM_CLIENT_ID` and `XPM_CLIENT_SECRET`.

Everything below can proceed in parallel while this is in review.

---

## 1. Deploy to Railway

- [ ] Railway → **New Project → Deploy from GitHub** → `sj7davis/Momentum-Tax-Website`.
- [ ] Add the **PostgreSQL** plugin → `DATABASE_URL` is injected automatically.
- [ ] Add a **Storage Bucket** → copy its credentials into the `S3_*` vars.
- [ ] Set all env vars from [.env.example](.env.example) (see each section below).
- [ ] Run the migrations once: `npm run migrate` (Railway shell, or locally with the prod
      `DATABASE_URL`). Creates onboarding, portal, docs/forms, and staff tables.
- [ ] Point `momentumtax.com.au` at the Railway service. Keep WordPress up until the new
      site renders, then cut DNS over. `bookings.` and `myform.` subdomains stay as-is.

---

## 2. Email (Resend) — required before anyone can log in

Magic links (clients **and** staff) send through Resend.

- [ ] Create a **Resend** account → <https://resend.com>.
- [ ] **Add & verify the domain** `momentumtax.com.au` (Resend → Domains → add the DNS
      records it gives you: SPF/DKIM, and DMARC if prompted). Wait for "Verified".
- [ ] Create an API key → set `RESEND_API_KEY` in Railway.
- [ ] Set `EMAIL_FROM` to an address on the verified domain, e.g.
      `Momentum Tax <noreply@momentumtax.com.au>`.
- [ ] Test: trigger a portal login; the email should arrive. (Until `RESEND_API_KEY` is set,
      links only print to the server logs.)

> New-domain warm-up: Resend caps a brand-new domain to ~150 sends on day one. Fine for
> magic links; just be aware if you blast reminders.

---

## 3. Staff access

- [ ] Set `STAFF_EMAILS` to a comma-separated allow-list, e.g.
      `scott.davis@momentumtax.com.au,admin@momentumtax.com.au`.
- [ ] Staff log in at **`/staff/login`** (magic link). Only allow-listed emails work.
      The review queue (`/onboarding/review`), staff console (`/staff/console`) and all
      `/api/portal-admin/*` endpoints are gated behind this.

---

## 4. Booking in (Trafft)

- [ ] Set `TRAFFT_WEBHOOK_TOKEN` (any strong secret) in Railway.
- [ ] In Trafft, add an **"Appointment Booked" webhook** → your deployed
      `/api/onboarding/...` endpoint, including that token.
- [ ] Confirm your **custom-field labels** (Entity Type, Business Name, ABN…) match
      `FIELD_LABELS` in [src/services/trafft.js](src/services/trafft.js).
- [ ] Use Trafft's **"Send Test Webhook"** → the booking should appear in `/onboarding/review`.

---

## 5. Paying (Stripe)

- [ ] Create **Bronze / Silver / Gold** products + monthly recurring **prices** in Stripe.
- [ ] Store each `price_id` on the matching row in `membership_tiers`.
- [ ] Set `STRIPE_SECRET_KEY`.
- [ ] Create a Stripe **webhook** → `https://<your-domain>/portal/api/stripe-webhook`,
      then set `STRIPE_WEBHOOK_SECRET`.
- [ ] Test a subscription in **test mode**, then switch to live keys.

---

## 6. Connect XPM (once partner access is granted)

- [ ] Locally set `XPM_CLIENT_ID`, `XPM_CLIENT_SECRET`, `DATABASE_URL`, then run
      `npm run bootstrap-xpm` → open <http://localhost:5055/> → connect & choose your org.
- [ ] It stores the refresh token and auto-detects your tenant. Put `XPM_REFRESH_TOKEN`,
      `XPM_TENANT_ID`, and `XPM_DEFAULT_STAFF_UUID` (who jobs assign to) into Railway.
- [ ] Confirm the link is live: `GET /api/onboarding/xpm-status`.
- [ ] **10-minute verification against your live tenant:** confirm the exact XPM endpoint
      paths (`client.api/add`, `job.api/add`, etc.) and the job-template apply signature.
      The code targets the documented v3.1 shape; Xero's docs show minor variance.
- [ ] In `/onboarding/review`, open the **Service → XPM template mapping** panel →
      "Refresh templates from XPM" → map each Trafft service to a template.

---

## 7. End-to-end smoke test

1. Make a real test booking in Trafft.
2. It lands in `/onboarding/review` with a dedup verdict.
3. Approve (clear the AML/CTF identity gate) → XPM client + job + template created.
4. The client gets an auto-created portal login → magic-link in → sees documents/forms.
5. Client subscribes to a tier via Stripe → status syncs back via webhook.

---

## Env var quick map

| Area | Vars |
|------|------|
| Core | `PORT`, `NODE_ENV`, `PORTAL_BASE_URL`, `DATABASE_URL` |
| Email | `RESEND_API_KEY`, `EMAIL_FROM` (fallback: `EMAIL_WEBHOOK_URL`) |
| Staff | `STAFF_EMAILS` |
| Trafft | `TRAFFT_WEBHOOK_TOKEN` |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_AUTOMATIC_TAX` |
| XPM | `XPM_CLIENT_ID`, `XPM_CLIENT_SECRET`, `XPM_REFRESH_TOKEN`, `XPM_TENANT_ID`, `XPM_DEFAULT_STAFF_UUID` |
| Storage | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` |
