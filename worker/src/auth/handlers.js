// Auth route handlers — wired into worker/src/index.js by the auth router.
//
// Routes:
//   POST /auth/signup   { email, password }         → 200 { ok, message, verifyToken? }
//   GET  /auth/verify?token=<hex>                   → 200 { ok, message }
//   POST /auth/login    { email, password }         → 200 { ok, token, user }
//   GET  /auth/me       (Authorization: Bearer …)   → 200 { ok, user }
//
// JSON responses are intentionally vague on auth failures — login returns
// the same "invalid credentials" message whether the email is unknown or
// the password is wrong, so the response time + body never confirm or
// deny that an email is registered.

import {
  generateSalt,
  hashPassword,
  verifyPassword,
  generateRandomToken,
} from './crypto.js';
import { signJwt, verifyJwt, nowEpochSeconds } from './jwt.js';
import {
  normalizeEmail,
  getUser,
  putUser,
  userExists,
} from './users.js';
import {
  isAdminIdentifier,
  verifyAdminPassword,
} from './admin.js';
import { isValidEmail, readJsonBody, checkLoginRateLimit } from './util.js';
import { sendVerificationEmail } from './email.js';

// Session token lifetime.
const JWT_EXPIRY_S = 7 * 24 * 60 * 60;

// Verification link lifetime + corresponding KV TTL.
const VERIFY_TOKEN_TTL_S = 24 * 60 * 60;

// Helpers to build JSON responses with shared CORS headers. Mirrors the
// json/err shape from worker/src/index.js so the auth surface looks
// indistinguishable from the rest of the API.
function json(body, init = {}, corsHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders,
      ...(init.headers || {}),
    },
  });
}
function err(message, status = 500, corsHeaders = {}) {
  return json({ ok: false, error: message }, { status }, corsHeaders);
}

// ── POST /auth/signup ────────────────────────────────────────────────────
//
// Creates an unverified user. Stores the verify token in a SEPARATE KV
// key (`verify:<token>` → `{email, exp}`) so the email doesn't have to
// appear in the verify link, and the user record stays minimal.
//
// Returns `verifyToken` in the JSON body only when RESEND_API_KEY is
// unset — that's the Step 2 testing shortcut. Once Step 3 lands and
// emails actually send, the token is omitted from the response.
export async function handleSignup(request, env, cors) {
  if (request.method !== 'POST') return err('method not allowed', 405, cors);

  const body = await readJsonBody(request);
  if (!body) return err('invalid json body', 400, cors);

  const email = normalizeEmail(body.email);
  const password = body.password;

  // Admin collision check runs FIRST. The admin identifier may not be a
  // valid email format (e.g. "1323"), so checking email validity first
  // would short-circuit with a 400 instead of the semantically correct
  // 409. Either response refuses the signup, but 409 matches the regular
  // duplicate-email path.
  if (isAdminIdentifier(env, email)) {
    return err('email already in use', 409, cors);
  }

  if (!isValidEmail(email)) return err('invalid email', 400, cors);
  if (typeof password !== 'string' || password.length < 8) {
    return err('password must be at least 8 characters', 400, cors);
  }

  if (await userExists(env, email)) {
    return err('email already in use', 409, cors);
  }

  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);

  await putUser(env, {
    email,
    passwordHash,
    salt,
    verified: false,
    createdAt: Date.now(),
  });

  const verifyToken = generateRandomToken(32);
  const exp = Date.now() + VERIFY_TOKEN_TTL_S * 1000;
  await env.CACHE.put(
    `verify:${verifyToken}`,
    JSON.stringify({ email, exp }),
    { expirationTtl: VERIFY_TOKEN_TTL_S }
  );

  // Best-effort send. Errors are logged inside the wrapper; we don't
  // fail the signup over a transient email-delivery problem.
  await sendVerificationEmail(env, email, verifyToken);

  // Reveal the token in the response only when no email provider is
  // configured. Once RESEND_API_KEY is set, the verify token lives only
  // in the email + the KV record — never in the HTTP response.
  const includeTokenInResponse = !env.RESEND_API_KEY;
  return json({
    ok: true,
    message: 'Account created. Check your email to verify.',
    ...(includeTokenInResponse ? { verifyToken } : {}),
  }, {}, cors);
}

