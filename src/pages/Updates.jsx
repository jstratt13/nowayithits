import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useFetchWithAuth } from '../auth/useFetchWithAuth.js';
import AlertsPanel from '../components/AlertsPanel.jsx';
import { onRefresh } from '../data/refreshBus.js';

// Updates feed (app phase 2). The worker diffs every 10-minute run and
// stores what changed — injury status changes, pick flips, line moves,
// new edges, lines being posted — in the day's predictions blob. This page
// lists them newest first. Phase 3 sends the same events as push alerts.

const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';
const LEAGUES = ['nba', 'wnba'];
const POLL_MS = 60 * 1000;

const TYPES = {
  injury:     { label: 'Injury',     cls: 'upd-injury' },
  pick_flip:  { label: 'Pick flip',  cls: 'upd-flip' },
  line_move:  { label: 'Line move',  cls: 'upd-line' },
  edge:       { label: 'Edge',       cls: 'upd-edge' },
  first_line: { label: 'Line posted', cls: 'upd-first' },
};

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function tipLabel(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export default function Updates() {
  const { token, status: authStatus } = useAuth();
  const fetchAuth = useFetchWithAuth();
  const [events, setEvents] = useState([]);
  const [state, setState] = useState(WORKER_URL ? 'loading' : 'disabled');
  const [filter, setFilter] = useState('all');
  const [, setTick] = useState(0); // re-render "x min ago"

  useEffect(() => {
    if (!WORKER_URL) return;
    if (authStatus !== 'authenticated' || !token) return;
    let cancelled = false;
    async function load() {
      const today = new Date();
      const tomorrow = new Date(today.getTime() + 86400000);
      const bust = Math.floor(Date.now() / 60000);
      try {
        const all = [];
        await Promise.all(LEAGUES.map(async (lg) => {
          const res = await fetchAuth(`${WORKER_URL}/predictions/${lg}?from=${ymd(today)}&to=${ymd(tomorrow)}&_m=${bust}`);
          if (!res.ok) throw new Error(`worker → ${res.status}`);
          const body = await res.json();
          for (const day of body.days || []) for (const e of day.events || []) all.push(e);
        }));
        if (cancelled) return;
        all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
        setEvents(all);
        setState('ok');
      } catch {
        if (!cancelled) setState((s) => (s === 'ok' ? 'ok' : 'error'));
      }
    }
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setTick((t) => t + 1), 30000);
    const off = onRefresh(load);
    return () => { cancelled = true; clearInterval(poll); clearInterval(tick); off(); };
  }, [authStatus, token, fetchAuth]);

  const shown = useMemo(() => (filter === 'all' ? events : events.filter((e) => e.type === filter)), [events, filter]);
  const counts = useMemo(() => {
    const c = {};
    for (const e of events) c[e.type] = (c[e.type] || 0) + 1;
    return c;
  }, [events]);

  return (
    <div className="updates-page">
      <AlertsPanel />
      <div className="panel">
        <div className="panel-head">
          <div>
            <div className="panel-eyebrow">Today &amp; tomorrow</div>
            <div className="panel-title">Game updates</div>
          </div>
        </div>
        <div className="upd-filters" role="tablist" aria-label="Filter updates">
          {['all', ...Object.keys(TYPES)].map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={filter === t}
              className={'upd-chip' + (filter === t ? ' active' : '')}
              onClick={() => setFilter(t)}
            >
              {t === 'all' ? 'All' : TYPES[t].label}
              <span className="upd-count">{t === 'all' ? events.length : counts[t] || 0}</span>
            </button>
          ))}
        </div>

        {state === 'loading' && <p className="upd-empty">Loading updates…</p>}
        {state === 'error' && <p className="upd-empty">Couldn’t reach the server. Retrying every minute.</p>}
        {state === 'disabled' && <p className="upd-empty">Updates need the worker connection.</p>}
        {state === 'ok' && shown.length === 0 && (
          <p className="upd-empty">
            No updates yet. They appear as injury news breaks, lines move, or picks change — checked every 10 minutes.
          </p>
        )}

        <ul className="upd-list">
          {shown.map((e) => {
            const t = TYPES[e.type] || { label: e.type, cls: '' };
            return (
              <li key={e.id} className="upd-item">
                <div className="upd-meta">
                  <span className={'upd-badge ' + t.cls}>{t.label}</span>
                  <span className="upd-league">{(e.league || '').toUpperCase()}</span>
                  {e.tipoff && <span className="upd-tip">tip {tipLabel(e.tipoff)}</span>}
                  <span className="upd-ago">{ago(e.at)}</span>
                </div>
                <div className="upd-title">{e.title}</div>
                <div className="upd-body">{e.body}</div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
