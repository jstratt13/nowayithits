// Route guards. Used in main.jsx as layout routes so they wrap any
// number of child routes without per-element boilerplate.
//
//   <Route element={<RequireAuth />}>...</Route>
//     — children render only when status === 'authenticated'.
//     — otherwise → redirect to /login, preserving the original
//       destination in location.state.from so the login page can
//       send the user back where they were trying to go.
//
//   <Route element={<RedirectIfAuth />}>...</Route>
//     — children render only when NOT authenticated. Used to wrap
//       /login + /signup so an already-logged-in user can't see them.
//
// During `status === 'loading'` (initial /auth/me validation on page
// load with a stored token) we render nothing — avoids a 100ms flash
// of /login during a refresh on a protected page.

import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';

export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return null;

  if (status === 'unauthenticated') {
    // Remember where the user was heading. Login.jsx reads this from
    // location.state.from and navigates there on successful login.
    const from = location.pathname + location.search + location.hash;
    return <Navigate to="/login" replace state={{ from }} />;
  }

  return <Outlet />;
}

export function RedirectIfAuth() {
  const { status } = useAuth();

  if (status === 'loading') return null;
  if (status === 'authenticated') return <Navigate to="/" replace />;

  return <Outlet />;
}
