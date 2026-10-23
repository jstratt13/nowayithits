// Signup page — email + password. On success the worker emails a
// verification link (24h expiry). The user can't log in until they
// click that link.

import { useState } from 'react';
import { Link } from 'react-router-dom';

const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';

export default function Signup() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      if (!WORKER_URL) throw new Error('worker URL not configured');
      const res = await fetch(`${WORKER_URL}/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Signup failed (${res.status})`);
      }
      setSuccess(true);
    } catch (e2) {
      setError(e2.message || 'Signup failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="auth-page">
        <div className="auth-form">
          <h2 className="auth-title">Check your email</h2>
          <p className="auth-prose">
            We sent a verification link to <strong>{email}</strong>. Click it
            within 24 hours to activate your account, then come back here to
            log in.
          </p>
          <div className="auth-alt">
            <Link to="/login">Back to log in</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <h2 className="auth-title">Create an account</h2>

        <label className="auth-field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="email"
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
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            required
          />
          <span className="auth-hint">At least 8 characters.</span>
        </label>

        {error && <div className="auth-error">{error}</div>}

        <button type="submit" className="auth-submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Sign up'}
        </button>

        <div className="auth-alt">
          Already have an account? <Link to="/login">Log in</Link>
        </div>
      </form>
    </div>
  );
}
