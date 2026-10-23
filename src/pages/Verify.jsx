// Verify page — consumed via the link in the verification email
// (#/verify?token=<hex>). Calls /auth/verify and displays the result.
//
// States:
//   missing    — no ?token in the URL (someone hit /verify directly)
//   verifying  — request in flight
//   verified   — 200 from /auth/verify
//   failed     — 400/500 from /auth/verify (bad/expired token)

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';

export default function Verify() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [status, setStatus] = useState(token ? 'verifying' : 'missing');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        if (!WORKER_URL) throw new Error('worker URL not configured');
        const res = await fetch(
          `${WORKER_URL}/auth/verify?token=${encodeURIComponent(token)}`
        );
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok) {
          setStatus('verified');
          setMessage(body.message || 'Email verified. You can now log in.');
        } else {
          setStatus('failed');
          setMessage(body.error || 'This link is invalid or expired.');
        }
      } catch (e) {
        if (cancelled) return;
        setStatus('failed');
        setMessage(e.message || 'Could not reach the server.');
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="auth-page">
      <div className="auth-form">
        <h2 className="auth-title">
          {status === 'verifying' && 'Verifying…'}
          {status === 'verified' && 'Email verified'}
          {status === 'failed' && 'Could not verify'}
          {status === 'missing' && 'Missing token'}
        </h2>

        <p className="auth-prose">
          {status === 'verifying' && 'Hang on a moment.'}
          {status === 'verified' && message}
          {status === 'failed' && message}
          {status === 'missing' && (
            <>This page expects a verification token in the URL. Use the link
            from your verification email, or sign up again if it expired.</>
          )}
        </p>

        <div className="auth-alt">
          {status === 'verified'
            ? <Link to="/login">Continue to log in →</Link>
            : <Link to="/login">Back to log in</Link>}
        </div>
      </div>
    </div>
  );
}
