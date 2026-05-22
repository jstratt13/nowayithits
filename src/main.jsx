import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import Predictions from './pages/Predictions.jsx';
import Tracker from './pages/Tracker.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HashRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<Navigate to="/predictions" replace />} />
          <Route path="/predictions" element={<Predictions />} />
          <Route path="/tracker" element={<Tracker />} />
          <Route path="*" element={<Navigate to="/predictions" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  </StrictMode>,
);
