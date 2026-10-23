// Hook that returns a fetch wrapper which:
//   1. Attaches `Authorization: Bearer <token>` if a token exists.
//   2. Calls logout() on 401 so the route guard can redirect to /login.
//
// Use from inside React components / other hooks. Non-component utility
// modules should accept the wrapper as a parameter (see trackerSync.js).

import { useCallback } from 'react';
import { useAuth } from './AuthContext.jsx';

export function useFetchWithAuth() {
  const { token, logout } = useAuth();

  return useCallback(async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (token) headers.set('authorization', `Bearer ${token}`);
    const res = await fetch(url, { ...options, headers, mode: 'cors' });
    if (res.status === 401) {
      // Token rejected — clear local state. The route guard at Step 7
      // observes status==='unauthenticated' and bounces to /login.
      logout();
    }
    return res;
  }, [token, logout]);
}
