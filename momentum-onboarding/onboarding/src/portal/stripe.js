// Stripe service for recurring memberships.
//
// Pattern (per Stripe's current subscriptions guide):
//   - Checkout Session in `subscription` mode hosts card entry on Stripe (no card data
//     touches our server -> stays out of PCI scope).
//   - We provision/sync our DB from webhooks: checkout.session.completed and
//     customer.subscription.{created,updated,deleted}.
//   - Customer Portal session lets clients self-manage (upgrade/downgrade/cancel/card).
//
// SECURITY: All keys come from env (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET). Never
// hardcode keys. Webhook signatures are verified against the RAW request body.

const db = require('../db/pool');

// Lazy-load stripe so the module imports even before the dep/env is set up.
function stripe() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not set');
    // eslint-disable-next-line global-require
    return require('stripe')(key);
}

const APP_URL = () => process.env.PORTAL_BASE_URL || 'http://localhost:3000';

// Create a subscription Checkout Session for a logged-in client + chosen tier.
async function createCheckoutSession(client, tierCode) {
    const tier = (await db.query(
        'SELECT * FROM membership_tiers WHERE code = $1 AND active = TRUE', [tierCode]
    )).rows[0];
    if (!tier) throw new Error('Unknown or inactive tier');
    if (!tier.stripe_price_id) {
        throw new Error(`Tier ${tierCode} has no stripe_price_id set. ` +
            `Create the recurring Price in Stripe and store its id on the tier.`);
    }

    const s = stripe();

    // Reuse a Stripe customer if we have one; else let Checkout create one and we
    // capture it on the webhook.
    let customerId = client.stripe_customer_id || undefined;
    if (!customerId) {
        const customer = await s.customers.create({
            email: client.email,
            name: client.full_name || client.business_name || undefined,
            metadata: { portal_client_id: String(client.id) },
        });
        customerId = customer.id;
        await db.query(
            'UPDATE portal_clients SET stripe_customer_id = $1 WHERE id = $2',
            [customerId, client.id]
        );
    }

    const session = await s.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: tier.stripe_price_id, quantity: 1 }],
        client_reference_id: String(client.id),
        subscription_data: { metadata: { portal_client_id: String(client.id), tier_code: tierCode } },
        // Stripe Tax can auto-apply GST if configured in the Stripe dashboard:
        automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX === 'true' },
        success_url: `${APP_URL()}/portal/?checkout=success`,
        cancel_url: `${APP_URL()}/portal/?checkout=cancelled`,
    });
    return session.url;
}

// Create a Billing (Customer) Portal session so the client can self-manage.
async function createBillingPortalSession(client) {
    if (!client.stripe_customer_id) throw new Error('No Stripe customer for this client');
    const s = stripe();
    const session = await s.billingPortal.sessions.create({
        customer: client.stripe_customer_id,
        return_url: `${APP_URL()}/portal/`,
    });
    return session.url;
}

// Verify + construct a webhook event from the raw body.
function constructEvent(rawBody, signature) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not set');
    return stripe().webhooks.constructEvent(rawBody, signature, secret);
}

// Upsert our subscription mirror from a Stripe subscription object.
async function syncSubscription(sub) {
    const clientId =
        (sub.metadata && sub.metadata.portal_client_id) ||
        (await clientIdFromCustomer(sub.customer));
    if (!clientId) {
        console.warn('[stripe] subscription with no resolvable client:', sub.id);
        return;
    }
    const tierCode = sub.metadata && sub.metadata.tier_code ? sub.metadata.tier_code : null;
    const periodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000) : null;

    await db.query(
        `INSERT INTO portal_subscriptions
            (client_id, tier_code, stripe_subscription_id, stripe_customer_id,
             status, current_period_end, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (stripe_subscription_id) DO UPDATE
           SET tier_code = COALESCE(EXCLUDED.tier_code, portal_subscriptions.tier_code),
               status = EXCLUDED.status,
               current_period_end = EXCLUDED.current_period_end,
               updated_at = now()`,
        [clientId, tierCode, sub.id, sub.customer, sub.status, periodEnd]
    );
}

async function clientIdFromCustomer(customerId) {
    const { rows } = await db.query(
        'SELECT id FROM portal_clients WHERE stripe_customer_id = $1', [customerId]
    );
    return rows.length ? String(rows[0].id) : null;
}

// Handle a verified webhook event.
async function handleEvent(event) {
    const s = stripe();
    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object;
            if (session.customer && session.client_reference_id) {
                await db.query(
                    'UPDATE portal_clients SET stripe_customer_id = $1 WHERE id = $2',
                    [session.customer, session.client_reference_id]
                );
            }
            if (session.subscription) {
                const sub = await s.subscriptions.retrieve(session.subscription);
                await syncSubscription(sub);
            }
            break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
            await syncSubscription(event.data.object);
            break;
        default:
            // ignore other events
            break;
    }
}

// Current subscription for a client (for portal display).
async function currentSubscription(clientId) {
    const { rows } = await db.query(
        `SELECT * FROM portal_subscriptions
          WHERE client_id = $1
          ORDER BY updated_at DESC LIMIT 1`,
        [clientId]
    );
    return rows[0] || null;
}

module.exports = {
    createCheckoutSession, createBillingPortalSession,
    constructEvent, handleEvent, currentSubscription,
};
