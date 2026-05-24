import { NavLink, Outlet } from 'react-router-dom';
import { useTrackerSyncTicker } from './hooks/useTrackerSync.js';

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

  return (
    <div className="app">
      <header className="nav">
        <div className="nav-inner">
          <div className="brand">
            <span className="brand-name">NO WAY <span className="brand-break"/>IT HITS</span>
            <span className="brand-tag">Daily Blowout Predictor</span>
          </div>
          <nav className="nav-links">
            <NavLink to="/predictions" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
              Predictions
            </NavLink>
            <NavLink to="/tracker" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
              Tracker
            </NavLink>
          </nav>
          <div className="nav-spacer" />
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
