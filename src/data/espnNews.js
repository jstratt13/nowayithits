// ESPN news endpoints — same family as the scoreboard / injuries APIs.
// Free, CORS-enabled, no key.
const URLS = {
  nba:  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=12',
  wnba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/news?limit=12',
};

export async function fetchNews(league) {
  const url = URLS[league];
  if (!url) throw new Error(`unsupported league: ${league}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN news ${league} → ${res.status}`);
  const data = await res.json();
  return (data.articles || [])
    .map((a) => ({
      id: a.id,
      headline: a.headline,
      description: a.description,
      published: a.published,
      // ESPN puts the canonical web URL at links.web.href; fall back to mobile
      url: a?.links?.web?.href || a?.links?.mobile?.href || null,
    }))
    .filter((a) => a.headline && a.url)
    .slice(0, 10); // top 10 per spec
}
