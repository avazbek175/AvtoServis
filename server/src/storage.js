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

const config = {
  accountId: process.env.R2_ACCOUNT_ID || '',
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  bucket: process.env.R2_BUCKET_NAME || 'avtoservis',
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

async function upload({ key, mime, body }) {
  if (!enabled || !client) throw new Error('R2 storage is not configured');
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: mime,
    })
  );
}

async function remove(key) {
  if (!enabled || !client || !key) return;
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}

async function getStream(key) {
  if (!enabled || !client) throw new Error('R2 storage is not configured');
  const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
  return {
    stream: res.Body,
    contentType: res.ContentType,
    contentLength: res.ContentLength,
  };
}

module.exports = {
  config,
  enabled,
  MIME_EXT,
  VALID_MIMES,
  PREFIXES,
  extForMime,
  isValidMime,
  normalizePrefix,
  makeKey,
  publicUrl,
  keyFromUrl,
  isR2Url,
  upload,
  remove,
  getStream,
};