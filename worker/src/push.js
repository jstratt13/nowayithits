// ─────────────────────────────────────────────────────────────────────────
//  Push alerts (app phase 3): subscriptions, per-device preferences, and
//  sending the change-detection events (events.js) as notifications.
//
//  Storage: ONE KV key, push:subs = [subscription…]. Read once per cron run
//  that produced events; written only when someone subscribes, changes
//  settings, unsubscribes, or a dead subscription is pruned — keeps us far
//  inside the free tier's 1,000 KV writes/day.
//
//  Sending: at most ONE notification per device per cron run (several
//  updates are bundled into a summary), capped at MAX_SENDS_PER_RUN, because
//  every push is a subrequest and the free plan allows 50 per invocation.
//
//  Secrets / vars:
//    VAPID_JWK      (secret) P-256 private key as JWK — scripts/gen-vapid.mjs
//    VAPID_SUBJECT  (optional var) contact for push services; defaults to
//                   the app URL so no personal email is needed.
// ─────────────────────────────────────────────────────────────────────────
import { sendPush, vapidPublicKey } from './webpush.js';

const KEY = 'push:subs';
const MAX_SUBS_PER_USER = 5;
const MAX_SENDS_PER_RUN = 20;
const APP_URL = 'https://jstratt13.github.io/nowayithits/';

export const DEFAULT_PREFS = {
  types: { injury: true, pick_flip: true, line_move: true, edge: true, first_line: false },
  leagues: ['nba', 'wnba'],
  minEdge: 3,            // edge + line-posted alerts only at/above this edge
  quiet: { enabled: false, start: 23, end: 8, tz: 'America/New_York' },
};

function cleanPrefs(p = {}) {
  const d = DEFAULT_PREFS;
  const types = {};
  for (const k of Object.keys(d.types)) types[k] = typeof p.types?.[k] === 'boolean' ? p.types[k] : d.types[k];
  const leagues = Array.isArray(p.leagues) ? p.leagues.filter((l) => l === 'nba' || l === 'wnba') : d.leagues;
  const minEdge = Number.isFinite(+p.minEdge) ? Math.min(10, Math.max(0, +p.minEdge)) : d.minEdge;
  const q = p.quiet || {};
  const hour = (h, fb) => (Number.isInteger(+h) && +h >= 0 && +h <= 23 ? +h : fb);
  let tz = typeof q.tz === 'string' && q.tz.length < 64 ? q.tz : d.quiet.tz;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = d.quiet.tz; }
  return { types, leagues, minEdge, quiet: { enabled: !!q.enabled, start: hour(q.start, d.quiet.start), end: hour(q.end, d.quiet.end), tz } };
}

async function subId(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function readSubs(env) {
  try { return (await env.CACHE.get(KEY, { type: 'json' })) || []; } catch { return []; }
}
async function writeSubs(env, subs) { await env.CACHE.put(KEY, JSON.stringify(subs)); }

function jwkFrom(env) {
  if (!env.VAPID_JWK) return null;
  try { return typeof env.VAPID_JWK === 'string' ? JSON.parse(env.VAPID_JWK) : env.VAPID_JWK; } catch { return null; }
}
const subject = (env) => env.VAPID_SUBJECT || APP_URL;

// ── Which events a device wants ───────────────────────────────────────
function inQuietHours(q, now = new Date()) {
  if (!q?.enabled) return false;
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: q.tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
  return q.start <= q.end ? h >= q.start && h < q.end : h >= q.start || h < q.end;
}
function eventEdge(e) {
  if (e.type === 'edge') return e.data?.edge ?? 0;
  if (e.type === 'first_line') return Math.max(Math.abs(e.data?.sp?.edge ?? 0), Math.abs(e.data?.ou?.edge ?? 0));
  return Infinity;
}
export function filterForPrefs(events, prefs, now = new Date()) {
  if (inQuietHours(prefs.quiet, now)) return [];
  return events.filter((e) =>
    prefs.types[e.type] && prefs.leagues.includes(e.league) && eventEdge(e) >= prefs.minEdge);
}

const ORDER = { injury: 0, pick_flip: 1, edge: 2, line_move: 3, first_line: 4 };
export function buildNotification(events) {
  const evs = [...events].sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9));
  if (evs.length === 1) {
    const e = evs[0];
    return { title: e.title, body: e.body, tag: `${e.gameId}:${e.type}`, url: '#/updates', at: e.at };
  }
  const games = new Set(evs.map((e) => e.gameId)).size;
  return {
    title: `${evs.length} updates · ${games} game${games > 1 ? 's' : ''}`,
    body: evs.slice(0, 3).map((e) => e.title).join('\n') + (evs.length > 3 ? `\n+${evs.length - 3} more` : ''),
    tag: `bundle:${evs[0].at}`, url: '#/updates', at: evs[0].at,
  };
}

