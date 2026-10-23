// Password hashing + base64 utilities for the worker auth stack.
//
// All primitives use Web Crypto SubtleCrypto, which is available natively
// in the Workers runtime (and modern Node). No deps, no WASM.
//
// Password hashing:
//   PBKDF2(SHA-256) with 100k iterations and a 16-byte random salt.
//   Output is a 32-byte derived key, stored alongside the salt as base64.
//   Both values land in Worker Secrets (for the admin) or KV (for users).
//
// Why PBKDF2 and not argon2/bcrypt:
//   - Native in Web Crypto → zero dependencies, zero WASM, zero bundle bloat.
//   - 100k iterations is the OWASP 2023 floor for PBKDF2-SHA256 and runs
//     in ~30–80ms in the Workers runtime, which is fine for login latency.
//   - Stronger memory-hard hashes (argon2id) are better in theory but
//     would add a WASM module just for this; not worth it for a single-
//     dev project's threat model.

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

// ── Base64 helpers ──────────────────────────────────────────────────────

export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// JWTs and URL-embedded tokens use base64url (RFC 4648 §5).
export function base64urlEncode(bytes) {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return base64ToBytes(s);
}

// ── Password hashing ────────────────────────────────────────────────────

export function generateSalt() {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return bytesToBase64(salt);
}

export async function hashPassword(password, saltB64) {
  const salt = base64ToBytes(saltB64);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password)),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    HASH_BITS
  );
  return bytesToBase64(new Uint8Array(derivedBits));
}

// Constant-time string compare. Important so the time it takes to reject
// a wrong password doesn't leak which characters matched. The two-pass
// length check is fine to leak (length is not the secret).
function constantTimeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function verifyPassword(password, saltB64, expectedHashB64) {
  if (!password || !saltB64 || !expectedHashB64) return false;
  const computed = await hashPassword(password, saltB64);
  return constantTimeEqualStr(computed, expectedHashB64);
}

export function constantTimeEqualBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

// ── Random tokens (verify links, password resets, etc.) ─────────────────

export function generateRandomToken(bytes = 32) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  // hex is fine for URL embedding and easy to log/debug. 32 bytes = 64
  // hex chars = ample entropy.
  return [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
}
