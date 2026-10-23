// User store, backed by the existing CACHE KV namespace.
//
// Key layout:
//   user:<lowercased-email>   → JSON user record
//
// The user record shape:
//   {
//     email:           "lowercased",
//     passwordHash:    base64(PBKDF2 output),
//     salt:            base64(16-byte random salt),
//     verified:        boolean,
//     verifyToken:     hex-string-64-chars | null,
//     verifyTokenExp:  ms-since-epoch       | null,
//     createdAt:       ms-since-epoch,
//   }
//
// Sharing KV with predictions is fine — both are namespaced by key
// prefix (`predictions:*`, `teams:*`, `user:*`) and there's no collision
// risk. KV free tier: 100k reads/day + 1k writes/day = comfortably enough
// for a small-audience login flow.

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function userKey(email) {
  return `user:${normalizeEmail(email)}`;
}

export async function getUser(env, email) {
  if (!env.CACHE) return null;
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return await env.CACHE.get(`user:${normalized}`, { type: 'json' });
}

export async function putUser(env, user) {
  if (!env.CACHE) throw new Error('putUser: CACHE binding missing');
  const record = { ...user, email: normalizeEmail(user.email) };
  await env.CACHE.put(userKey(record.email), JSON.stringify(record));
  return record;
}

export async function deleteUser(env, email) {
  if (!env.CACHE) return;
  await env.CACHE.delete(userKey(email));
}

// Cheap existence check that avoids parsing the full record. Same KV cost
// as getUser (KV doesn't have a HEAD op), but skips a JSON parse on the
// signup hot path.
export async function userExists(env, email) {
  if (!env.CACHE) return false;
  const raw = await env.CACHE.get(userKey(email));
  return raw != null;
}