// ── GET /auth/verify?token=… ─────────────────────────────────────────────
//
// Idempotent: re-clicking a verify link after success is a no-op (the
// verify key is already gone). Expired tokens return the same error
// shape as bad tokens so attackers can't probe expiry timing.
export async function handleVerify(request, env, url, cors) {
  if (request.method !== 'GET') return err('method not allowed', 405, cors);

  const token = url.searchParams.get('token');
  if (!token) return err('missing token', 400, cors);

  const record = env.CACHE
    ? await env.CACHE.get(`verify:${token}`, { type: 'json' })
    : null;

  if (!record || typeof record.email !== 'string' || record.exp < Date.now()) {
    return err('invalid or expired token', 400, cors);
  }

  const user = await getUser(env, record.email);
  if (!user) {
    // User got deleted between signup and verify — treat as invalid.
    await env.CACHE.delete(`verify:${token}`);
    return err('invalid or expired token', 400, cors);
  }

  if (!user.verified) {
    await putUser(env, { ...user, verified: true });
  }
  await env.CACHE.delete(`verify:${token}`);

  return json({ ok: true, message: 'Email verified. You can now log in.' }, {}, cors);
}

// ── POST /auth/login ────────────────────────────────────────────────────
//
// Single field labeled "Email" on the frontend. Admin-identifier check
// runs FIRST so a non-email admin value like "1323" doesn't get rejected
// by the email-format guard. Other users have no way to tell from the
// outside that an admin path exists.
export async function handleLogin(request, env, cors) {
  if (request.method !== 'POST') return err('method not allowed', 405, cors);

  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await checkLoginRateLimit(env, ip);
  if (!rl.allowed) {
    return err('too many login attempts, try again in a minute', 429, cors);
  }

  const body = await readJsonBody(request);
  if (!body) return err('invalid json body', 400, cors);

  const identifier = String(body.email || '').trim();
  const password = String(body.password || '');

  const expSeconds = nowEpochSeconds() + JWT_EXPIRY_S;

  // ── Admin path ────────────────────────────────────────────────
  if (isAdminIdentifier(env, identifier)) {
    if (!(await verifyAdminPassword(env, password))) {
      return err('invalid credentials', 401, cors);
    }
    if (!env.JWT_SECRET) {
      return err('server misconfigured: JWT_SECRET unset', 500, cors);
    }
    const adminEmail = String(env.ADMIN_EMAIL).toLowerCase();
    const token = await signJwt(
      { sub: adminEmail, isAdmin: true, exp: expSeconds },
      env.JWT_SECRET
    );
    return json(
      { ok: true, token, user: { email: adminEmail, isAdmin: true } },
      {},
      cors
    );
  }

  // ── User path ─────────────────────────────────────────────────
  const email = normalizeEmail(identifier);
  if (!isValidEmail(email)) return err('invalid credentials', 401, cors);

  const user = await getUser(env, email);
  if (!user) return err('invalid credentials', 401, cors);

  // Verify before checking password so unverified accounts don't get a
  // 401 vs 403 timing distinction the attacker can exploit. Hash check
  // runs unconditionally to keep timing similar across the two paths.
  const passwordOk = await verifyPassword(password, user.salt, user.passwordHash);
  if (!user.verified) {
    return err('please verify your email before logging in', 403, cors);
  }
  if (!passwordOk) return err('invalid credentials', 401, cors);

  if (!env.JWT_SECRET) {
    return err('server misconfigured: JWT_SECRET unset', 500, cors);
  }
  const token = await signJwt(
    { sub: email, isAdmin: false, exp: expSeconds },
    env.JWT_SECRET
  );
  return json(
    { ok: true, token, user: { email, isAdmin: false } },
    {},
    cors
  );
}

// ── GET /auth/me ────────────────────────────────────────────────────────
//
// Returns the JWT payload's user info. Used by the frontend to
// hydrate the AuthContext on page load when a token is in localStorage.
export async function handleMe(request, env, cors) {
  if (request.method !== 'GET') return err('method not allowed', 405, cors);

  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer (.+)$/i);
  if (!m) return err('missing or malformed authorization header', 401, cors);

  if (!env.JWT_SECRET) {
    return err('server misconfigured: JWT_SECRET unset', 500, cors);
  }

  const payload = await verifyJwt(m[1], env.JWT_SECRET);
  if (!payload) return err('invalid or expired token', 401, cors);

  return json(
    { ok: true, user: { email: payload.sub, isAdmin: !!payload.isAdmin } },
    {},
    cors
  );
}

// ── Router dispatch ─────────────────────────────────────────────────────
//
// Called from worker/src/index.js. Returns a Response if the path matches
// an auth route, or null to let the main router try its own routes.
export async function handleAuthRoute(request, env, url, parts, cors) {
  if (parts[0] !== 'auth') return null;
  switch (parts[1]) {
    case 'signup': return handleSignup(request, env, cors);
    case 'verify': return handleVerify(request, env, url, cors);
    case 'login':  return handleLogin(request, env, cors);
    case 'me':     return handleMe(request, env, cors);
    default:       return err('not found', 404, cors);
  }
}
