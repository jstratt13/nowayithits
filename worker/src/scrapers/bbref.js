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

import { getL10 } from './bbrL10.js';

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
      threePAr: num(row.fg3a_per_fga_pct),
    };
  }
  // Standings tables fill in W/L (and SRS fallback for the WNBA layout).
  for (const [abbr, row] of Object.entries(standings)) {
    if (!teams[abbr]) teams[abbr] = { name: row.team_name || abbr };
    if (teams[abbr].srs == null) teams[abbr].srs = num(row.srs);
    teams[abbr].wins   = num(row.wins);
    teams[abbr].losses = num(row.losses);
  }

  // L10 recent-form — three sources, in preference order:
  //   1. Bundled l10Cache.json from the daily GH Actions scrape
  //      (scripts/scrape-l10.mjs). Exact per-game ORtg/DRtg/Pace from BBR's
  //      advanced-gamelog pages. This is the ONLY path giving precise values.
  //   2. NBA Apr–Jun playoffs: scrape BBR's playoff advanced-team table
  //      directly (small-sample seasons, L10 ≈ playoff totals).
  //   3. NBA Oct–Mar regular season fallback: approximate from monthly
  //      game-log pages (fetchL10FromGameLog). Used when the bundled
  //      cache is missing a team (shouldn't happen under normal
  //      operation, but preserves data flow if the workflow hasn't run).
  //
  // The playoff path still overrides when in Apr–Jun since the bundled
  // cache is NBA regular-season focused (playoff gamelog pages have a
  // different URL structure). WNBA regular season still has no L10 wired.
  const bundledUsed = new Set();
  for (const [abbr, team] of Object.entries(teams)) {
    const l10 = getL10(league, abbr);
    if (l10 && l10.offRtg != null && l10.defRtg != null) {
      team.offLast10    = l10.offRtg;
      team.defLast10    = l10.defRtg;
      team.paceLast10   = l10.pace;
      team.toOffLast10  = l10.tovPct;
      team.toDefLast10  = l10.oppTovPct;
      team.orbOffLast10 = l10.orbPct;
      team.drbDefLast10 = l10.oppOrbPct != null ? 100 - l10.oppOrbPct : null;
      team.l10GameCount = l10.gameCount;
      team.l10Source    = 'bundled';
      bundledUsed.add(abbr);
    }
  }

  const monthNum = new Date().getUTCMonth() + 1;
  const isPlayoffs = league === 'nba' && monthNum >= 4 && monthNum <= 6;

  if (isPlayoffs) {
    await fillL10FromPlayoffPage(league, year, teams, env);
  } else if (league === 'nba' && bundledUsed.size < Object.keys(teams).length) {
    // Only run the inline approximation fallback if some teams didn't
    // get bundled L10 — keeps fetch count to zero when the cache is
    // complete, which is the steady-state case.
    await fetchL10FromGameLog(league, year, teams, env);
  }
  // WNBA regular season: still no L10 path (offseason + separate scraper TODO).

  return {
    source: 'basketball-reference.com',
    season: String(year),
    fetchedAt: new Date().toISOString(),
    teams,
  };
}

// ─────────────────────────────────────────────────────────────────────────
//  L10 fetchers
// ─────────────────────────────────────────────────────────────────────────

