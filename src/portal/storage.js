// S3-compatible object storage for the document exchange.
//
// Storage-agnostic: works with Railway Buckets, AWS S3, Cloudflare R2, MinIO, etc.
// Only the env config changes. Files NEVER touch the app's disk — clients upload and
// download directly to/from storage using short-lived presigned URLs, so the server
// just brokers permission and records metadata.
//
// Env:
//   S3_ENDPOINT          e.g. https://storage.railway.app  (omit for real AWS S3)
//   S3_REGION            e.g. auto / us-east-1
//   S3_BUCKET            bucket name
//   S3_ACCESS_KEY_ID
//   S3_SECRET_ACCESS_KEY
//   S3_FORCE_PATH_STYLE  'true' for MinIO/older buckets; omit for virtual-hosted

const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } =
    require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let _client = null;
function client() {
    if (_client) return _client;
    if (!process.env.S3_BUCKET) throw new Error('S3_BUCKET not set');
    _client = new S3Client({
        region: process.env.S3_REGION || 'auto',
        endpoint: process.env.S3_ENDPOINT || undefined,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        },
    });
    return _client;
}
const BUCKET = () => process.env.S3_BUCKET;

// Build a namespaced, unguessable storage key. Client docs are foldered per client.
function buildKey(clientId, filename) {
    const safe = String(filename).replace(/[^\w.\-]+/g, '_').slice(0, 120);
    const rand = crypto.randomBytes(8).toString('hex');
    return `clients/${clientId}/${Date.now()}-${rand}-${safe}`;
}

// Presigned URL the client/staff browser uses to PUT the file straight to storage.
async function presignUpload(key, contentType, expiresSeconds = 300) {
    const cmd = new PutObjectCommand({
        Bucket: BUCKET(), Key: key, ContentType: contentType || 'application/octet-stream',
    });
    return getSignedUrl(client(), cmd, { expiresIn: expiresSeconds });
}

// Presigned URL to GET (download) the file. Short-lived.
async function presignDownload(key, filename, expiresSeconds = 120) {
    const cmd = new GetObjectCommand({
        Bucket: BUCKET(), Key: key,
        ResponseContentDisposition: filename
            ? `attachment; filename="${filename.replace(/"/g, '')}"` : undefined,
    });
    return getSignedUrl(client(), cmd, { expiresIn: expiresSeconds });
}

async function deleteObject(key) {
    await client().send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }));
}

// Basic guard rails for uploads.
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const ALLOWED = new Set([
    'application/pdf', 'image/png', 'image/jpeg', 'image/heic',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',        // xlsx
    'application/msword', 'application/vnd.ms-excel',
    'text/csv', 'text/plain',
]);
function validateUpload({ contentType, sizeBytes }) {
    if (sizeBytes && sizeBytes > MAX_BYTES) {
        return { ok: false, reason: `File exceeds ${MAX_BYTES / 1024 / 1024} MB limit` };
    }
    if (contentType && !ALLOWED.has(contentType)) {
        return { ok: false, reason: `File type ${contentType} not allowed` };
    }
    return { ok: true };
}

module.exports = {
    buildKey, presignUpload, presignDownload, deleteObject, validateUpload, MAX_BYTES,
};
