#!/usr/bin/env python3
"""
ktune — quarterly re-fit of the Model B totals "dominance strength" k.

WHAT THIS IS
------------
Model B's matchup dominance correction (formulaCore.js `combinedOffRating`)
re-weights each team's own offense and the opponent's defense away from a
flat 50/50 average:

    homeExpected_per100 = (effOff_home + effDef_away)/2
                        + MATCHUP_ORTG_COEF*(effOff_home - leagueAvg)
                        + MATCHUP_DRTG_COEF*(effDef_away - leagueAvg)

The *shipped* strength is MATCHUP_ORTG_COEF=0.40, MATCHUP_DRTG_COEF=0.63.
This script measures the single scalar k that scales BOTH coefficients
(k=0 -> pure naive 50/50, k=1 -> shipped strength) and finds the k that
best predicts ACTUAL game totals using POINT-IN-TIME ratings — i.e. only
the information available before each game, the way the live model sees it.

    total(k) = gamePoss/100 * [ (hbase + k*hcorr) + (abase + k*acorr) ]
    k = OLS slope of (actual_total - naive_total) on (modelB_total - naive_total)
    (k is invariant to the league-average anchor.)

WHY QUARTERLY
-------------
As of Nov 2026 the honest finding (see README) is that k is small on
point-in-time data (~0-0.2 pooled), NOT the shipped 1.0 — the original
0.40/0.63 fit used season-aggregate ratings, which is largely look-ahead.
k may genuinely drift as league style/personnel change, and the CURRENT
season can't be fit until teams have ~25-30 games. Re-running this each
quarter keeps the k we actually use honest against the current NBA.

DATA
----
Official box scores from stats.nba.com `leaguegamelog` (one request per
season, cached locally). Pure stdlib — no numpy/pandas/pip needed.

USAGE
-----
    python3 scripts/ktune/ktune.py                 # last 5 seasons, cached
    python3 scripts/ktune/ktune.py --refresh        # re-pull from stats.nba.com
    python3 scripts/ktune/ktune.py --seasons 2024-25,2025-26,2026-27
    python3 scripts/ktune/ktune.py --gp-min 10      # stricter min games-played

Interpreting the output: if a recent/current-season k settles well away
from ~0.2 with a tight SE across a full season, that's the signal to change
MATCHUP_ORTG_COEF / MATCHUP_DRTG_COEF in src/data/formulaCore.js (scale both
by the new k). Model changes affect NEW snapshots only (integrity rule).
"""
import argparse, json, math, os, sys, time, urllib.request
from collections import defaultdict

# Shipped strength (keep in sync with MODEL_CONFIG / combinedOffRating in
# src/data/formulaCore.js). k scales BOTH of these.
MATCHUP_ORTG_COEF = 0.40
MATCHUP_DRTG_COEF = 0.63
ANCHOR = 112.0            # league-avg centering; k is invariant to this
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")

NBA_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com',
    'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
    'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true', 'Connection': 'keep-alive',
}


def default_seasons(n=5):
    """Last n NBA seasons by ending year, labelled 'YYYY-YY'. After Sept the
    current season (startYear = thisYear) is in progress and included."""
    now = time.gmtime()
    start = now.tm_year if now.tm_mon >= 9 else now.tm_year - 1
    return [f"{y}-{(y+1)%100:02d}" for y in range(start - n + 1, start + 1)]


def fetch_season(season, refresh=False):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, f"{season}.json")
    if not refresh and os.path.exists(path) and os.path.getsize(path) > 1000:
        return json.load(open(path))
    url = ("https://stats.nba.com/stats/leaguegamelog?Counter=0&Direction=DESC"
           f"&LeagueID=00&PlayerOrTeam=T&Season={season}&SeasonType=Regular+Season&Sorter=DATE")
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=NBA_HEADERS), timeout=45) as r:
                d = json.load(r)
            rs = d['resultSets'][0]
            out = {'headers': rs['headers'], 'rows': rs['rowSet']}
            json.dump(out, open(path, 'w'))
            return out
        except Exception as e:                       # noqa: BLE001 — network flakiness
            last = e; time.sleep(2 + attempt * 2)
    raise RuntimeError(f"failed to fetch {season}: {last}")


