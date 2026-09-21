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

    const hexToRgb = (hex) => {
      const m = (hex || '').replace('#', '');
      if (m.length === 3) return `${parseInt(m[0] + m[0], 16)} ${parseInt(m[1] + m[1], 16)} ${parseInt(m[2] + m[2], 16)}`;
      if (m.length === 6) return `${parseInt(m.slice(0, 2), 16)} ${parseInt(m.slice(2, 4), 16)} ${parseInt(m.slice(4, 6), 16)}`;
      return '225 29 46';
    };
    root.style.setProperty('--c-primary', hexToRgb(d.primary_color));
    root.style.setProperty('--c-secondary', hexToRgb(d.secondary_color || '#0f1722'));
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