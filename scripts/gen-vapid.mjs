// Generate the VAPID key pair for push alerts and print the PRIVATE key as
// a JWK on stdout, so it can be piped straight into the worker secret
// without ever being saved to disk or shown on screen:
//
//   node scripts/gen-vapid.mjs | (cd worker && npx wrangler secret put VAPID_JWK)
//
// Run it ONCE. Re-running replaces the key and every phone has to turn
// alerts on again. The public key (what browsers subscribe with) is derived
// from this by the worker and served at GET /push/key.
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
process.stdout.write(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }));
process.stderr.write('VAPID key generated (private JWK written to stdout).\n');
