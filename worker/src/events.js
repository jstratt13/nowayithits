// ─────────────────────────────────────────────────────────────────────────
//  Game updates (app phase 2, 11/20/26).
//
//  Every cron run compares each game's previous snapshot with the fresh one
//  and records what changed as "events". They're appended to the same
//  predictions blob that's already written each run, so this costs zero
//  extra KV writes. The app's Updates feed reads them; phase 3 turns them
//  into push notifications.
//
//  Event types:
//    first_line  — the book posted a line and the model has a pick
//    injury      — a rotation player's (18+ mpg) status changed
//    pick_flip   — the spread or O/U pick switched sides
//    line_move   — spread moved ≥ 1.5 or total ≥ 2 since the last alert
//    edge        — spread / O/U edge reached ≥ 3 points
//
//  Per-game alert memory (line baselines, which edges already alerted)
//  lives in predictions.alertState and is carried forward run to run.
//  A snapshot written before this existed is initialized silently, so a
//  deploy doesn't fire a burst of stale alerts.
// ─────────────────────────────────────────────────────────────────────────

export const EVENT_RULES = {
  MIN_MPG: 18,          // injury alerts only for rotation players (model cutoff)
  LINE_MOVE: 1.5,       // spread points since last alert
  TOTAL_MOVE: 2.0,      // total points since last alert
  EDGE_ALERT: 3.0,      // alert when |edge| reaches this…
  EDGE_RESET: 2.5,      // …and re-arm once it falls back below this
  MAX_EVENTS: 300,      // kept per (league, date) blob
};

