// Small shared helpers for the auth handlers — no crypto, no KV.

// Lenient email validation. Not RFC 5322 strict — that's notoriously
// hostile to write and excludes things real mail providers accept. This
// catches typos (missing @, missing TLD, spaces) and lets the actual
// SMTP path decide deliverability.
export function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const e = email.trim();
  if (e.length < 5 || e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Parse a JSON body without throwing on bad input. Auth handlers want
// a clean null on parse failure so they can return 400 instead of 5xx.
export async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// Login rate-limit. KV-backed counter keyed by (ip, minute-bucket).
// Returns { allowed, count }. Soft-allows when KV isn't bound (local
// dev, broken env) so login still works.
//
// Tradeoff: an attacker can exhaust the free-tier 1k-writes/day budget
// by hammering this. Worker fails open — legit logins still work even
// after the budget is gone, just unrate-limited. For a single-dev
// passion project the simplicity wins over the resilience.
const LOGIN_RATE_LIMIT = 5;
const LOGIN_RATE_WINDOW_S = 120; // TTL on the bucket key

export async function checkLoginRateLimit(env, ip) {
  if (!env || !env.CACHE || !ip) return { allowed: true, count: 0 };
  const minute = Math.floor(Date.now() / 60_000);
  const key = `ratelimit:login:${ip}:${minute}`;
  const existing = await env.CACHE.get(key, { type: 'json' });
  const count = (existing?.count || 0) + 1;
  await env.CACHE.put(key, JSON.stringify({ count }), {
    expirationTtl: LOGIN_RATE_WINDOW_S,
  });
  return { allowed: count <= LOGIN_RATE_LIMIT, count };
}
