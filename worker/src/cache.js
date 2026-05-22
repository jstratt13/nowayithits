// Tiny KV-backed cache so we don't hammer upstream sites on every page load.
// If the CACHE binding isn't set (e.g. during local dev without KV), we just
// pass through to the fetcher.

export async function cached(env, key, ttlSeconds, fetcher) {
  if (!env.CACHE) return fetcher();

  try {
    const hit = await env.CACHE.get(key, { type: 'json' });
    if (hit) return hit;
  } catch {
    // KV read failed — fall through and refetch
  }

  const fresh = await fetcher();
  try {
    await env.CACHE.put(key, JSON.stringify(fresh), { expirationTtl: ttlSeconds });
  } catch {
    // KV write failed — return fresh anyway
  }
  return fresh;
}
