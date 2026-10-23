import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTrackerSyncTicker } from './hooks/useTrackerSync.js';
import { useAuth } from './auth/AuthContext.jsx';

function todayLabel() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function todayShortLabel() {
  return new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export default function App() {
  // Run the daily reconciler while the app is open. Pulls FINAL games
  // from ESPN, matches them to locked predictions, and appends graded
  // rows into the Tracker.
  useTrackerSyncTicker();

  const { status, user, logout } = useAuth();
  const navigate = useNavigate();
  const isAuthed = status === 'authenticated';

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app">
      <header className="nav">
        <div className="nav-inner">
          <Link to="/" className="brand" aria-label="Home — No Way It Hits">
            <span className="brand-name">NO WAY <span className="brand-break"/>IT HITS</span>
            <span className="brand-tag">Daily Blowout Predictor</span>
          </Link>
          {/* Nav links are only relevant once the user is logged in —
              they all point to protected routes that would bounce back
              to /login otherwise. Hiding them keeps the auth pages
              uncluttered. */}
          {isAuthed && (
            <nav className="nav-links">
              <NavLink to="/predictions" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                Predictions
              </NavLink>
              <NavLink to="/tracker" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                Tracker
              </NavLink>
            </nav>
          )}
          <div className="nav-spacer" />
          {isAuthed && (
            <div className="nav-auth">
              <span className="nav-auth-who" title={user?.email || ''}>
                {user?.isAdmin ? 'Admin' : (user?.email || '—')}
              </span>
              <button type="button" className="nav-auth-logout" onClick={handleLogout}>
                Log out
              </button>
            </div>
          )}
          <div className="nav-date">
            <span className="nav-date-full">{todayLabel()}</span>
            <span className="nav-date-short">{todayShortLabel()}</span>
          </div>
        </div>
      </header>

      <main>
        <Outlet />
      </main>

      <footer>
        No Way It Hits · Live model projections vs. sportsbooks
      </footer>
    </div>
  );
}
