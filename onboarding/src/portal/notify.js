// General client notifications (document shared, form sent, reminders).
// Same provider-agnostic pattern as email.js: POST to EMAIL_WEBHOOK_URL if set,
// else log to console for development.

async function sendClientEmail(toEmail, subject, bodyText) {
    const html =
        `<div style="font:15px/1.6 system-ui,Arial;color:#1f2933;max-width:520px">
           <h2 style="color:#0f2a47;margin:0 0 8px">Momentum<span style="color:#1ea7a0">Tax</span></h2>
           <p>${bodyText.replace(/\n/g, '<br>')}</p>
         </div>`;
    const hook = process.env.EMAIL_WEBHOOK_URL;
    if (hook) {
        const resp = await fetch(hook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: toEmail, subject, text: bodyText, html }),
        });
        if (!resp.ok) throw new Error(`Email webhook failed (${resp.status})`);
        return;
    }
    console.log(`\n[notify:dev] To: ${toEmail}\n[notify:dev] Subject: ${subject}\n[notify:dev] ${bodyText}\n`);
}

module.exports = { sendClientEmail };
