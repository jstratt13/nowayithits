import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import Home from './pages/Home.jsx';
import Predictions from './pages/Predictions.jsx';
import Tracker from './pages/Tracker.jsx';
import Updates from './pages/Updates.jsx';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import Verify from './pages/Verify.jsx';
import { AuthProvider } from './auth/AuthContext.jsx';
import { RequireAuth, RedirectIfAuth } from './auth/RouteGuards.jsx';

// Installable app (PWA): register the service worker in production builds
// only — in `npm run dev` it would cache Vite's dev modules and get in the
// way. Scope = the GitHub Pages base (/nowayithits/).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL;
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {});
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <HashRouter>
        <Routes>
          <Route element={<App />}>
            {/* Protected — Home / Predictions / Tracker. Unauth visitors
                are bounced to /login with the original destination saved
                so they land back here after signing in. */}
            <Route element={<RequireAuth />}>
              <Route index element={<Home />} />
              <Route path="/predictions" element={<Predictions />} />
              <Route path="/tracker" element={<Tracker />} />
              <Route path="/updates" element={<Updates />} />
            </Route>

            {/* Auth-only — login / signup. Already-authenticated users
                are bounced back to / so they don't see a redundant form. */}
            <Route element={<RedirectIfAuth />}>
              <Route path="/login" element={<Login />} />
              <Route path="/signup" element={<Signup />} />
            </Route>

            {/* Verify works in either state — a logged-in user might
                still click an old verification link for another account. */}
            <Route path="/verify" element={<Verify />} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
    </AuthProvider>
  </StrictMode>,
);
