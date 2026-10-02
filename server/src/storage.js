require('dotenv').config();
const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
};

const VALID_MIMES = Object.keys(MIME_EXT);
const PREFIXES = ['services', 'oils', 'promotions', 'gallery'];

/**
 * Everything under this prefix is private and must only be reachable through an
 * authenticated API route. It lives in a separate, non-public bucket when
 * R2_PRIVATE_BUCKET_NAME is set, so a leaked public URL can never expose it.
 */
const PRIVATE_PREFIX = 'work';

const config = {
  accountId: process.env.R2_ACCOUNT_ID || '',
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  bucket: process.env.R2_BUCKET_NAME || 'avtoservis',
  privateBucket: (process.env.R2_PRIVATE_BUCKET_NAME || '').trim(),
  endpoint: (process.env.R2_ENDPOINT || '').replace(/\/+$/, ''),
  publicUrl: (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, ''),
};

const enabled =
  Boolean(
    config.accessKeyId &&
      config.secretAccessKey &&
      config.bucket &&
      config.endpoint &&
      config.publicUrl
  );

/** Private objects need a bucket of their own, otherwise a public URL would leak them. */
const privateEnabled = Boolean(enabled && config.privateBucket);

/** Picks the bucket a key belongs to. Routing by prefix keeps the DB schema unchanged. */
function bucketForKey(key) {
  return String(key || '').startsWith(`${PRIVATE_PREFIX}/`) ? config.privateBucket : config.bucket;
}

let client = null;
if (enabled) {
  client = new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function extForMime(mime) {
  return MIME_EXT[mime] || '';
}

function isValidMime(mime) {
  return Object.prototype.hasOwnProperty.call(MIME_EXT, mime);
}

function normalizePrefix(prefix) {
  const p = String(prefix || 'gallery').replace(/[^a-z0-9_-]/gi, '').toLowerCase();
  return PREFIXES.includes(p) ? p : 'gallery';
}

function makeKey(prefix, mime) {
  const ext = extForMime(mime) || '.bin';
  return `${normalizePrefix(prefix)}/${crypto.randomUUID()}${ext}`;
}

/**
 * Key for a work-log image. These are served only through
 * /api/workimages/:filename, which checks per-work-log authorization, so they
 * must not be reachable from the public bucket. When a private bucket is
 * configured the object goes there; otherwise it falls back to the public
 * bucket under the private prefix and stays subject to the same API checks.
 */
function makePrivateKey(mime) {
  const ext = extForMime(mime) || '.bin';
  return `${PRIVATE_PREFIX}/${crypto.randomUUID()}${ext}`;
}

function publicUrl(key) {
  if (!key) return '';
  return `${config.publicUrl}/${key}`;
}

function keyFromUrl(url) {
  if (!config.publicUrl) return '';
  const prefix = `${config.publicUrl}/`;
  const u = String(url || '');
  if (u.startsWith(prefix)) return u.slice(prefix.length);
  return '';
}

function isR2Url(url) {
  return Boolean(keyFromUrl(url));
}

function isPrivateKey(key) {
  return String(key || '').startsWith(`${PRIVATE_PREFIX}/`);
}

async function upload({ key, mime, body }) {
  if (!enabled || !client) throw new Error('R2 storage is not configured');
  await client.send(
    new PutObjectCommand({
      Bucket: bucketForKey(key),
      Key: key,
      Body: body,
      ContentType: mime,
    })
  );
}

async function remove(key) {
  if (!enabled || !client || !key) return;
  await client.send(new DeleteObjectCommand({ Bucket: bucketForKey(key), Key: key }));
}

async function getStream(key) {
  if (!enabled || !client) throw new Error('R2 storage is not configured');
  const res = await client.send(new GetObjectCommand({ Bucket: bucketForKey(key), Key: key }));
  return {
    stream: res.Body,
    contentType: res.ContentType,
    contentLength: res.ContentLength,
  };
}

module.exports = {
  config,
  enabled,
  privateEnabled,
  PRIVATE_PREFIX,
  MIME_EXT,
  VALID_MIMES,
  PREFIXES,
  extForMime,
  isValidMime,
  normalizePrefix,
  makeKey,
  makePrivateKey,
  isPrivateKey,
  publicUrl,
  keyFromUrl,
  isR2Url,
  upload,
  remove,
  getStream,
};