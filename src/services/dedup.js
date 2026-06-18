// Client de-duplication against Xero Practice Manager.
//
// XPM's client.api/search is a broad text match — a hit is NOT proof of a duplicate.
// So we score candidates and classify confidence:
//
//   exact     - email matches exactly (case-insensitive)  -> almost certainly the same client
//   strong    - ABN matches, OR full name + business name both match
//   possible  - name matches but no email/ABN corroboration -> human should eyeball it
//   none      - nothing credible
//
// The onboarding flow uses this to: auto-link on `exact`, flag for review on
// `strong`/`possible`, and create fresh on `none`.

const xpm = require('./xpm');

function norm(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function normAbn(s) {
    return String(s || '').replace(/\D/g, ''); // digits only
}

// Pull a comparable set of candidate clients out of XPM for a given record.
// We try a couple of search terms (email, then name/business) and merge results.
async function fetchCandidates(rec) {
    const terms = [];
    if (rec.email) terms.push(rec.email);
    const personName = `${rec.first_name || ''} ${rec.last_name || ''}`.trim();
    if (rec.business_name) terms.push(rec.business_name);
    if (personName) terms.push(personName);

    const seen = new Map();
    for (const term of terms) {
        let list = [];
        try {
            list = await xpm.searchClientsDetailed(term);
        } catch (e) {
            console.warn('[dedup] search failed for term:', term, e.message);
        }
        for (const c of list) {
            if (c.uuid && !seen.has(c.uuid)) seen.set(c.uuid, c);
        }
    }
    return [...seen.values()];
}

function scoreCandidate(rec, cand) {
    const reasons = [];
    let level = 'none';

    const recEmail = norm(rec.email);
    const recAbn = normAbn(rec.abn);
    const recBiz = norm(rec.business_name);
    const recName = norm(`${rec.first_name || ''} ${rec.last_name || ''}`);

    const candEmail = norm(cand.email);
    const candAbn = normAbn(cand.taxNumber || cand.abn);
    const candName = norm(cand.name);

    if (recEmail && candEmail && recEmail === candEmail) {
        return { level: 'exact', reasons: ['email matches exactly'] };
    }
    if (recAbn && candAbn && recAbn === candAbn) {
        level = 'strong'; reasons.push('ABN matches');
    }
    // name correspondence (candidate name may be person or business)
    const nameHit = (recName && candName && (candName.includes(recName) || recName.includes(candName)))
        || (recBiz && candName && (candName.includes(recBiz) || recBiz.includes(candName)));
    if (nameHit) {
        if (level === 'strong') reasons.push('name also matches');
        else { level = 'possible'; reasons.push('name matches (no email/ABN confirmation)'); }
    }
    return { level, reasons };
}

const RANK = { none: 0, possible: 1, strong: 2, exact: 3 };

// Returns the best match: { level, uuid, name, reasons } — level 'none' if nothing.
async function findDuplicate(rec) {
    const candidates = await fetchCandidates(rec);
    let best = { level: 'none', uuid: null, name: null, reasons: [] };
    for (const cand of candidates) {
        const { level, reasons } = scoreCandidate(rec, cand);
        if (RANK[level] > RANK[best.level]) {
            best = { level, uuid: cand.uuid, name: cand.name, reasons };
            if (level === 'exact') break; // can't do better
        }
    }
    return best;
}

module.exports = { findDuplicate };
