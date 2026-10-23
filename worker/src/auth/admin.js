// Admin credential check.
//
// The admin login bypasses the KV user store entirely — admin credentials
// live as Cloudflare Worker secrets set via `wrangler secret put`:
//
//   ADMIN_EMAIL          — admin identifier (can be a literal like "1323",
//                          doesn't have to be a real email). Compared
//                          case-insensitively to whatever the user types
//                          into the login form's email field.
//   ADMIN_PASSWORD_HASH  — base64(PBKDF2(password, salt)) using the same
//                          parameters as crypto.js#hashPassword.
//   ADMIN_SALT           — base64(16-byte random salt) used when hashing.
//
// We don't store admin credentials in KV because secrets are encrypted at
// rest in Cloudflare's control plane and aren't reachable through any KV
// read — even a worker bug that leaks KV contents wouldn't leak the admin
// hash. Conversely, leaking a user's hash from KV would expose only that
// user, not the admin.
//
// The login form renders a single field labeled "Email" — the worker is
// the only place that knows whether the typed value is the admin
// identifier. From the outside, an admin login is indistinguishable from
// a regular user login attempt.

import { verifyPassword } from './crypto.js';

export function isAdminIdentifier(env, value) {
  if (!env || !env.ADMIN_EMAIL) return false;
  return (
    String(value || '').trim().toLowerCase() ===
    String(env.ADMIN_EMAIL).trim().toLowerCase()
  );
}

export async function verifyAdminPassword(env, password) {
  if (!env || !env.ADMIN_PASSWORD_HASH || !env.ADMIN_SALT) return false;
  return await verifyPassword(password, env.ADMIN_SALT, env.ADMIN_PASSWORD_HASH);
}
