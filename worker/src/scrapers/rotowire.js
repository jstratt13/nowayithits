// Rotowire injury report scraper.
//
// Returns a flat list of injuries plus a per-team rollup. The frontend's
// Delta_Star calculation uses the rollup to compute IAF/Injury Alignment
// Factor.
//
// Page structure (as of late 2024): a single HTML table with columns
// Player / Team / Position / Status / Updated / Injury / Notes. We parse
// each row by matching <a class="player">…</a> / <span class="status">…</span>.

const URLS = {
  nba:  'https://www.rotowire.com/basketball/injury-report.php',
  wnba: 'https://www.rotowire.com/basketball/wnba-injury-report.php',
};

// Status → weight used for IAF computation.
// Out = 1.0 (full hit), Doubtful = 0.75, Questionable = 0.4, Probable = 0.1.
const STATUS_WEIGHT = {
  out: 1.0,
  doubtful: 0.75,
  questionable: 0.4,
  probable: 0.1,
  gtd: 0.4,
  'day-to-day': 0.4,
  'd-to-d': 0.4,
  suspended: 1.0,
};

export async function scrapeInjuries(league, env) {
  const url = URLS[league];
  if (!url) throw new Error(`Unsupported league: ${league}`);

  const res = await fetch(url, {
    headers: {
      'user-agent': env.USER_AGENT,
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
    cf: { cacheTtl: 300 },
  });
  if (!res.ok) throw new Error(`Rotowire ${league} fetch failed: ${res.status}`);

  const html = await res.text();
  const players = parseInjuryRows(html);

  // Per-team rollup. For now we treat every listed player as equal weight
  // (we don't have per-player impact scores). The frontend can apply its
  // own weighting on top of this list.
  const byTeam = {};
  for (const p of players) {
    const t = p.team || 'UNK';
    if (!byTeam[t]) byTeam[t] = { players: [], score: 0 };
    byTeam[t].players.push(p);
    const w = STATUS_WEIGHT[(p.status || '').toLowerCase()] ?? 0.4;
    byTeam[t].score += w;
  }

  return {
    source: 'rotowire.com',
    fetchedAt: new Date().toISOString(),
    count: players.length,
    players,
    byTeam,
    statusWeights: STATUS_WEIGHT,
  };
}

function parseInjuryRows(html) {
  // Strip BBR-style comments just in case.
  const cleaned = html.replace(/<!--/g, '').replace(/-->/g, '');
  const rows = cleaned.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const players = [];

  for (const row of rows) {
    // Player name often sits in <a class="…player…">Name</a> or as plain text.
    const playerMatch = row.match(/<a[^>]*class="[^"]*player[^"]*"[^>]*>([^<]+)<\/a>/i)
      || row.match(/data-stat="player"[^>]*>([^<]+)</i);
    if (!playerMatch) continue;
    const player = decode(playerMatch[1]);

    const teamMatch = row.match(/href="[^"]*\/team\/([A-Z]{2,5})/i)
      || row.match(/data-stat="team"[^>]*>([A-Z]{2,5})</i);
    const team = teamMatch ? teamMatch[1].toUpperCase() : null;

    const statusMatch = row.match(/data-stat="status"[^>]*>([^<]+)</i)
      || row.match(/<span[^>]*class="[^"]*status[^"]*"[^>]*>([^<]+)<\/span>/i);
    const status = statusMatch ? cleanStatus(decode(statusMatch[1])) : null;

    const injuryMatch = row.match(/data-stat="injury"[^>]*>([^<]+)</i);
    const injury = injuryMatch ? decode(injuryMatch[1]).trim() : null;

    const updatedMatch = row.match(/data-stat="updated"[^>]*>([^<]+)</i);
    const updated = updatedMatch ? decode(updatedMatch[1]).trim() : null;

    if (!team || !status) continue;

    players.push({ player, team, status, injury, updated });
  }

  return players;
}

function cleanStatus(s) {
  const v = s.toLowerCase().trim();
  if (v.includes('out')) return 'Out';
  if (v.includes('doubt')) return 'Doubtful';
  if (v.includes('quest')) return 'Questionable';
  if (v.includes('prob')) return 'Probable';
  if (v.includes('gtd') || v.includes('game-time')) return 'GTD';
  if (v.includes('day') && v.includes('day')) return 'Day-To-Day';
  if (v.includes('suspend')) return 'Suspended';
  return s.trim();
}

function decode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
