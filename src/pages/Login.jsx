// Login page — single "Email" field plus password. The field accepts
// regular user emails AND the literal admin identifier (set as the
// ADMIN_EMAIL worker secret). The worker side decides which path to
// take; from the user's perspective it's one form.
//
// On success: persists token via AuthContext + navigates to either the
// original destination (location.state.from from Step 7's route guard)
// or to the home page.

import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      if (!WORKER_URL) throw new Error('worker URL not configured');
      const res = await fetch(`${WORKER_URL}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Login failed (${res.status})`);
      }
      login(body.token, body.user);

      // If we landed here via the route guard, send the user back to
      // wherever they tried to go originally. Otherwise → home.
      const redirectTo = location.state?.from || '/';
      navigate(redirectTo, { replace: true });
    } catch (e2) {
      setError(e2.message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <h2 className="auth-title">Log in</h2>

        <label className="auth-field">
          <span>Email</span>
          <input
            type="text"
            inputMode="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            required
          />
        </label>

        <label className="auth-field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            required
          />
        </label>

        {error && <div className="auth-error">{error}</div>}

        <button type="submit" className="auth-submit" disabled={submitting}>
          {submitting ? 'Logging in…' : 'Log in'}
        </button>

        <div className="auth-alt">
          New here? <Link to="/signup">Create an account</Link>
        </div>
      </form>
    </div>
  );
}
