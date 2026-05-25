import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import Home from './pages/Home.jsx';
import Predictions from './pages/Predictions.jsx';
import Tracker from './pages/Tracker.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HashRouter>
      <Routes>
        <Route element={<App />}>
          {/* Root URL → Home. Predictions and Tracker are reached via the
              nav links; brand wordmark in the header is also a link back
              here so users can always get home with one click. */}
          <Route index element={<Home />} />
          <Route path="/predictions" element={<Predictions />} />
          <Route path="/tracker" element={<Tracker />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  </StrictMode>,
);
