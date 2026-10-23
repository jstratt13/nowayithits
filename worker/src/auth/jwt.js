// HS256 JWT sign + verify. Stateless session token format.
//
// Format:
//   base64url(header) . base64url(payload) . base64url(signature)
//   header  = {"alg":"HS256","typ":"JWT"}
//   payload = caller-supplied claims (we use sub=email, isAdmin=bool, exp=sec)
//   signature = HMAC-SHA256( "header.payload", secret )
//
// Why not use a JWT library:
//   The spec is tiny and the Workers runtime has the crypto primitives
//   built in. Importing jose or jsonwebtoken would add bundle weight and
//   audit surface for what amounts to a hundred lines of code.
//
// Verification semantics:
//   - Returns the decoded payload on success.
//   - Returns null on any failure (bad format, bad signature, expired).
//   - NEVER throws on bad input — callers can treat null as "no auth".

import {
  base64urlEncode,
  base64urlDecode,
  constantTimeEqualBytes,
} from './crypto.js';

const HEADER_JSON = '{"alg":"HS256","typ":"JWT"}';
const HEADER_B64 = base64urlEncode(new TextEncoder().encode(HEADER_JSON));

async function importHmacKey(secret) {
  return await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function hmacSign(input, secret) {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(input)
  );
  return new Uint8Array(sig);
}

// signJwt — assemble + sign. `payload.exp` (seconds-since-epoch) is
// optional; callers can leave it off for non-expiring service tokens,
// but our login flow always sets a 7-day expiry.
export async function signJwt(payload, secret) {
  if (!secret) throw new Error('signJwt: missing secret');
  const payloadB64 = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(payload))
  );
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const sig = await hmacSign(signingInput, secret);
  return `${signingInput}.${base64urlEncode(sig)}`;
}

// verifyJwt — decode + check signature + check expiry. Returns the
// payload object on success, null otherwise. No throws.
export async function verifyJwt(token, secret) {
  if (typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  // Header sanity — we only accept the exact HS256 header we emit.
  if (headerB64 !== HEADER_B64) return null;

  const signingInput = `${headerB64}.${payloadB64}`;
  let providedSig;
  try {
    providedSig = base64urlDecode(sigB64);
  } catch {
    return null;
  }
  const expectedSig = await hmacSign(signingInput, secret);
  if (!constantTimeEqualBytes(expectedSig, providedSig)) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
  } catch {
    return null;
  }

  if (typeof payload.exp === 'number') {
    if (payload.exp * 1000 < Date.now()) return null;
  }

  return payload;
}

// Convenience for callers that want to compute an expiry timestamp.
export function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}
