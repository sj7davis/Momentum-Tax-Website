// General client notifications (document shared, form sent, reminders).
// Uses the shared mailer (Resend -> webhook -> console).

const { send, brandShell } = require('./mailer');

async function sendClientEmail(toEmail, subject, bodyText) {
    const html = brandShell(`<p>${String(bodyText).replace(/\n/g, '<br>')}</p>`);
    await send({ to: toEmail, subject, html, text: bodyText });
}

module.exports = { sendClientEmail };
