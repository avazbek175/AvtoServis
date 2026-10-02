import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { api } from './api';

const SiteContext = createContext(null);
const AdminContext = createContext(null);

export function AppProvider({ children }) {
  const [settings, setSettings] = useState(null);
  const [services, setServices] = useState([]);
  const [siteLoading, setSiteLoading] = useState(true);
  const [user, setUser] = useState(undefined);
  const [authLoading, setAuthLoading] = useState(true);

  const loadPublic = useCallback(async () => {
    try {
      const [s, sv] = await Promise.all([api.get('/public/settings'), api.get('/public/services')]);
      setSettings(s.settings || {});
      setServices(sv.services || []);
    } catch {
      setSettings({});
      setServices([]);
    } finally {
      setSiteLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPublic();
  }, [loadPublic]);

  useEffect(() => {
    if (!settings) return;
    const d = settings.design || {};
    const site = settings.site || {};
    const root = document.documentElement;

    const hexToRgb = (hex, fallback) => {
      // Values already in `rgb(var(--c-*))` space are written verbatim.
      if (typeof hex === 'string' && hex.startsWith('rgb(')) return hex;
      const raw = typeof hex === 'string' ? hex.trim() : '';
      const m = raw.startsWith('#') ? raw.slice(1) : raw;
      if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(m)) return fallback;
      const short = m.length <= 4;
      const part = (i) => {
        const chunk = short ? m[i] + m[i] : m.slice(i * 2, i * 2 + 2);
        return parseInt(chunk, 16);
      };
      // The alpha byte (#RRGGBBAA) is intentionally ignored: the CSS custom property
      // feeds `rgb(var(--c-primary))`, which has no alpha slot.
      return `${part(0)} ${part(1)} ${part(2)}`;
    };
    root.style.setProperty('--c-primary', hexToRgb(d.primary_color, '225 29 46'));
    root.style.setProperty('--c-secondary', hexToRgb(d.secondary_color, '15 23 34'));
    root.style.setProperty('--font-sans', `'${d.font_family || 'Inter'}', system-ui, sans-serif`);
    const display = d.font_family === 'Manrope' ? 'Manrope' : d.font_family === 'Arial' ? 'Arial' : d.font_family === 'Georgia' ? 'Georgia' : d.font_family;
    root.style.setProperty('--font-heading', `'${display || 'Space Grotesk'}', 'Inter', system-ui, sans-serif`);

    document.title = site.name || 'AvtoServis';

    if (site.favicon) {
      let link = document.querySelector("link[rel='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = site.favicon;
    }
  }, [settings]);

  useEffect(() => {
    api.get('/auth/me')
      .then(({ user: u }) => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  const login = useCallback(async (username, password) => {
    const r = await api.post('/auth/login', { username, password });
    setUser(r.user);
    return r.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
    }
    setUser(null);
  }, []);

  const siteValue = useMemo(
    () => ({ settings, services, siteLoading, reloadPublic: loadPublic }),
    [settings, services, siteLoading, loadPublic]
  );

  const adminValue = useMemo(
    () => ({ user, authLoading, login, logout, setUser }),
    [user, authLoading, login, logout]
  );

  return (
    <AdminContext.Provider value={adminValue}>
      <SiteContext.Provider value={siteValue}>{children}</SiteContext.Provider>
    </AdminContext.Provider>
  );
}

export const useSite = () => useContext(SiteContext);
export const useAdmin = () => useContext(AdminContext);