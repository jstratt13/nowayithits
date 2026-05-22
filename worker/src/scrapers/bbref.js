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

  // Try the two known table IDs in priority order. BBR has historically
  // renamed these (advanced-team / advanced_stats / advanced).
  const advanced = extractTable(html, ['advanced-team', 'advanced_stats', 'advanced']);
  const misc     = extractTable(html, ['team-stats-misc', 'misc_stats', 'misc']);

  const teams = {};
  for (const [abbr, row] of Object.entries(advanced)) {
    teams[abbr] = {
      name: row.name,
      pace:    num(row.pace),
      off:     num(row.off_rtg),
      def:     num(row.def_rtg),
      toOff:   num(row.tov_pct),
      orbOff:  num(row.orb_pct),
      // Opponent stats sit on the same row, prefixed with opp_
      toDef:   num(row.opp_tov_pct),
      drbDef:  num(row.drb_pct), // % of available defensive boards grabbed
    };
  }
  for (const [abbr, row] of Object.entries(misc)) {
    if (!teams[abbr]) teams[abbr] = { name: row.name };
    teams[abbr].srs    = num(row.srs);
    teams[abbr].sos    = num(row.sos);
    teams[abbr].mov    = num(row.mov);
    teams[abbr].netRtg = num(row.net_rtg);
  }

  return {
    source: 'basketball-reference.com',
    season: String(year),
    fetchedAt: new Date().toISOString(),
    teams,
  };
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
    const teamHrefMatch = row.match(/href="\/(?:wnba\/)?teams\/([A-Z]{2,5})\//);
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
