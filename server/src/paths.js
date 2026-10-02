const path = require('path');

/**
 * Filesystem locations used by the app.
 *
 * The defaults keep local development and single-server deployments byte-for-byte
 * identical to before (server/data, server/uploads).
 *
 * On Vercel the application directory is read-only, so these must be pointed at a
 * writable path (typically /tmp/data and /tmp/uploads) via the DATA_DIR and
 * UPLOADS_DIR environment variables. UPLOADS_DIR matters because multer stages
 * every upload on local disk before it is pushed to R2.
 *
 * Nothing written under these paths is durable on Vercel: it is per-instance and
 * discarded on redeploy. Durable media lives in R2 (object_key); the SQLite file
 * does not survive and requires a managed database.
 */
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

const uploadsDir = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, '..', 'uploads');

module.exports = {
  dataDir,
  uploadsDir,
  workDir: path.join(uploadsDir, 'work'),
  dbFile: path.join(dataDir, 'avtoservis.db'),
  secretFile: path.join(dataDir, 'secret.key'),
};
