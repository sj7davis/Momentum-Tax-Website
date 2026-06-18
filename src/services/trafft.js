// Parse a Trafft "Appointment Booked" webhook into a normalised onboarding record.
//
// Trafft payload shapes vary by account config and by what you toggle in the webhook
// settings. This parser is defensive: it looks in several likely locations for each
// field and pulls intake answers out of the custom-fields array by LABEL.
//
// Configure the labels you used in Trafft's Custom Fields here so they map cleanly.
const FIELD_LABELS = {
    entityType:   ['Entity Type', 'Entity', 'Structure'],
    businessName: ['Business Name', 'Entity Name', 'Trading Name'],
    abn:          ['ABN', 'ABN/ACN', 'ACN'],
    // anything else is kept verbatim in `intake`
};

function pick(obj, ...paths) {
    for (const p of paths) {
        const v = p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
}

// Trafft custom fields can arrive as an array of {label,value} or as an object.
function extractCustomFields(payload) {
    const candidates = [
        payload.customFields,
        payload.custom_fields,
        pick(payload, 'appointment.customFields'),
        pick(payload, 'booking.customFields'),
        pick(payload, 'customer.customFields'),
    ].filter(Boolean);

    const out = {};
    for (const c of candidates) {
        if (Array.isArray(c)) {
            for (const f of c) {
                const label = f.label || f.name || f.fieldLabel;
                const value = f.value !== undefined ? f.value : f.fieldValue;
                if (label) out[label] = value;
            }
        } else if (typeof c === 'object') {
            Object.assign(out, c);
        }
    }
    return out;
}

function matchLabel(custom, labels) {
    for (const want of labels) {
        const hit = Object.keys(custom).find(
            k => k.trim().toLowerCase() === want.toLowerCase()
        );
        if (hit) return custom[hit];
    }
    return undefined;
}

function normaliseEntityType(raw) {
    if (!raw) return 'Individual';
    const s = String(raw).toLowerCase();
    if (s.includes('compan') || s.includes('pty')) return 'Company';
    if (s.includes('trust')) return 'Trust';
    if (s.includes('partner')) return 'Partnership';
    if (s.includes('smsf') || s.includes('super')) return 'SMSF';
    if (s.includes('sole'))    return 'Sole Trader';
    return 'Individual';
}

function parseTrafftPayload(payload) {
    const custom = extractCustomFields(payload);

    const firstName = pick(payload,
        'customer.firstName', 'customerFirstName', 'firstName', 'customer.first_name');
    const lastName = pick(payload,
        'customer.lastName', 'customerLastName', 'lastName', 'customer.last_name');
    const email = pick(payload,
        'customer.email', 'customerEmail', 'email');
    const phone = pick(payload,
        'customer.phone', 'customerPhone', 'phone');
    const serviceName = pick(payload,
        'service.name', 'serviceName', 'service', 'appointment.service.name');
    const appointmentAt = pick(payload,
        'appointment.dateTime', 'bookingStart', 'dateTime', 'appointmentDateTime', 'startDateTime');
    const appointmentId = pick(payload,
        'appointment.id', 'appointmentId', 'id', 'booking.id');

    const entityType = normaliseEntityType(
        matchLabel(custom, FIELD_LABELS.entityType)
    );
    const businessName = matchLabel(custom, FIELD_LABELS.businessName);
    const abn = matchLabel(custom, FIELD_LABELS.abn);

    return {
        trafft_appointment_id: appointmentId ? String(appointmentId) : null,
        first_name: firstName || null,
        last_name: lastName || null,
        email: email || null,
        phone: phone || null,
        entity_type: entityType,
        business_name: businessName || null,
        abn: abn || null,
        service_name: serviceName || null,
        appointment_at: appointmentAt || null,
        intake: custom,           // everything, for the reviewer to see
    };
}

module.exports = { parseTrafftPayload };
