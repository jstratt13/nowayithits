// ─────────────────────────────────────────────────────────────────────────
//  Web Push sender — pure WebCrypto, no dependencies (Workers-compatible).
//
//    • VAPID (RFC 8292): ES256-signed JWT identifying this server to the
//      browser's push service (Apple / Google / Mozilla).
//    • Payload encryption (RFC 8291, "aes128gcm"): the notification body is
//      encrypted to the subscriber's browser key, so the push service can't
//      read it.
//
//  Keys: one worker secret, VAPID_JWK = the P-256 private key as a JWK
//  (contains x, y, d). The public key the browser needs is derived from x/y.
//  Generate with `node scripts/gen-vapid.mjs` (see that file).
// ─────────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

export function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64url(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Uncompressed P-256 public key (0x04 || X || Y) from the JWK — this is the
// "applicationServerKey" the browser subscribes with.
export function vapidPublicKey(jwk) {
  return b64url(concat(new Uint8Array([4]), unb64url(jwk.x), unb64url(jwk.y)));
}

async function vapidAuthHeader(endpoint, jwk, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject,
  })));
  const key = await crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'], ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto returns raw r||s (64 bytes) — exactly what JWS ES256 wants.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${vapidPublicKey(jwk)}`;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// RFC 8291 encryption, single record. Returns the request body.
export async function encryptPayload(subscription, plaintext, { salt, asKeys } = {}) {
  const uaPublic = unb64url(subscription.keys.p256dh);   // 65 bytes
  const authSecret = unb64url(subscription.keys.auth);   // 16 bytes
  salt = salt || crypto.getRandomValues(new Uint8Array(16));
  const as = asKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const record = concat(typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext, new Uint8Array([2])); // 0x02 = last record
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));

  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// Send one notification. Returns { ok, status, gone } — gone = the
// subscription is dead (404/410) and should be deleted.
export async function sendPush(subscription, payload, { jwk, subject, ttl = 3600, urgency = 'high' }) {
  const body = await encryptPayload(subscription, JSON.stringify(payload));
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthHeader(subscription.endpoint, jwk, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
