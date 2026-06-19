// Central transactional email sender.
//
// Order of preference:
//   1. RESEND_API_KEY set  -> send via the Resend REST API (the supported path).
//   2. EMAIL_WEBHOOK_URL set -> POST the message to that endpoint (legacy/fallback).
//   3. Neither               -> log to console (local dev) so you can develop without email.
//
// Server-side only (the Resend API has no CORS — never call it from the browser).
// The Resend REST API mirrors the SDK: POST https://api.resend.com/emails with a
// Bearer key and { from, to, subject, html, text }. We call it with fetch so the
// app keeps zero extra runtime dependencies.

const RESEND_URL = 'https://api.resend.com/emails';

// A sensible default "from". Override with EMAIL_FROM once your domain is verified
// in Resend (e.g. "Momentum Tax <noreply@momentumtax.com.au>").
function fromAddress() {
    return process.env.EMAIL_FROM || 'Momentum Tax <noreply@momentumtax.com.au>';
}

// Wrap body HTML in a simple branded shell that matches the site (navy/steel).
function brandShell(innerHtml) {
    return `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1c2733;max-width:540px;margin:0 auto;padding:8px">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:600;color:#16314f;letter-spacing:.5px;margin:0 0 4px">
        <span style="color:#4f7299">&rsaquo;</span> Momentum Tax
      </div>
      <div style="height:3px;width:46px;background:#4f7299;border-radius:2px;margin:0 0 18px"></div>
      ${innerHtml}
      <div style="border-top:1px solid #e4e9ef;margin-top:26px;padding-top:14px;color:#5d6b7a;font-size:12px">
        Momentum Tax · Essendon Fields, Melbourne<br>
        Liability limited by a scheme approved under Professional Standards Legislation.
      </div>
    </div>`;
}

// Low-level send. `html` should already be the full branded body (use brandShell).
// `idempotencyKey` (optional) guards against duplicate sends on retry.
async function send({ to, subject, html, text, idempotencyKey }) {
    const apiKey = process.env.RESEND_API_KEY;
    const payload = { from: fromAddress(), to: Array.isArray(to) ? to : [to], subject, html, text };

    if (apiKey) {
        const headers = {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        };
        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
        const resp = await fetch(RESEND_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            throw new Error(`Resend send failed (${resp.status}): ${detail}`);
        }
        return;
    }

    const hook = process.env.EMAIL_WEBHOOK_URL;
    if (hook) {
        const resp = await fetch(hook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, subject, text, html }),
        });
        if (!resp.ok) throw new Error(`Email webhook failed (${resp.status})`);
        return;
    }

    // Dev fallback — no provider configured.
    console.log(`\n[email:dev] To: ${to}\n[email:dev] Subject: ${subject}\n[email:dev] ${text || ''}\n`);
}

module.exports = { send, brandShell };
