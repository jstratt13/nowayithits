// Basketball-Reference scraper.
//
// We pull two tables per league:
//   - misc_stats      → SRS, MOV, SOS, Net Rating
//   - advanced_team   → Pace, ORtg, DRtg, eFG%, TOV%, ORB%, FT/FGA + opponent versions
//
// BBR wraps secondary tables in HTML comments to defer client-side rendering,
// so we strip `<!--`/`-->` before parsing. After that the tables are plain
// HTML and we extract cells by their `data-stat` attribute.
//
// ── WNBA-specific TODOs from gemini-code-1779431740324.txt ──────────────
//
//   1. Arena HCA tier. The WNBA model wants per-team HCA classified as
//      Elite (+4 to +5), Flatline (+2.45), or Hard Floor (+2.0), driven
//      by each team's home vs road net rating split. BBR exposes home/
//      road splits on each team page (e.g. /wnba/teams/MIN/2026.html).
//      Plan: per-team fetch → parse "Home/Road Splits" table → compute
//      home_net - road_net → tier-bucket it → emit as `hcaTier` field.
//
//   2. SRS blending. Early in the WNBA season (first 5–7 games) SRS is
//      noisy. Blueprint says to blend current SRS with the previous
//      season's closing SRS. Plan: also fetch /wnba/years/<prev>.html
//      and emit `srsPrev`; the worker (or a downstream helper) returns
//      `srsBlended = mix(currentSRS, prevSRS, weight)` where weight
//      decays from 0.7 prev→0 by game 7.
//
//   3. "Last 10 Games" possession filter. After about a month into the
//      season, the WNBA model should pull TO%/ORB%/DRB% from a "Last 10
//      Games" view rather than season-to-date. BBR doesn't expose that
//      view as a static URL — stats.wnba.com does, via
//      https://stats.wnba.com/stats/leaguedashteamstats?LastNGames=10.
//      That endpoint needs the standard headers (Referer, Accept, etc.)
//      and could replace this scraper's TO/ORB/DRB columns once games >=
//      ~25 on the season clock.
//
//   4. Her Hoop Stats On/Off Net Rating per player — for sharpening
//      Delta_Star beyond the Rotowire-only rollup. Outside the BBR
//      scraper's scope, lives in its own scraper file (TODO).

const BBR = {
  nba: (year) => `https://www.basketball-reference.com/leagues/NBA_${year}.html`,
  wnba: (year) => `https://www.basketball-reference.com/wnba/years/${year}.html`,
};

function nbaSeasonYear() {
  const d = new Date();
  // NBA season label = spring year (e.g. 2025-26 season = "2026").
  return d.getUTCMonth() + 1 >= 10 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
}

function wnbaSeasonYear() {
  // WNBA is a single calendar year.
  return new Date().getUTCFullYear();
}

// nbastats.js (NBA.com API) is kept for future use but NBA.com blocks
// automated fetches from Cloudflare IPs. We use the BBR playoffs page
// for recent-form ORtg instead, which is a better proxy in April–June.
// import { fetchLastNGamesStats } from './nbastats.js';