// ── Cron: send this run's new events ───────────────────────────────────
export async function dispatchPush(env, events) {
  const jwk = jwkFrom(env);
  if (!events?.length || !jwk || !env.CACHE) return { sent: 0, skipped: !jwk ? 'no VAPID_JWK' : 'no events' };
  const subs = await readSubs(env);
  let sent = 0, pruned = 0, failed = 0;
  const keep = [];
  for (const s of subs) {
    const evs = filterForPrefs(events, s.prefs || DEFAULT_PREFS);
    if (!evs.length || sent >= MAX_SENDS_PER_RUN) { keep.push(s); continue; }
    try {
      const r = await sendPush(s, buildNotification(evs), { jwk, subject: subject(env) });
      if (r.gone) { pruned++; continue; }
      if (r.ok) sent++; else failed++;
    } catch { failed++; }
    keep.push(s);
  }
  if (pruned) await writeSubs(env, keep);
  return { sent, pruned, failed, subs: subs.length };
}

// ── HTTP routes (all require login) ────────────────────────────────────
//   GET  /push/key          → { publicKey }
//   POST /push/subscribe    { subscription, prefs? } → { id, prefs }
//   POST /push/prefs        { endpoint, prefs }      → { prefs }
//   POST /push/unsubscribe  { endpoint }
//   POST /push/test         { endpoint }             → sends a test alert
//   GET  /push/status?endpoint=…                     → { subscribed, prefs }
export async function handlePushRoute(request, env, url, parts, user, respond) {
  const { json, err } = respond;
  const jwk = jwkFrom(env);
  const action = parts[1];

  if (action === 'key' && request.method === 'GET') {
    if (!jwk) return err('push not configured (VAPID_JWK missing)', 503);
    return json({ ok: true, publicKey: vapidPublicKey(jwk) });
  }
  if (action === 'status' && request.method === 'GET') {
    const endpoint = url.searchParams.get('endpoint') || '';
    const s = (await readSubs(env)).find((x) => x.endpoint === endpoint && x.user === user);
    return json({ ok: true, subscribed: !!s, prefs: s?.prefs || DEFAULT_PREFS, configured: !!jwk });
  }
  if (request.method !== 'POST') return err('method not allowed', 405);
  let body;
  try { body = await request.json(); } catch { return err('invalid JSON', 400); }
  const subs = await readSubs(env);

  if (action === 'subscribe') {
    const sub = body.subscription;
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return err('invalid subscription', 400);
    const id = await subId(sub.endpoint);
    const others = subs.filter((x) => x.endpoint !== sub.endpoint);
    const mine = others.filter((x) => x.user === user);
    if (mine.length >= MAX_SUBS_PER_USER) others.splice(others.indexOf(mine[0]), 1); // drop oldest device
    const prefs = cleanPrefs(body.prefs || subs.find((x) => x.endpoint === sub.endpoint)?.prefs);
    others.push({ id, endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, user, prefs, createdAt: new Date().toISOString() });
    await writeSubs(env, others);
    return json({ ok: true, id, prefs });
  }

  const idx = subs.findIndex((x) => x.endpoint === body.endpoint && x.user === user);
  if (idx < 0) return err('subscription not found', 404);

  if (action === 'prefs') {
    subs[idx].prefs = cleanPrefs(body.prefs);
    await writeSubs(env, subs);
    return json({ ok: true, prefs: subs[idx].prefs });
  }
  if (action === 'unsubscribe') {
    subs.splice(idx, 1);
    await writeSubs(env, subs);
    return json({ ok: true });
  }
  if (action === 'test') {
    if (!jwk) return err('push not configured (VAPID_JWK missing)', 503);
    const r = await sendPush(subs[idx], {
      title: 'No Way It Hits alerts are on',
      body: 'You’ll get injury news, pick flips, line moves and new edges here.',
      tag: 'test', url: '#/updates', at: new Date().toISOString(),
    }, { jwk, subject: subject(env), ttl: 300 });
    if (r.gone) { subs.splice(idx, 1); await writeSubs(env, subs); }
    return json({ ok: r.ok, status: r.status });
  }
  return err('unknown push route', 404);
}
