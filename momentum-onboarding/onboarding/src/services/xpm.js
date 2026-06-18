// Xero Practice Manager (XPM) API client.
//
// IMPORTANT: XPM API access is gated. You must register as a Xero app partner and
// complete the security self-assessment questionnaire before Xero grants Practice
// Manager scopes. Base URL: https://api.xero.com/practicemanager/3.0/  (OAuth 2.0).
//
// XPM request/response bodies are XML (not JSON). This client builds minimal XML
// payloads and parses responses with a light regex extractor (no extra XML dep
// required for the few fields we need). Swap in fast-xml-parser if you prefer.

const db = require('../db/pool');

const XPM_BASE = 'https://api.xero.com/practicemanager/3.0';
const TOKEN_URL = 'https://identity.xero.com/connect/token';

// ---- token management -------------------------------------------------------

async function loadToken() {
    const { rows } = await db.query('SELECT * FROM xpm_oauth WHERE id = 1');
    return rows[0] || null;
}

async function saveToken({ access_token, refresh_token, expires_in }) {
    const expiresAt = new Date(Date.now() + (expires_in - 60) * 1000); // 60s safety
    await db.query(
        `INSERT INTO xpm_oauth (id, access_token, refresh_token, expires_at, updated_at)
         VALUES (1, $1, $2, $3, now())
         ON CONFLICT (id) DO UPDATE
           SET access_token = $1, refresh_token = $2, expires_at = $3, updated_at = now()`,
        [access_token, refresh_token, expiresAt]
    );
}

async function refreshAccessToken(refreshToken) {
    // Xero accepts client credentials via HTTP Basic auth on the token endpoint.
    const basic = Buffer.from(
        `${process.env.XPM_CLIENT_ID}:${process.env.XPM_CLIENT_SECRET}`
    ).toString('base64');
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
    });
    const resp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
    });
    if (!resp.ok) {
        const t = await resp.text();
        // A 400 invalid_grant here almost always means the refresh token was revoked,
        // expired (60-day idle limit), or superseded. Re-run bootstrap-oauth.js.
        if (resp.status === 400) {
            throw new Error(
                `XPM token refresh rejected (invalid_grant). The stored refresh token is ` +
                `no longer valid — re-run bootstrap-oauth.js to reconnect. Detail: ${t}`
            );
        }
        throw new Error(`XPM token refresh failed (${resp.status}): ${t}`);
    }
    const json = await resp.json();
    await saveToken(json);           // Xero rotates the refresh token — must persist
    return json.access_token;
}

async function getAccessToken() {
    let token = await loadToken();
    // Bootstrap from env on first run if the table is empty
    if (!token) {
        if (!process.env.XPM_REFRESH_TOKEN) {
            throw new Error('No XPM token stored and XPM_REFRESH_TOKEN not set');
        }
        const access = await refreshAccessToken(process.env.XPM_REFRESH_TOKEN);
        return access;
    }
    if (new Date(token.expires_at).getTime() <= Date.now()) {
        return refreshAccessToken(token.refresh_token);
    }
    return token.access_token;
}

// ---- low-level request ------------------------------------------------------