export async function scrapeTeamStats(league, env) {
  const year = league === 'nba' ? nbaSeasonYear() : wnbaSeasonYear();
  const url = BBR[league](year);

  const res = await fetch(url, {
    headers: {
      'user-agent': env.USER_AGENT,
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
    cf: { cacheTtl: 600 },
  });
  if (!res.ok) throw new Error(`BBR ${league} ${year} fetch failed: ${res.status}`);

  let html = await res.text();
  html = html.replace(/<!--/g, '').replace(/-->/g, '');

  // BBR's table inventory on the main season page (NBA_<year>.html):
  //   advanced-team        → Pace, ORtg, DRtg, TOV%, ORB%, opp TOV%, DRB%
  //   confs_standings_E    → SRS (Eastern Conference)
  //   confs_standings_W    → SRS (Western Conference)
  //   WNBA single page uses one standings table (no East/West split).
  const advanced = extractTable(html, ['advanced-team', 'advanced_stats', 'advanced']);

  const standings = {};
  for (const tid of ['confs_standings_E', 'confs_standings_W', 'standings', 'wnba_standings', 'expanded_standings']) {
    Object.assign(standings, extractTable(html, [tid]));
  }

  const teams = {};
  for (const [abbr, row] of Object.entries(advanced)) {
    teams[abbr] = {
      name: row.name,
      srs:     num(row.srs),    // BBR keeps SRS on the advanced-team row too
      mov:     num(row.mov),
      sos:     num(row.sos),
      pace:    num(row.pace),
      off:     num(row.off_rtg),
      def:     num(row.def_rtg),
      netRtg:  num(row.net_rtg),
      toOff:   num(row.tov_pct),
      orbOff:  num(row.orb_pct),
      toDef:   num(row.opp_tov_pct),
      drbDef:  num(row.drb_pct),
    };
  }
  // Standings tables fill in W/L (and SRS fallback for the WNBA layout).
  for (const [abbr, row] of Object.entries(standings)) {
    if (!teams[abbr]) teams[abbr] = { name: row.team_name || abbr };
    if (teams[abbr].srs == null) teams[abbr].srs = num(row.srs);
    teams[abbr].wins   = num(row.wins);
    teams[abbr].losses = num(row.losses);
  }

  // Fetch recent-form ORtg inline — using playoff page for NBA Apr–Jun.
  {
    const m = new Date().getUTCMonth() + 1;
    const isPlayoffs = league === 'nba' && m >= 4 && m <= 6;
    const recentUrl = isPlayoffs
      ? `https://www.basketball-reference.com/playoffs/NBA_${year}.html`
      : league === 'nba'
        ? `https://www.basketball-reference.com/leagues/NBA_${year}.html`
        : `https://www.basketball-reference.com/wnba/years/${year}.html`;

    const rRes = await fetch(recentUrl, {
      headers: { 'user-agent': env.USER_AGENT, 'accept': 'text/html', 'cache-control': 'no-cache' },
    });
    if (rRes.ok) {
      let rHtml = await rRes.text();
      rHtml = rHtml.replace(/<!--/g, '').replace(/-->/g, '');
      const rTableM = rHtml.match(/<table[^>]*id="advanced-team"[\s\S]*?<\/table>/);
      if (rTableM) {
        const rTbody = rTableM[0].match(/<tbody[\s\S]*?<\/tbody>/);
        if (rTbody) {
          const rRows = rTbody[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
          // Helper: pull a numeric value for a given data-stat name out of
          // the row, returning null if missing or non-numeric. BBR's
          // cells embed `data-stat="X"` then the rendered value as text.
          const cell = (row, statName) => {
            const m = row.match(new RegExp(`data-stat="${statName}"[^>]*>([0-9.]+)`));
            return m ? parseFloat(m[1]) : null;
          };

          for (const rRow of rRows) {
            const hM = rRow.match(/href=['"]\/(?:wnba\/)?teams\/([A-Z]{2,5})\//);
            if (!hM) continue;
            const abbr = hM[1];
            if (!teams[abbr]) teams[abbr] = {};
            // L10 versions of the four matchup-volume inputs follow the
            // same data-stat names as the season-page advanced-team
            // table: tov_pct, opp_tov_pct, orb_pct, drb_pct. Mirrors the
            // off/def L10 already extracted above.
            teams[abbr].offLast10    = cell(rRow, 'off_rtg');
            teams[abbr].defLast10    = cell(rRow, 'def_rtg');
            teams[abbr].toOffLast10  = cell(rRow, 'tov_pct');
            teams[abbr].toDefLast10  = cell(rRow, 'opp_tov_pct');
            teams[abbr].orbOffLast10 = cell(rRow, 'orb_pct');
            teams[abbr].drbDefLast10 = cell(rRow, 'drb_pct');
          }
        }
      }
    }
  }

  return {
    source: 'basketball-reference.com',
    season: String(year),
    fetchedAt: new Date().toISOString(),
    teams,
  };
}

export async function scrapeRecentFormORtg(league, year, env) {
  const isNBAPlayoffSeason = league === 'nba' && (() => {
    const m = new Date().getUTCMonth() + 1;
    return m >= 4 && m <= 6;
  })();

  const url = isNBAPlayoffSeason
    ? `https://www.basketball-reference.com/playoffs/NBA_${year}.html`
    : league === 'nba'
      ? `https://www.basketball-reference.com/leagues/NBA_${year}.html`
      : `https://www.basketball-reference.com/wnba/years/${year}.html`;

  const res = await fetch(url, {
    headers: {
      'user-agent': env.USER_AGENT,
      'accept': 'text/html,application/xhtml+xml',
      // Force a fresh fetch — this data changes every game so stale edge
      // caches produce nulls when the table structure shifts.
      'cache-control': 'no-cache',
    },
    cf: { cacheTtl: -1 }, // bypass Cloudflare edge cache
  });
  if (!res.ok) throw new Error(`Recent form fetch failed: ${res.status}`);

  let html = await res.text();
  html = html.replace(/<!--/g, '').replace(/-->/g, '');

  // Direct parse: find the advanced-team tbody, then per-row extract
  // team href + off_rtg. Bypasses the full extractTable/parseTable chain
  // which has trouble with the numeric cell format in the playoffs table.
  const tableM = html.match(/<table[^>]*id="advanced-team"[\s\S]*?<\/table>/);
  if (!tableM) return {};
  const tbody = tableM[0].match(/<tbody[\s\S]*?<\/tbody>/);
  if (!tbody) return {};
  const rows = tbody[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];

  const out = {};
  for (const row of rows) {
    const hrefM = row.match(/href=['"]\/(?:wnba\/)?teams\/([A-Z]{2,5})\//);
    if (!hrefM) continue;
    const abbr = hrefM[1];
    const offM = row.match(/data-stat="off_rtg"[^>]*>([0-9.]+)/);
    const defM = row.match(/data-stat="def_rtg"[^>]*>([0-9.]+)/);
    out[abbr] = {
      off: offM ? parseFloat(offM[1]) : null,
      def: defM ? parseFloat(defM[1]) : null,
    };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
//  Internal table parser
// ─────────────────────────────────────────────────────────────────────────

function extractTable(html, candidateIds) {
  for (const id of candidateIds) {
    const m = html.match(new RegExp(`<table[^>]*id="${id}"[\\s\\S]*?</table>`));
    if (m) return parseTable(m[0]);
  }
  return {};
}

function parseTable(tableHtml) {
  const tbodyMatch = tableHtml.match(/<tbody[\s\S]*?<\/tbody>/);
  if (!tbodyMatch) return {};

  const out = {};
  const rows = tbodyMatch[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  for (const row of rows) {
    if (/class="[^"]*thead/.test(row) || /class="[^"]*partial_table/.test(row)) continue;

    const cells = {};
    const cellRegex = /<(?:td|th)\b[^>]*\bdata-stat="([^"]+)"[^>]*>([\s\S]*?)<\/(?:td|th)>/g;
    let m;
    while ((m = cellRegex.exec(row)) !== null) {
      cells[m[1]] = stripTags(m[2]).trim();
    }

    // Pull abbreviation out of the team cell's href: /teams/BOS/2026.html
    // BBR uses single quotes on these hrefs, so accept either quote style.
    const teamHrefMatch = row.match(/href=['"]\/(?:wnba\/)?teams\/([A-Z]{2,5})\//);
    const abbr = teamHrefMatch ? teamHrefMatch[1] : null;
    if (!abbr) continue;

    cells.name = cells.team || cells.team_name || abbr;
    out[abbr] = cells;
  }
  return out;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/ /g, ' ');
}

function num(s) {
  if (s == null || s === '') return null;
  const n = parseFloat(String(s).replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