const fmt = (n, d = 1) => (n == null || Number.isNaN(n) ? '—' : Number(n).toFixed(d));
const signed = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`);
const spStr = (sp) => (sp ? `${sp.side} ${signed(sp.line)}` : '—');
const ouStr = (ou) => (ou ? `${ou.direction} ${fmt(ou.line)}` : '—');

// Home-perspective margin → "BOS by 4.2"
function marginStr(m, home, away) {
  if (m == null) return '—';
  return m >= 0 ? `${home} by ${fmt(m)}` : `${away} by ${fmt(-m)}`;
}

function initState(c, odds) {
  return {
    v: 1,
    lineBase: odds?.homeLine ?? null,
    totalBase: odds?.total ?? null,
    spEdgeAlerted: Math.abs(c?.sp?.edge ?? 0) >= EVENT_RULES.EDGE_ALERT,
    ouEdgeAlerted: Math.abs(c?.ou?.edge ?? 0) >= EVENT_RULES.EDGE_ALERT,
  };
}

// Injury rows keyed team → player → row, from the breakdown's Δ_Star block.
function injuryRows(pred) {
  const ds = pred?.breakdown?.deltaStar;
  const out = {};
  for (const t of [ds?.favTeam, ds?.undTeam]) {
    if (!t?.abbr) continue;
    out[t.abbr] = {};
    for (const r of t.players || []) if (r?.player) out[t.abbr][r.player] = r;
  }
  return out;
}

export function detectGameEvents(prev, cur, nowIso) {
  const c = cur?.predictions;
  if (!c) return { events: [], alertState: null };
  const p = prev?.predictions;
  const home = cur.home?.abbr, away = cur.away?.abbr;
  const base = {
    at: nowIso, league: cur.league, gameId: cur.gameId, tipoff: cur.tipoff,
    matchup: `${away} @ ${home}`, home, away,
  };
  const events = [];
  let k = 0;
  const push = (type, title, body, data = {}) => events.push({
    id: `${cur.gameId}:${type}:${nowIso}:${k++}`, type, title, body, ...base, data,
  });

  // Line came back after the book briefly pulled it → resume quietly.
  if (!p && prev?.lineSeenAt) return { events: [], alertState: initState(c, cur.odds) };
  // Brand-new pick (book just posted a line).
  if (!p) {
    push('first_line', `${base.matchup}: line posted`,
      `Spread ${spStr(c.sp)} (edge ${fmt(c.sp?.edge)}) · ${ouStr(c.ou)} (edge ${fmt(c.ou?.edge)}) · model ${marginStr(c.projMargin, home, away)}`,
      { sp: c.sp, ou: c.ou, projMargin: c.projMargin, projTotal: c.projTotal });
    return { events, alertState: initState(c, cur.odds) };
  }
  // Snapshot from before alerts existed → start tracking quietly.
  if (!p.alertState) return { events: [], alertState: initState(c, cur.odds) };
  const st = { ...p.alertState };

  const effect = `Model ${marginStr(p.projMargin, home, away)} → ${marginStr(c.projMargin, home, away)} · total ${fmt(p.projTotal)} → ${fmt(c.projTotal)}`;

  // Injury status changes (rotation players only).
  const before = injuryRows(p), after = injuryRows(c);
  for (const team of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[team] || {}, a = after[team] || {};
    for (const name of new Set([...Object.keys(b), ...Object.keys(a)])) {
      const was = b[name]?.status || null, now = a[name]?.status || null;
      if (was === now) continue;
      const mpg = a[name]?.mpg ?? b[name]?.mpg ?? 0;
      if (mpg < EVENT_RULES.MIN_MPG) continue;
      const label = now ? (was ? `${was} → ${now}` : now) : `cleared (was ${was})`;
      push('injury', `${name} (${team}): ${label}`, `${base.matchup} · ${fmt(mpg)} mpg · ${effect}`,
        { player: name, team, was, now, mpg, projMarginBefore: p.projMargin, projMarginAfter: c.projMargin });
    }
  }

  // Pick flips.
  if (p.sp && c.sp && p.sp.side !== c.sp.side) {
    push('pick_flip', `${base.matchup}: spread pick now ${spStr(c.sp)}`,
      `Was ${spStr(p.sp)} · edge ${fmt(c.sp.edge)} · ${effect}`, { leg: 'spread', from: p.sp, to: c.sp });
  }
  if (p.ou && c.ou && p.ou.direction !== c.ou.direction) {
    push('pick_flip', `${base.matchup}: total pick now ${ouStr(c.ou)}`,
      `Was ${ouStr(p.ou)} · edge ${fmt(c.ou.edge)} · ${effect}`, { leg: 'total', from: p.ou, to: c.ou });
  }

  // Line moves since the last alert baseline.
  const hl = cur.odds?.homeLine, tot = cur.odds?.total;
  if (hl != null && st.lineBase != null && Math.abs(hl - st.lineBase) >= EVENT_RULES.LINE_MOVE) {
    push('line_move', `${base.matchup}: spread moved ${home} ${signed(st.lineBase)} → ${signed(hl)}`,
      `Pick ${spStr(c.sp)} · edge ${fmt(c.sp?.edge)}`, { leg: 'spread', from: st.lineBase, to: hl });
    st.lineBase = hl;
  } else if (st.lineBase == null) st.lineBase = hl ?? null;
  if (tot != null && st.totalBase != null && Math.abs(tot - st.totalBase) >= EVENT_RULES.TOTAL_MOVE) {
    push('line_move', `${base.matchup}: total moved ${fmt(st.totalBase)} → ${fmt(tot)}`,
      `Pick ${ouStr(c.ou)} · edge ${fmt(c.ou?.edge)}`, { leg: 'total', from: st.totalBase, to: tot });
    st.totalBase = tot;
  } else if (st.totalBase == null) st.totalBase = tot ?? null;

  // Edges reaching the alert threshold (re-armed when they fade).
  for (const [leg, pick, key, str] of [['spread', c.sp, 'spEdgeAlerted', spStr], ['total', c.ou, 'ouEdgeAlerted', ouStr]]) {
    const e = Math.abs(pick?.edge ?? 0);
    if (!st[key] && e >= EVENT_RULES.EDGE_ALERT) {
      push('edge', `${base.matchup}: ${leg} edge ${fmt(e)} on ${str(pick)}`,
        `Model ${marginStr(c.projMargin, home, away)} · total ${fmt(c.projTotal)}`, { leg, pick, edge: e });
      st[key] = true;
    } else if (st[key] && e < EVENT_RULES.EDGE_RESET) st[key] = false;
  }

  return { events, alertState: st };
}

// Merge new events into the blob's list (newest last), capped.
export function appendEvents(existing, fresh) {
  const all = [...(existing || []), ...fresh];
  return all.slice(-EVENT_RULES.MAX_EVENTS);
}