async function xpmRequest(method, path, xmlBody) {
    const accessToken = await getAccessToken();
    const resp = await fetch(`${XPM_BASE}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Xero-tenant-id': process.env.XPM_TENANT_ID,
            Accept: 'application/xml',
            ...(xmlBody ? { 'Content-Type': 'application/xml' } : {}),
        },
        body: xmlBody || undefined,
    });
    const text = await resp.text();
    if (!resp.ok) {
        throw new Error(`XPM ${method} ${path} failed (${resp.status}): ${text}`);
    }
    return text;
}

// tiny XML field extractor for the handful of values we read back
function xmlValue(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? m[1].trim() : null;
}
function xmlEscape(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ---- operations -------------------------------------------------------------

// Dedup: search existing XPM clients by name/email before creating a new one.
// Returns a client UUID if a likely match is found, else null.
// Parse multiple <Client>...</Client> blocks out of an XPM search/list response.
function parseClientBlocks(xml) {
    const blocks = xml.match(/<Client>[\s\S]*?<\/Client>/gi) || [];
    return blocks.map(b => ({
        uuid: xmlValue(b, 'UUID') || xmlValue(b, 'ID'),
        name: xmlValue(b, 'Name'),
        email: xmlValue(b, 'Email'),
        taxNumber: xmlValue(b, 'TaxNumber'),
        isPerson: (xmlValue(b, 'IsPerson') || '').toLowerCase() === 'true',
    })).filter(c => c.uuid);
}

// Detailed search: returns an ARRAY of candidate client objects for dedup scoring.
async function searchClientsDetailed(term) {
    const q = encodeURIComponent(term || '');
    if (!q) return [];
    const xml = await xpmRequest('GET', `/client.api/search?query=${q}&detailed=true`);
    return parseClientBlocks(xml);
}

// Back-compat single-UUID search (first hit only). Prefer searchClientsDetailed + dedup.
async function searchClient({ name, email }) {
    const term = email || name || '';
    if (!term) return null;
    try {
        const list = await searchClientsDetailed(term);
        return list.length ? list[0].uuid : null;
    } catch (e) {
        console.warn('[xpm] client search failed (continuing):', e.message);
        return null;
    }
}

// Fetch a single client by UUID (used to confirm a link target still exists).
async function getClient(uuid) {
    if (!uuid) return null;
    try {
        const xml = await xpmRequest('GET', `/client.api/get/${encodeURIComponent(uuid)}`);
        const list = parseClientBlocks(xml);
        return list.length ? list[0] : null;
    } catch (e) {
        console.warn('[xpm] getClient failed:', e.message);
        return null;
    }
}

// Create a client. For non-individuals XPM uses Name; for individuals, first/last.
async function addClient(rec) {
    const isIndividual = (rec.entity_type || 'Individual') === 'Individual';
    const displayName = isIndividual
        ? `${rec.first_name || ''} ${rec.last_name || ''}`.trim()
        : (rec.business_name || `${rec.first_name || ''} ${rec.last_name || ''}`.trim());

    const xml =
        `<Client>` +
        `<Name>${xmlEscape(displayName)}</Name>` +
        (isIndividual ? `<IsPerson>true</IsPerson>` : `<IsPerson>false</IsPerson>`) +
        (rec.first_name ? `<FirstName>${xmlEscape(rec.first_name)}</FirstName>` : ``) +
        (rec.last_name ? `<LastName>${xmlEscape(rec.last_name)}</LastName>` : ``) +
        (rec.email ? `<Email>${xmlEscape(rec.email)}</Email>` : ``) +
        (rec.phone ? `<Phone>${xmlEscape(rec.phone)}</Phone>` : ``) +
        (rec.abn ? `<TaxNumber>${xmlEscape(rec.abn)}</TaxNumber>` : ``) +
        `</Client>`;

    const resp = await xpmRequest('POST', '/client.api/add', xml);
    const uuid = xmlValue(resp, 'UUID') || xmlValue(resp, 'ID');
    if (!uuid) throw new Error('XPM addClient: no UUID returned');
    return uuid;
}

// Open a job for a client.
async function addJob({ clientUuid, name, description, staffUuid, startDate, dueDate, state }) {
    const xml =
        `<Job>` +
        `<ClientUUID>${xmlEscape(clientUuid)}</ClientUUID>` +
        `<Name>${xmlEscape(name)}</Name>` +
        (description ? `<Description>${xmlEscape(description)}</Description>` : ``) +
        (startDate ? `<StartDate>${xmlEscape(startDate)}</StartDate>` : ``) +
        (dueDate ? `<DueDate>${xmlEscape(dueDate)}</DueDate>` : ``) +
        `<State>${xmlEscape(state || 'Planned')}</State>` +
        (staffUuid ? `<AssignedStaff><Staff><UUID>${xmlEscape(staffUuid)}</UUID></Staff></AssignedStaff>` : ``) +
        `</Job>`;

    const resp = await xpmRequest('POST', '/job.api/add', xml);
    const jobNumber = xmlValue(resp, 'ID') || xmlValue(resp, 'Number') || xmlValue(resp, 'UUID');
    if (!jobNumber) throw new Error('XPM addJob: no job number returned');
    return jobNumber;
}

// Apply a job template (standard task list) by template name.
async function applyTemplate(jobNumber, templateName) {
    if (!templateName) return;
    const xml =
        `<Job>` +
        `<ID>${xmlEscape(jobNumber)}</ID>` +
        `<TemplateName>${xmlEscape(templateName)}</TemplateName>` +
        `</Job>`;
    await xpmRequest('POST', `/job.api/applytemplate/${encodeURIComponent(jobNumber)}`, xml);
}

// Fetch the practice's live job templates from XPM (GET /template.api/list).
// Returns [{ name, uuid }]. Used to drive the service->template mapping UI so the
// mapping is chosen from real templates rather than hand-typed.
async function listTemplates() {
    const xml = await xpmRequest('GET', '/template.api/list');
    const blocks = xml.match(/<Template>[\s\S]*?<\/Template>/gi) || [];
    return blocks.map(b => ({
        name: xmlValue(b, 'Name'),
        uuid: xmlValue(b, 'UUID') || xmlValue(b, 'ID'),
    })).filter(t => t.name);
}

// Resolve the XPM template name for a given Trafft service name.
// Priority: DB mapping (service_template_map) -> env XPM_TEMPLATE_MAP JSON -> none.
async function resolveTemplateName(serviceName) {
    if (!serviceName) return null;
    try {
        const { rows } = await db.query(
            'SELECT template_name FROM service_template_map WHERE lower(service_name) = lower($1)',
            [serviceName]
        );
        if (rows.length && rows[0].template_name) return rows[0].template_name;
    } catch (e) {
        // table may not exist yet on older installs — fall through to env
        console.warn('[xpm] template map lookup failed, using env fallback:', e.message);
    }
    const envMap = JSON.parse(process.env.XPM_TEMPLATE_MAP || '{}');
    return envMap[serviceName] || null;
}

// Orchestrates the full provisioning for one approved request.
async function provision(rec) {
    const templateName = await resolveTemplateName(rec.service_name);

    const clientUuid = await addClient(rec);

    const jobName = rec.service_name || 'New engagement';
    const jobNumber = await addJob({
        clientUuid,
        name: jobName,
        description: `Auto-created from Trafft booking ${rec.trafft_appointment_id || ''}`.trim(),
        staffUuid: process.env.XPM_DEFAULT_STAFF_UUID,
        startDate: new Date().toISOString().slice(0, 10),
        state: 'Planned',
    });

    await applyTemplate(jobNumber, templateName);

    return { clientUuid, jobNumber };
}

// Lightweight connection status for a health endpoint — does not call XPM data APIs.
async function connectionStatus() {
    const token = await loadToken();
    if (!token || !token.refresh_token) {
        return { connected: false, reason: 'no_token', hint: 'Run bootstrap-oauth.js' };
    }
    const expired = new Date(token.expires_at).getTime() <= Date.now();
    return {
        connected: true,
        access_token_expired: expired,
        expires_at: token.expires_at,
        tenant_id: process.env.XPM_TENANT_ID || null,
        updated_at: token.updated_at,
    };
}

module.exports = {
    searchClient, searchClientsDetailed, getClient,
    addClient, addJob, applyTemplate, listTemplates, resolveTemplateName, provision,
    getAccessToken, connectionStatus,
};
