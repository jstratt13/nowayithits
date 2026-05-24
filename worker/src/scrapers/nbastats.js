// NBA.com / WNBA.com stats API scraper — last-N-games advanced team stats.
//
// Fetches OFF_RATING, DEF_RATING, NET_RATING, and PACE for each team
// filtered to the most recent N games. Used so the O/U formula can blend
// current form (last 10) with full-season averages (50/50 per spec).
//
// Endpoint: stats.nba.com/stats/leaguedashteamstats
//           stats.wnba.com/stats/leaguedashteamstats
//
// NBA.com requires specific Referer / Origin headers; omitting them returns
// a 400. The response is JSON with a resultSets[0] structure containing
// a headers array and a rowSet array.

const ENDPOINTS = {
  nba: (season, seasonType, n) =>
    `https://stats.nba.com/stats/leaguedashteamstats` +
    `?LastNGames=${n}&LeagueID=00&MeasureType=Advanced&PerMode=PerGame` +
    `&Season=${season}&SeasonType=${encodeURIComponent(seasonType)}&PaceAdjust=N&Rank=N` +
    `&PlusMinus=N&TeamID=0&Conference=&Division=&GameScope=&Location=&Month=0&Outcome=` +
    `&PORound=0&Period=0&OpponentTeamID=0&VsConference=&VsDivision=`,
  wnba: (season, _seasonType, n) =>
    `https://stats.wnba.com/stats/leaguedashteamstats` +
    `?LastNGames=${n}&LeagueID=20&MeasureType=Advanced&PerMode=PerGame` +
    `&Season=${season}&SeasonType=Regular+Season&PaceAdjust=N&Rank=N` +
    `&PlusMinus=N&TeamID=0`,
};

// NBA.com/stats returns the same abbreviation style as BBR (OKC, SAS, NYK…)
// so the normalizeBBRKeys step in liveStats.js will handle the ESPN remapping.

function currentNBASeason() {
  // NBA season label = finishing year (2025-26 → "2025-26")
  const d = new Date();
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() + 1 >= 10 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

function currentWNBASeason() {
  return String(new Date().getUTCFullYear());
}

function currentNBASeasonType() {
  // April–June = playoffs; rest of year = regular season
  const m = new Date().getUTCMonth() + 1;
  return m >= 4 && m <= 6 ? 'Playoffs' : 'Regular Season';
}

const NBA_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.nba.com',
  'Referer': 'https://www.nba.com/stats/teams/advanced',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
};

const WNBA_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.wnba.com',
  'Referer': 'https://www.wnba.com/stats/teams/advanced',
};

export async function fetchLastNGamesStats(league, env, n = 10) {
  const url = league === 'nba'
    ? ENDPOINTS.nba(currentNBASeason(), currentNBASeasonType(), n)
    : ENDPOINTS.wnba(currentWNBASeason(), null, n);

  const headers = {
    ...(league === 'nba' ? NBA_HEADERS : WNBA_HEADERS),
    'User-Agent': env.USER_AGENT,
  };

  const res = await fetch(url, { headers, cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error(`NBA.com stats ${league} L${n} → ${res.status}`);

  const data = await res.json();
  const rs = data?.resultSets?.[0];
  if (!rs?.headers || !rs?.rowSet) throw new Error('Unexpected NBA.com response shape');

  const idx = (field) => rs.headers.indexOf(field);
  const iAbbr  = idx('TEAM_ABBREVIATION');
  const iOffRtg = idx('OFF_RATING');
  const iDefRtg = idx('DEF_RATING');
  const iPace   = idx('PACE');

  const out = {};
  for (const row of rs.rowSet) {
    const abbr = row[iAbbr];
    if (!abbr) continue;
    out[abbr] = {
      offLast10: row[iOffRtg] ?? null,
      defLast10: row[iDefRtg] ?? null,
      paceLast10: row[iPace]  ?? null,
    };
  }
  return out;
}
