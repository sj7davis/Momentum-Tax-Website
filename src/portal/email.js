// Magic-link delivery for the client portal. Uses the shared mailer (Resend ->
// webhook -> console) so wiring a provider is a single env var.

const { send, brandShell } = require('./mailer');

async function sendMagicLink(toEmail, link) {
    const subject = 'Your Momentum Tax portal login link';
    const text =
        `Hi,\n\nHere is your secure login link for the Momentum Tax client portal:\n\n` +
        `${link}\n\nThis link expires in 15 minutes and can only be used once. ` +
        `If you didn't request it, you can ignore this email.\n\n— Momentum Tax`;
    const html = brandShell(
        `<p>Here is your secure login link for the client portal:</p>
         <p><a href="${link}" style="display:inline-block;background:#16314f;color:#fff;
                padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:600">Log in to the portal &rarr;</a></p>
         <p style="color:#5d6b7a;font-size:13px">This link expires in 15 minutes and can only be
            used once. If you didn't request it, ignore this email.</p>`
    );
    await send({ to: toEmail, subject, html, text });
}

module.exports = { sendMagicLink };
