// Minimal email sender for magic-link delivery.
//
// Provider-agnostic: if EMAIL_WEBHOOK_URL is set (e.g. a Make.com / Zapier / your own
// transactional endpoint), we POST the message there. Otherwise we log to console so
// you can develop without wiring email yet. Swap in nodemailer/Postmark/SES as needed.

async function sendMagicLink(toEmail, link) {
    const subject = 'Your Momentum Tax portal login link';
    const text =
        `Hi,\n\nHere is your secure login link for the Momentum Tax client portal:\n\n` +
        `${link}\n\nThis link expires in 15 minutes and can only be used once. ` +
        `If you didn't request it, you can ignore this email.\n\n— Momentum Tax`;
    const html =
        `<div style="font:15px/1.6 system-ui,Arial;color:#1f2933;max-width:520px">
           <h2 style="color:#0f2a47;margin:0 0 8px">Momentum<span style="color:#1ea7a0">Tax</span></h2>
           <p>Here is your secure login link for the client portal:</p>
           <p><a href="${link}" style="display:inline-block;background:#1ea7a0;color:#fff;
                  padding:12px 22px;border-radius:8px;text-decoration:none">Log in to the portal →</a></p>
           <p style="color:#6b7785;font-size:13px">This link expires in 15 minutes and can only be
              used once. If you didn't request it, ignore this email.</p>
         </div>`;

    const hook = process.env.EMAIL_WEBHOOK_URL;
    if (hook) {
        const resp = await fetch(hook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: toEmail, subject, text, html }),
        });
        if (!resp.ok) throw new Error(`Email webhook failed (${resp.status})`);
        return;
    }
    // Dev fallback
    console.log(`\n[email:dev] To: ${toEmail}\n[email:dev] Subject: ${subject}\n[email:dev] Link: ${link}\n`);
}

module.exports = { sendMagicLink };
