const path = require('path');
const fs = require('fs');

const dirs = ['data', 'uploads'];

for (const dir of dirs) {
  const p = path.join(__dirname, '..', dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

const secretFile = path.join(__dirname, '..', 'data', 'secret.key');
if (!fs.existsSync(secretFile)) {
  const secret = require('crypto').randomBytes(48).toString('hex');
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  console.log('[setup] JWT secret generated');
}

console.log('[setup] directories and secret ready');