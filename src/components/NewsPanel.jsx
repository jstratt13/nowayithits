import { useEffect, useState } from 'react';
import { useNews } from '../hooks/useNews.js';

// Renders a desktop sidebar that's always visible OR a mobile slide-out
// drawer that overlays the page. Same component, two CSS presentations.
export default function NewsPanel({ league }) {
  const [open, setOpen] = useState(false);
  const { status, articles, error } = useNews(league);

  // Close drawer on Escape key
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Prevent body scroll while drawer is open on mobile
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  return (
    <>
      {/* Backdrop (mobile drawer only) */}
      {open && (
        <div
          className="news-backdrop"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside className={'news-panel' + (open ? ' is-open' : '')}>
        {/* Mobile-only edge tab — toggles open/closed and slides with panel */}
        <button
          type="button"
          className={'news-edge-tab' + (open ? ' is-open' : '')}
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? 'Close news panel' : 'Open news panel'}
          aria-expanded={open}
        >
          {open ? 'Close' : 'News'}
        </button>

        <div className="news-panel-head">
          <div>
            <div className="news-eyebrow">{league.toUpperCase()} headlines</div>
            <div className="news-title">Latest from ESPN</div>
          </div>
        </div>

        <div className="news-content">
          {status === 'loading' && articles.length === 0 && (
            <div className="news-empty">Loading…</div>
          )}
          {status === 'error' && (
            <div className="news-empty">Couldn't reach ESPN news — {error}</div>
          )}
          {articles.length > 0 && (
            <ol className="news-list">
              {articles.map((a) => (
                <li key={a.id} className="news-item">
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="news-link"
                  >
                    <span className="news-headline">{a.headline}</span>
                    <span className="news-time">{relativeTime(a.published)}</span>
                  </a>
                </li>
              ))}
            </ol>
          )}
        </div>
      </aside>
    </>
  );
}

function relativeTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
