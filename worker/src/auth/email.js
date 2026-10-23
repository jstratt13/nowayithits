// Resend integration — sends verification emails on signup.
//
// API docs: https://resend.com/docs/api-reference/emails/send-email
//
// Worker env vars:
//   RESEND_API_KEY    — secret. Set via `wrangler secret put`.
//   RESEND_FROM_EMAIL — optional. Defaults to onboarding@resend.dev
//                       (Resend's shared sender for unverified accounts).
//   SITE_URL          — base URL of the frontend, used to build the
//                       verify link in the email body. Defaults to the
//                       current GH Pages deployment if unset.
//
// Free-tier note: Resend without a verified sending domain will silently
// only deliver to the account's own email address. The worker can't tell
// the difference between "sent successfully" and "delivered to recipient" —
// Resend returns 200 either way. Recipients other than the account owner
// will get nothing on the free tier until a sending domain is verified.
//
// Failure semantics: send errors are LOGGED but do NOT fail the signup.
// A user with a created account but no verification email can sign up
// again with a different address, or wait until the email arrives if
// it was just a transient failure. We never log the verify token itself
// (would leak it to whoever has log access).

const RESEND_API = 'https://api.resend.com/emails';

const DEFAULT_FROM = 'onboarding@resend.dev';
const DEFAULT_SITE_URL = 'https://jstratt13.github.io/nowayithits';
const APP_NAME = 'No Way It Hits';

function buildVerifyUrl(env, token) {
  const base = (env.SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '');
  // Frontend uses HashRouter so the verify page lives at #/verify.
  return `${base}/#/verify?token=${encodeURIComponent(token)}`;
}

function buildEmailBody(verifyUrl) {
  return [
    `Welcome to ${APP_NAME}.`,
    '',
    'Click the link below to verify your email and activate your account:',
    verifyUrl,
    '',
    'This link expires in 24 hours.',
    '',
    "If you didn't sign up, you can safely ignore this email.",
  ].join('\n');
}

// sendVerificationEmail returns a structured result so handlers + tests
// can branch on the outcome. Never throws.
//
// Return shape:
//   { ok: true,  id }              — Resend accepted
//   { ok: false, skipped: true }   — RESEND_API_KEY unset (Step 2 mode)
//   { ok: false, status, body }    — Resend returned non-2xx
//   { ok: false, error }           — fetch threw / unreachable
export async function sendVerificationEmail(env, toEmail, verifyToken) {
  if (!env || !env.RESEND_API_KEY) {
    return { ok: false, skipped: true };
  }

  const from = env.RESEND_FROM_EMAIL || DEFAULT_FROM;
  const verifyUrl = buildVerifyUrl(env, verifyToken);
  const payload = {
    from: `${APP_NAME} <${from}>`,
    to: [toEmail],
    subject: `Verify your email — ${APP_NAME}`,
    text: buildEmailBody(verifyUrl),
  };

  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // Capture a short error excerpt for logs, but don't surface to client.
      const body = await res.text().catch(() => '');
      console.warn('[resend] non-2xx', res.status, body.slice(0, 300));
      return { ok: false, status: res.status, body: body.slice(0, 300) };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, id: data.id || null };
  } catch (e) {
    console.warn('[resend] fetch threw', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}
