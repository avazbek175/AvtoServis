const API = '/api';

async function request(path, options = {}) {
  const opts = {
    credentials: 'include',
    ...options,
    headers: { ...(options.headers || {}) },
  };
  if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }

  const res = await fetch(API + path, opts);
  const contentType = res.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    data = await res.json().catch(() => null);
  }

  if (!res.ok) {
    const err = new Error((data && data.error) || `So'rov xatosi (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request(p),
  // `headers` is for the rare per-request header that is not the session cookie,
  // e.g. the one-time setup secret on POST /auth/setup.
  post: (p, body, headers) => request(p, { method: 'POST', body, headers }),
  put: (p, body) => request(p, { method: 'PUT', body }),
  patch: (p, body) => request(p, { method: 'PATCH', body }),
  del: (p) => request(p, { method: 'DELETE' }),
};