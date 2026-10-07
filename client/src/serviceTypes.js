/**
 * The live service catalogue for the selects: the same `services` rows that
 * /admin/services edits, read from GET /admin/worklogs/services.
 *
 * `serviceCatalog.js` next door stays the bundled, JSX-free description of the
 * shop's baseline six -- what a first paint and a failed request fall back to.
 * This module is the half that can change while the app is running: the admin
 * adds "Mator Ochish" on one screen and the work-log form has to offer it on
 * the next without a deploy.
 *
 * Request handling is deliberately dull but shared:
 *
 *   * one in-flight request at a time -- the work-log filter, the "Yangi ish"
 *     modal and the debt picker can all ask at once, and they get one round trip
 *     between them rather than three;
 *   * a successful answer is cached for the rest of the session, so opening the
 *     debt form after the work-log form costs nothing;
 *   * `fresh` bypasses that cache, which is what makes the work-log modal refetch
 *     every time it opens -- that is the point of the screen, an admin who has
 *     just added a service expects to see it on the next open;
 *   * a failed answer keeps whatever was last known instead of blanking it, and
 *     leaves the error for the caller to show.
 */

import { useEffect, useState } from 'react';
import { api } from './api';

let cached = null;
let inflight = null;

/** @returns {Promise<string[]>} active service names, in catalogue order */
export function loadServiceTypes({ fresh = false } = {}) {
  if (inflight) return inflight;
  if (cached && !fresh) return Promise.resolve(cached);
  inflight = api
    .get('/worklogs/services')
    .then(({ services }) => {
      cached = (services || []).map((s) => s.name);
      return cached;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * The catalogue as React state.
 *
 * @param {boolean} fresh refetch on mount even when a cached answer exists
 * @param {string[] | null} fallback seed used until the first answer arrives;
 *   left out (null) when the caller wants a real loading state instead
 * @returns {{
 *   names: string[] | null, loading: boolean, error: string,
 *   reload: () => void,
 * }}
 */
export function useServiceTypes({ fresh = false, fallback = null } = {}) {
  const [state, setState] = useState({ names: fallback, loading: true, error: '' });
  // Anything above 0 means the operator asked for a reload, and a reload always
  // goes back to the server rather than re-reading the cache it came from.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: '' }));
    loadServiceTypes({ fresh: fresh || attempt > 0 })
      .then((names) => {
        if (alive) setState({ names, loading: false, error: '' });
      })
      .catch((err) => {
        if (alive) {
          setState((s) => ({
            names: s.names,
            loading: false,
            error: (err && err.message) || "Xizmatlar ro'yxatini yuklab bo'lmadi",
          }));
        }
      });
    return () => {
      alive = false;
    };
  }, [fresh, attempt]);

  return { ...state, reload: () => setAttempt((a) => a + 1) };
}
