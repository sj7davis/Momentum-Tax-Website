// Verifies the Trafft webhook verification token.
// Trafft sends the token; you set the same value in TRAFFT_WEBHOOK_TOKEN.
// Trafft delivers it in the body (`verificationToken`) — we also accept a header
// in case your Trafft config is set to send it that way.

const crypto = require('crypto');

function safeEqual(a, b) {
    if (!a || !b) return false;
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

module.exports = function verifyTrafftToken(req, res, next) {
    const expected = process.env.TRAFFT_WEBHOOK_TOKEN;
    if (!expected) {
        console.error('[trafft] TRAFFT_WEBHOOK_TOKEN not set — rejecting');
        return res.status(500).json({ error: 'webhook not configured' });
    }
    const provided =
        req.get('x-trafft-verification-token') ||
        req.get('verification-token') ||
        (req.body && (req.body.verificationToken || req.body.verification_token));

    if (!safeEqual(provided, expected)) {
        console.warn('[trafft] rejected webhook: bad/missing verification token');
        return res.status(401).json({ error: 'invalid verification token' });
    }
    next();
};
