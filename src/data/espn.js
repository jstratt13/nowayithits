// ESPN public scoreboard endpoints. Free, no API key, CORS-enabled for GET.
// Returns today's games by default; pass ?dates=YYYYMMDD for any other day.

const BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball";

const LEAGUE_PATH = {
  nba: "nba",
  wnba: "wnba",
};

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export async function fetchScoreboard(league, date) {
  const path = LEAGUE_PATH[league];
  if (!path) throw new Error(`Unknown league: ${league}`);

  const url = date
    ? `${BASE}/${path}/scoreboard?dates=${ymd(date)}`
    : `${BASE}/${path}/scoreboard`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${path} scoreboard failed: ${res.status}`);
  const data = await res.json();
  return normalizeScoreboard(data, league);
}

function normalizeScoreboard(raw, league) {
  const events = Array.isArray(raw?.events) ? raw.events : [];
  return events.map((ev) => normalizeEvent(ev, league)).filter(Boolean);
}

function normalizeEvent(ev, league) {
  const comp = ev?.competitions?.[0];
  if (!comp) return null;

  const competitors = comp.competitors || [];
  const home = competitors.find((c) => c.homeAway === "home");
  const away = competitors.find((c) => c.homeAway === "away");
  if (!home || !away) return null;

  const status = ev.status?.type || {};
  const state = status.state || "pre"; // pre | in | post
  const odds = comp.odds?.[0] || null;
  const homeTeam = teamFrom(home);
  const awayTeam = teamFrom(away);

  // ESPN's odds.spread is the HOME team's signed line.
  //   -5.5 → home favored by 5.5
  //   +3.5 → home underdog by 3.5 (i.e., away favored)
  let homeLine = null;
  if (odds) {
    if (typeof odds.spread === "number") {
      homeLine = odds.spread;
    } else if (typeof odds.details === "string") {
      // Fallback parse: "NY -5.5" → favored team + line
      const m = odds.details.match(/([A-Z]{2,4})\s*([+-]?\d+(\.\d+)?)/);
      if (m) {
        const favAbbr = m[1];
        const num = parseFloat(m[2]);
        const favoredAtHome = favAbbr === homeTeam.abbr;
        homeLine = favoredAtHome ? -Math.abs(num) : Math.abs(num);
      }
    }
  }

  // Prefer ESPN's explicit favorite flag when present.
  let homeFavored = null;
  if (odds?.homeTeamOdds?.favorite === true) homeFavored = true;
  else if (odds?.awayTeamOdds?.favorite === true) homeFavored = false;
  else if (homeLine != null) homeFavored = homeLine < 0;

  const bookSpread = homeLine == null ? null : Math.abs(homeLine);
  const favoredAbbr = homeFavored == null ? null : (homeFavored ? homeTeam.abbr : awayTeam.abbr);

  return {
    id: ev.id,
    league,
    date: ev.date, // ISO string
    startTimeLabel: formatTime(ev.date),
    state, // pre | in | post
    statusLabel: status.shortDetail || status.description || "",
    home: homeTeam,
    away: awayTeam,
    odds: {
      homeLine,           // signed home spread (e.g. -5.5)
      spread: bookSpread, // absolute points
      total: odds?.overUnder ?? null,
      homeFavored,
      favored: favoredAbbr,
      provider: odds?.provider?.name || null,
    },
    // Where to watch: ESPN's `comp.broadcasts` is an array of
    //   { market: 'national' | 'home' | 'away', names: [...] }
    // We bucket the network names by market so the card can prefer
    // national listings and fall back to local feeds.
    broadcasts: normalizeBroadcasts(comp),
  };
}

function normalizeBroadcasts(comp) {
  const out = { national: [], home: [], away: [] };
  for (const b of comp?.broadcasts || []) {
    const market = b.market;
    if (!out[market]) continue;
    for (const name of b.names || []) {
      if (name && !out[market].includes(name)) out[market].push(name);
    }
  }
  return out;
}

function teamFrom(side) {
  const t = side.team || {};
  return {
    id: t.id,
    name: t.displayName || t.name,
    shortName: t.shortDisplayName || t.name,
    abbr: t.abbreviation || "",
    logo: t.logo || (t.logos && t.logos[0] && t.logos[0].href) || "",
    color: t.color ? `#${t.color}` : null,
    score: side.score != null ? Number(side.score) : null,
    winner: !!side.winner,
    record: side.records?.[0]?.summary || "",
  };
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}