def build_games(season, data, gp_min, anchor):
    H = data['headers']; idx = {h: i for i, h in enumerate(H)}
    rows = []
    for r in data['rows']:
        g = {k: r[idx[k.upper()]] for k in
             ('game_id', 'game_date', 'team_abbreviation', 'matchup',
              'fga', 'fta', 'oreb', 'tov', 'pts', 'plus_minus')}
        g['poss'] = g['fga'] + 0.44 * g['fta'] - g['oreb'] + g['tov']
        g['pa'] = g['pts'] - g['plus_minus']
        g['home'] = 'vs.' in g['matchup']
        rows.append(g)
    rows.sort(key=lambda r: (r['game_date'], r['game_id']))
    cum = defaultdict(lambda: {'poss': 0.0, 'pts': 0.0, 'pa': 0.0, 'gp': 0})
    for r in rows:
        c = cum[r['team_abbreviation']]
        r['gp_prior'] = c['gp']
        if c['poss'] > 0 and c['gp'] > 0:
            w = (min(c['gp'], 15) / 15) ** 2            # production-style shrink
            r['ORtg'] = anchor + (100 * c['pts'] / c['poss'] - anchor) * w
            r['DRtg'] = anchor + (100 * c['pa'] / c['poss'] - anchor) * w
            r['pace'] = c['poss'] / c['gp']
        else:
            r['ORtg'] = r['DRtg'] = r['pace'] = None
        c['poss'] += r['poss']; c['pts'] += r['pts']; c['pa'] += r['pa']; c['gp'] += 1
    by_game = defaultdict(list)
    for r in rows:
        by_game[r['game_id']].append(r)
    games = []
    for pair in by_game.values():
        if len(pair) != 2:
            continue
        h = next((x for x in pair if x['home']), None)
        a = next((x for x in pair if not x['home']), None)
        if not h or not a or None in (h['ORtg'], a['ORtg']):
            continue
        if h['gp_prior'] < gp_min or a['gp_prior'] < gp_min:
            continue
        gp = (h['pace'] + a['pace']) / 2
        hbase = (h['ORtg'] + a['DRtg']) / 2; abase = (a['ORtg'] + h['DRtg']) / 2
        hcorr = MATCHUP_ORTG_COEF * (h['ORtg'] - anchor) + MATCHUP_DRTG_COEF * (a['DRtg'] - anchor)
        acorr = MATCHUP_ORTG_COEF * (a['ORtg'] - anchor) + MATCHUP_DRTG_COEF * (h['DRtg'] - anchor)
        naive = gp / 100 * (hbase + abase)
        adj = gp / 100 * (hcorr + acorr)                # modelB_total = naive + 1*adj
        games.append({'season': season, 'date': h['game_date'],
                      'actual': h['pts'] + a['pts'], 'naive': naive, 'adj': adj})
    return games


def fit_k(games):
    """OLS slope k of (actual-naive) on adj, with intercept (absorbs any bias)."""
    n = len(games)
    if n < 5:
        return float('nan'), float('nan'), n
    xs = [g['adj'] for g in games]; ys = [g['actual'] - g['naive'] for g in games]
    mx = sum(xs) / n; my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    if sxx == 0:
        return 0.0, 0.0, n
    k = sxy / sxx; a = my - k * mx
    sse = sum((ys[i] - (a + k * xs[i])) ** 2 for i in range(n))
    se = math.sqrt((sse / (n - 2)) / sxx) if n > 2 else float('nan')
    return k, se, n


def mae(games, k):
    return sum(abs((g['naive'] + k * g['adj']) - g['actual']) for g in games) / len(games)


def main():
    ap = argparse.ArgumentParser(description="Re-fit Model B dominance strength k (point-in-time).")
    ap.add_argument('--seasons', help="comma list e.g. 2024-25,2025-26,2026-27 (default: last 5)")
    ap.add_argument('--refresh', action='store_true', help="re-pull box scores from stats.nba.com")
    ap.add_argument('--gp-min', type=int, default=3, help="min prior games-played for both teams (default 3)")
    args = ap.parse_args()

    seasons = args.seasons.split(',') if args.seasons else default_seasons(5)
    print(f"ktune — point-in-time dominance-strength fit  (shipped k=1 => "
          f"{MATCHUP_ORTG_COEF}/{MATCHUP_DRTG_COEF}; gp_min={args.gp_min})")
    print(f"seasons: {seasons}\n")

    by_season = {}
    for s in seasons:
        try:
            by_season[s] = build_games(s, fetch_season(s, args.refresh), args.gp_min, ANCHOR)
        except Exception as e:                           # noqa: BLE001
            print(f"  {s}: SKIP ({e})"); by_season[s] = []
    allg = [g for s in seasons for g in by_season[s]]

    print(f"{'season':>8} | {'games':>6} | {'k ± SE':>16} | {'own-off wt':>10} {'opp-def wt':>10} | "
          f"{'MAE k=0':>8} {'MAE k=1':>8}")
    print("-" * 86)
    for s in seasons:
        gs = by_season[s]
        if len(gs) < 5:
            print(f"{s:>8} | {len(gs):>6} | {'(too few)':>16} |"); continue
        k, se, n = fit_k(gs)
        print(f"{s:>8} | {n:>6} | {k:+6.2f} ± {se:4.2f} | {0.5+k*MATCHUP_ORTG_COEF:>10.2f} "
              f"{0.5+k*MATCHUP_DRTG_COEF:>10.2f} | {mae(gs,0):>8.2f} {mae(gs,1):>8.2f}")

    k_all, se_all, n_all = fit_k(allg)
    print("-" * 86)
    print(f"{'POOLED':>8} | {n_all:>6} | {k_all:+6.2f} ± {se_all:4.2f} |")

    cur = by_season[seasons[-1]]
    print("\nINTERPRETATION")
    print(f"  • Shipped strength is k=1 ({MATCHUP_ORTG_COEF}/{MATCHUP_DRTG_COEF}). Pooled best = {k_all:+.2f}.")
    print( "  • k≈0 ⇒ the dominance correction isn't earning its keep on live ratings;")
    print( "    k≈1 ⇒ shipped strength is right; change both coefs in formulaCore.js by the new k.")
    kc, sec, nc = fit_k(cur)
    if nc < 200 or (sec == sec and sec > 0.5):
        print(f"  • CURRENT season ({seasons[-1]}, n={nc}, k={kc:+.2f}±{sec:.2f}) is still too young/"
              f"noisy to act on — wait until teams have ~25-30 GP.")
    else:
        print(f"  • CURRENT season ({seasons[-1]}) k={kc:+.2f}±{sec:.2f} is now fittable — compare to shipped k=1.")
    print("\n  Next: log the date + per-season k row in README's history table.")


if __name__ == '__main__':
    sys.exit(main())
