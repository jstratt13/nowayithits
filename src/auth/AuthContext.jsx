// React context for the auth session.
//
// Exposes:
//   token      — JWT string, or null when not logged in
//   user       — { email, isAdmin } from /auth/me, or null
//   status     — 'loading' | 'authenticated' | 'unauthenticated'
//   login(token, user)  — persist + flip to authenticated
//   logout()            — clear + flip to unauthenticated
//
// Token persistence: localStorage under STORAGE_KEY. On mount we re-
// validate the saved token by hitting /auth/me; a 401 means it expired
// or the server's JWT_SECRET rotated, so we log out silently.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const STORAGE_KEY = 'nwih-auth-v1';
const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';

const AuthContext = createContext(null);

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveToStorage(data) {
  try {
    if (data) localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* quota / disabled */ }
}

export function AuthProvider({ children }) {
  // Hydrate synchronously from localStorage so the UI doesn't flash
  // through an "unauthenticated" frame on every page load.
  //
  //   no saved token         → 'unauthenticated' (final)
  //   saved + no WORKER_URL  → 'authenticated'   (final — local dev, can't validate)
  //   saved + WORKER_URL     → 'loading'         (effect re-validates via /auth/me)
  const [state, setState] = useState(() => {
    const saved = loadFromStorage();
    if (saved?.token) {
      return {
        token: saved.token,
        user: saved.user || null,
        status: WORKER_URL ? 'loading' : 'authenticated',
      };
    }
    return { token: null, user: null, status: 'unauthenticated' };
  });

  // Re-validate any restored token against /auth/me. If the worker rejects
  // (token expired, JWT_SECRET rotated, account deleted), we log out
  // silently and the route guard pushes the user to /login.
  useEffect(() => {
    // Only validate when we actually have a token AND a worker to ask.
    // The other two cases are already terminal per the initializer.
    if (!state.token || !WORKER_URL) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${WORKER_URL}/auth/me`, {
          headers: { authorization: `Bearer ${state.token}` },
        });
        if (cancelled) return;
        if (!res.ok) {
          saveToStorage(null);
          setState({ token: null, user: null, status: 'unauthenticated' });
          return;
        }
        const body = await res.json();
        const user = body?.user || null;
        saveToStorage({ token: state.token, user, savedAt: Date.now() });
        setState({ token: state.token, user, status: 'authenticated' });
      } catch {
        // Network error — keep the cached state. The next gated fetch
        // will surface a 401 if the token is really stale.
        if (!cancelled) setState((s) => ({ ...s, status: 'authenticated' }));
      }
    })();
    return () => { cancelled = true; };
    // Intentionally one-shot — we only validate on the initial token we
    // hydrated with. After that, login()/logout() manage state directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback((token, user) => {
    saveToStorage({ token, user, savedAt: Date.now() });
    setState({ token, user, status: 'authenticated' });
  }, []);

  const logout = useCallback(() => {
    saveToStorage(null);
    setState({ token: null, user: null, status: 'unauthenticated' });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// Hook lives in the same file as the provider so context internals stay
// private — the same pattern React's own docs use. The Vite Fast Refresh
// rule prefers component-only files, but splitting just for that costs
// more clarity than it saves.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
