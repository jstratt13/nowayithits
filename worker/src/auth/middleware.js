// Auth middleware for protecting worker routes.
//
// Usage in the route dispatcher:
//
//   const a = await requireAuth(request, env, CORS);
//   if (!a.ok) return a.response;
//   // a.payload is the verified JWT payload — { sub, isAdmin, exp }
//
// requireAdmin is the same but also rejects 403 when isAdmin isn't true.
//
// Return shape is { ok: true, payload } | { ok: false, response } so the
// caller can short-circuit with `if (!a.ok) return a.response`. Avoiding
// thrown errors here keeps the route dispatcher's control flow linear
// and grep-friendly.

import { verifyJwt } from './jwt.js';

function json(body, init = {}, cors = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...cors,
      ...(init.headers || {}),
    },
  });
}

function err(message, status, cors) {
  return json({ ok: false, error: message }, { status }, cors);
}

export async function requireAuth(request, env, cors) {
  if (!env || !env.JWT_SECRET) {
    return {
      ok: false,
      response: err('server misconfigured: JWT_SECRET unset', 500, cors),
    };
  }

  const header = request.headers.get('authorization') || '';
  const m = header.match(/^Bearer (.+)$/i);
  if (!m) {
    return {
      ok: false,
      response: err('authentication required', 401, cors),
    };
  }

  const payload = await verifyJwt(m[1], env.JWT_SECRET);
  if (!payload) {
    return {
      ok: false,
      response: err('invalid or expired token', 401, cors),
    };
  }

  return { ok: true, payload };
}

export async function requireAdmin(request, env, cors) {
  const r = await requireAuth(request, env, cors);
  if (!r.ok) return r;
  if (!r.payload.isAdmin) {
    return {
      ok: false,
      response: err('admin access required', 403, cors),
    };
  }
  return r;
}