// Playoff-path L10 (NBA Apr–Jun only). Scrapes BBR's playoff advanced-team
// table — in playoffs, each team only has ~4-15 games, so this table IS
// the L10. Volume stats (TO%, ORB%, DRB%) are available too.
async function fillL10FromPlayoffPage(league, year, teams, env) {
  const url = `https://www.basketball-reference.com/playoffs/NBA_${year}.html`;
  const res = await fetch(url, {
    headers: { 'user-agent': env.USER_AGENT, 'accept': 'text/html', 'cache-control': 'no-cache' },
  });
  if (!res.ok) return;
  let html = await res.text();
  html = html.replace(/<!--/g, '').replace(/-->/g, '');
  const tblM = html.match(/<table[^>]*id="advanced-team"[\s\S]*?<\/table>/);
  if (!tblM) return;
  const body = tblM[0].replace(/<thead[\s\S]*?<\/thead>/g, '');
  const rows = body.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const cell = (row, name) => {
    const m = row.match(new RegExp(`data-stat="${name}"[^>]*>([0-9.]+)`));
    return m ? parseFloat(m[1]) : null;
  };
  for (const row of rows) {
    const h = row.match(/href=['"]\/(?:wnba\/)?teams\/([A-Z]{2,5})\//);
    if (!h) continue;
    const abbr = h[1];
    if (!teams[abbr]) teams[abbr] = {};
    teams[abbr].offLast10    = cell(row, 'off_rtg');
    teams[abbr].defLast10    = cell(row, 'def_rtg');
    teams[abbr].toOffLast10  = cell(row, 'tov_pct');
    teams[abbr].toDefLast10  = cell(row, 'opp_tov_pct');
    teams[abbr].orbOffLast10 = cell(row, 'orb_pct');
    teams[abbr].drbDefLast10 = cell(row, 'drb_pct');
  }
}

// Regular-season L10: approximate ORtg/DRtg from BBR monthly game-log pages.
//
// BBR's season-page advanced-team table ONLY has season-long ratings — it
// doesn't publish a "last 10" view. Per-team gamelog pages have exact
// per-game ORtg/DRtg but 30 fetches per scrape is too much. Compromise:
// fetch 1-2 monthly games pages (cheap), compute each team's pts scored
// and pts allowed over their last 10 games, approximate ORtg/DRtg by
// dividing by the team's season pace. Loses a few percent of precision
// vs real per-game ratings, but the 50/50 blend in blendedOff/Def doesn't
// need pinpoint accuracy — it needs recent-form directional signal.
//
// Only Off/Def ratings are populated by this path; TO%/ORB%/DRB% L10
// fields stay null (monthly game log doesn't expose box-score detail).
// blendVal in formulaCore.js correctly falls back to full-season when
// an L10 field is missing.
async function fetchL10FromGameLog(league, year, teams, env) {
  // NBA regular-season months: Oct, Nov, Dec of (year-1), Jan, Feb, Mar
  // of (year). We fetch the current month + previous month (enough for
  // L10 after ~late October when teams have played 10+ games). On Oct
  // where the previous month is September, the fetch 404s and is skipped.
  const now = new Date();
  const currentMonth = now.getUTCMonth(); // 0-11
  const monthNames = ['january','february','march','april','may','june',
                      'july','august','september','october','november','december'];
  const curName = monthNames[currentMonth];
  const prevName = monthNames[(currentMonth + 11) % 12];

  const urls = [
    `https://www.basketball-reference.com/leagues/NBA_${year}_games-${curName}.html`,
    `https://www.basketball-reference.com/leagues/NBA_${year}_games-${prevName}.html`,
  ];

  // Collect all games we can parse. Each row: date, home abbr, away abbr,
  // home pts, away pts. date gets used to order chronologically within
  // each team's list.
  const games = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': env.USER_AGENT, 'accept': 'text/html', 'cache-control': 'no-cache' },
      });
      if (!res.ok) continue;
      let html = await res.text();
      html = html.replace(/<!--/g, '').replace(/-->/g, '');
      const tblM = html.match(/<table[^>]*id="schedule"[\s\S]*?<\/table>/);
      if (!tblM) continue;
      const body = tblM[0].replace(/<thead[\s\S]*?<\/thead>/g, '');
      const rows = body.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
      for (const row of rows) {
        if (/class="[^"]*thead/.test(row)) continue;
        // csk looks like "202511050BOS" — first 8 chars are YYYYMMDD
        const csk = (row.match(/csk="([^"]+)"/) || [])[1];
        if (!csk) continue;
        const date = csk.slice(0, 8);
        // Visitor and home team hrefs
        const vHref = row.match(/data-stat="visitor_team_name"[^>]*>[\s\S]*?href=['"]\/teams\/([A-Z]{2,5})\//);
        const hHref = row.match(/data-stat="home_team_name"[^>]*>[\s\S]*?href=['"]\/teams\/([A-Z]{2,5})\//);
        const vPts = row.match(/data-stat="visitor_pts"[^>]*>([0-9]+)/);
        const hPts = row.match(/data-stat="home_pts"[^>]*>([0-9]+)/);
        if (!vHref || !hHref || !vPts || !hPts) continue;
        games.push({
          date,
          visitor: vHref[1],
          home: hHref[1],
          vPts: +vPts[1],
          hPts: +hPts[1],
        });
      }
    } catch { /* skip month on fetch error */ }
  }

  // Bucket games per team, tracking the opponent so we can approximate
  // each game's pace as avg of both teams' season pace.
  const perTeam = {};  // abbr -> [{date, scored, allowed, opp}]
  for (const g of games) {
    (perTeam[g.home] = perTeam[g.home] || []).push({ date: g.date, scored: g.hPts, allowed: g.vPts, opp: g.visitor });
    (perTeam[g.visitor] = perTeam[g.visitor] || []).push({ date: g.date, scored: g.vPts, allowed: g.hPts, opp: g.home });
  }

  // For each team, sort by date asc, take last 10, approximate ratings.
  //
  // Per Jordan: use L10 PACE (not season pace) as the divisor so we get
  // the team's actual per-100-possessions efficiency over the last 10
  // games, not a value distorted by season-long pace. Per-game pace is
  // approximated as the average of the two teams' season paces (we don't
  // have true per-game possession counts without scraping each team's
  // gamelog page). Then L10 pace = avg of those per-game estimates.
  for (const [abbr, list] of Object.entries(perTeam)) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const last10 = list.slice(-10);
    if (last10.length === 0) continue;

    const teamSeasonPace = teams[abbr]?.pace || 100;

    // L10 pace = avg of per-game pace estimates
    const gamePaces = last10.map((g) => {
      const oppPace = teams[g.opp]?.pace || 100;
      return (teamSeasonPace + oppPace) / 2;
    });
    const l10Pace = gamePaces.reduce((s, p) => s + p, 0) / gamePaces.length;

    const avgScored  = last10.reduce((s, g) => s + g.scored,  0) / last10.length;
    const avgAllowed = last10.reduce((s, g) => s + g.allowed, 0) / last10.length;

    const target = teams[abbr] = teams[abbr] || {};
    // Don't overwrite bundled-cache values — those are exact per-game
    // readings; this approximation is a fallback only.
    if (target.l10Source === 'bundled') continue;
    target.offLast10   = (avgScored  * 100) / l10Pace;
    target.defLast10   = (avgAllowed * 100) / l10Pace;
    target.paceLast10  = l10Pace;
    target.l10GameCount = last10.length;
    target.l10Source   = 'approximation';
    // TO%/ORB%/DRB% L10 fields deliberately NOT set — the monthly games
    // page doesn't carry that detail. blendVal falls back to full-season
    // when an L10 field is null.
  }
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
  // Strip <thead> so we only look at data rows. BBR's standings tables
  // open <tbody> but omit the closing </tbody>, so we can't scope to a
  // tbody match. Dropping thead + parsing all remaining <tr> gets both
  // layouts (advanced-team with a proper tbody, standings without).
  const bodyHtml = tableHtml.replace(/<thead[\s\S]*?<\/thead>/g, '');

  const out = {};
  const rows = bodyHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
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
