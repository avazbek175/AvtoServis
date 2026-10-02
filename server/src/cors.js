/**
 * CORS configuration.
 *
 * The API serves session cookies, so cross-origin access must be locked down:
 * `origin: true` (reflect any Origin) combined with `credentials: true` lets any
 * website on the internet make authenticated requests with a visitor's cookie.
 *
 * Rules:
 *  - production: only the origins listed in CLIENT_ORIGIN are allowed. The variable
 *    is mandatory — booting without it is a configuration error, not a silent
 *    "allow everything" fallback.
 *  - development: localhost origins are allowed (Vite dev server on :5173 and any
 *    other local port), so the API can be called directly while developing.
 *  - requests without an Origin header (curl, server-to-server, same-origin) are
 *    always allowed: CORS only governs browser-initiated cross-origin requests.
 */

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:4000',
  'http://127.0.0.1:4000',
];

class ConfigurationError extends Error {}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function parseOriginList(raw) {
  return String(raw || '')
    .split(/[\s,]+/)
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function isLocalhostOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  } catch {
    return false;
  }
}

function resolveAllowedOrigins() {
  const configured = parseOriginList(process.env.CLIENT_ORIGIN);

  if (isProduction()) {
    if (!configured.length) {
      throw new ConfigurationError(
        'CLIENT_ORIGIN is required when NODE_ENV=production. ' +
          'Set it to the public URL of the frontend, e.g. CLIENT_ORIGIN=https://avtoservis.uz'
      );
    }
    return { origins: configured, wildcard: false, localAllowed: false };
  }

  return {
    origins: [...new Set([...DEFAULT_DEV_ORIGINS, ...configured])],
    wildcard: false,
    localAllowed: true,
  };
}

function createCorsOptions() {
  const { origins, localAllowed } = resolveAllowedOrigins();

  const isAllowed = (origin) => {
    const normalized = String(origin).replace(/\/+$/, '');
    if (origins.includes(normalized)) return true;
    return localAllowed && isLocalhostOrigin(origin);
  };

  return {
    isAllowed,
    // Session cookies are sent with `credentials: 'include'`, so the exact origin
    // must be echoed back — a wildcard is not allowed by the browser spec here.
    options: {
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
      origin(origin, callback) {
        // Same-origin / non-browser requests have no Origin header.
        if (!origin) return callback(null, true);
        if (isAllowed(origin)) return callback(null, true);
        // `false` means: serve the request, but do not emit any
        // Access-Control-Allow-Origin header, so the browser refuses to expose the
        // response to the calling page.
        return callback(null, false);
      },
    },
    // Belt and braces: a request that carries a *foreign* Origin is refused before
    // it reaches any handler, instead of relying on the browser to discard the
    // response. Requests without an Origin header are unaffected.
    guard: (req, res, next) => {
      const origin = req.headers.origin;
      if (origin && !isAllowed(origin)) {
        return res.status(403).json({ error: 'CORS: origin not allowed' });
      }
      next();
    },
  };
}

module.exports = { createCorsOptions, resolveAllowedOrigins, ConfigurationError, isLocalhostOrigin };
