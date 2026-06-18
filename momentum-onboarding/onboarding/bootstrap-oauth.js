// XPM OAuth2 bootstrap — RUN ONCE to obtain your initial refresh token.
//
// Xero issues access tokens per USER. This flow connects the XPM tenant under the
// login of whoever completes it (i.e. you). After this runs successfully, the main
// app refreshes tokens automatically and you never need this again — unless the
// connection is revoked or consent scopes change.
//
// Prerequisites:
//   1. XPM API access approved by Xero (security self-assessment passed).
//   2. An OAuth2 app created at https://developer.xero.com with grant type "Auth Code".
//      - Redirect URI must include EXACTLY: http://localhost:5055/callback
//   3. In Xero Practice Manager: open your own Staff profile, scroll to the very
//      bottom of page 2, and toggle ON "Connect third-party add-ons".
//
// Usage:
//   XPM_CLIENT_ID=... XPM_CLIENT_SECRET=... DATABASE_URL=... node bootstrap-oauth.js
//   then open http://localhost:5055/  in your browser and follow the prompts.

const express = require('express');
const crypto = require('crypto');
const db = require('./src/db/pool');

const PORT = 5055;
const REDIRECT_URI = process.env.XPM_REDIRECT_URI || `http://localhost:${PORT}/callback`;
const AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

// practicemanager = XPM data; offline_access = required to receive a refresh_token;
// openid/profile/email = identify the connecting user (optional but useful).
const SCOPES = 'openid profile email practicemanager offline_access';

const CLIENT_ID = process.env.XPM_CLIENT_ID;
const CLIENT_SECRET = process.env.XPM_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Set XPM_CLIENT_ID and XPM_CLIENT_SECRET before running.');
    process.exit(1);
}

const app = express();
let pendingState = null;

app.get('/', (_req, res) => {
    pendingState = crypto.randomBytes(16).toString('hex'); // CSRF guard
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        state: pendingState,
    });
    res.send(`
      <div style="font:16px/1.6 system-ui;max-width:620px;margin:60px auto;color:#0f2a47">
        <h2>Momentum<span style="color:#1ea7a0">Tax</span> · Connect Xero Practice Manager</h2>
        <p>This one-time step connects your XPM account and stores a refresh token in your database.</p>
        <ol>
          <li>Make sure <b>"Connect third-party add-ons"</b> is toggled on in your XPM staff profile.</li>
          <li>Click connect, log in to Xero, and choose your Practice Manager organisation.</li>
        </ol>
        <p><a href="${AUTH_URL}?${params}"
              style="display:inline-block;background:#1ea7a0;color:#fff;padding:12px 22px;
                     border-radius:8px;text-decoration:none">Connect Xero Practice Manager →</a></p>
        <p style="color:#6b7785;font-size:13px">Redirect URI in use: <code>${REDIRECT_URI}</code><br>
           This must match exactly what you set in the Xero developer portal.</p>
      </div>`);
});

app.get('/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;
    if (error) {
        return res.status(400).send(`Authorisation failed: ${error} — ${error_description || ''}`);
    }
    if (!code || state !== pendingState) {
        return res.status(400).send('State mismatch or missing code. Start again at /.');
    }

    try {
        // 1. Exchange the auth code for tokens.
        const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const tokenResp = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${basic}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: String(code),
                redirect_uri: REDIRECT_URI,
            }),
        });
        if (!tokenResp.ok) {
            const t = await tokenResp.text();
            return res.status(502).send(`Token exchange failed (${tokenResp.status}): ${t}`);
        }
        const tokens = await tokenResp.json();

        // 2. Find the connected tenant(s). We want the Practice Manager tenant.
        const connResp = await fetch(CONNECTIONS_URL, {
            headers: {
                Authorization: `Bearer ${tokens.access_token}`,
                'Content-Type': 'application/json',
            },
        });
        const connections = await connResp.json();
        // PM tenants report tenantType "PRACTICEMANAGER"; fall back to first if absent.
        const pm = (Array.isArray(connections) ? connections : [])
            .find(c => (c.tenantType || '').toUpperCase().includes('PRACTICE'))
            || (Array.isArray(connections) ? connections[0] : null);

        // 3. Persist tokens (refresh token rotates on each later refresh).
        const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000);
        await db.query(
            `INSERT INTO xpm_oauth (id, access_token, refresh_token, expires_at, updated_at)
             VALUES (1, $1, $2, $3, now())
             ON CONFLICT (id) DO UPDATE
               SET access_token = $1, refresh_token = $2, expires_at = $3, updated_at = now()`,
            [tokens.access_token, tokens.refresh_token, expiresAt]
        );

        const tenantId = pm ? pm.tenantId : '(none found)';
        const tenantName = pm ? pm.tenantName : '';

        res.send(`
          <div style="font:16px/1.6 system-ui;max-width:620px;margin:60px auto;color:#0f2a47">
            <h2 style="color:#1e8e4e">✓ Connected</h2>
            <p>Refresh token stored in <code>xpm_oauth</code>. The main app will now manage
               tokens automatically.</p>
            <p><b>Connected tenant:</b> ${tenantName} <br>
               <b>Tenant ID:</b> <code>${tenantId}</code></p>
            <div style="background:#f4f6f9;border:1px solid #e3e8ee;border-radius:8px;padding:14px;margin-top:16px">
              <b>Set this in your environment</b> so API calls target the right org:<br>
              <code>XPM_TENANT_ID=${tenantId}</code>
            </div>
            <p style="color:#6b7785;font-size:13px;margin-top:18px">
               You can stop this bootstrap server now (Ctrl-C). Do not commit tokens to source control.</p>
          </div>`);

        console.log('\n✓ XPM connected.');
        if (pm) console.log(`  Set XPM_TENANT_ID=${tenantId}  (${tenantName})`);
        console.log('  Tokens saved to xpm_oauth. You can stop this server.\n');
    } catch (e) {
        console.error('[bootstrap] error:', e);
        res.status(500).send('Unexpected error — see server logs.');
    }
});

app.listen(PORT, () => {
    console.log(`\nXPM OAuth2 bootstrap running.`);
    console.log(`Open http://localhost:${PORT}/ in your browser to connect.\n`);
    console.log(`Redirect URI (must match Xero app config): ${REDIRECT_URI}\n`);
});
