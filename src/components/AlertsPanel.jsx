import { useCallback, useEffect, useState } from 'react';
import { useFetchWithAuth } from '../auth/useFetchWithAuth.js';

// Phone alerts (app phase 3): turn push notifications on for this device and
// choose which updates to get. The worker sends at most one (bundled)
// notification per device per 10-minute run.

const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';
const TYPE_LABELS = {
  injury: 'Injury status changes (18+ mpg players)',
  pick_flip: 'Pick flips',
  edge: 'New edges',
  line_move: 'Line moves (spread 1.5+, total 2+)',
  first_line: 'Lines posted',
};
const DEFAULT_PREFS = {
  types: { injury: true, pick_flip: true, line_move: true, edge: true, first_line: false },
  leagues: ['nba', 'wnba'],
  minEdge: 3,
  quiet: { enabled: false, start: 23, end: 8, tz: 'America/New_York' },
};

function keyBytes(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}
function support() {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  if (!('PushManager' in window) || !('Notification' in window)) return isIOS() && !isStandalone() ? 'ios-install' : 'unsupported';
  if (!import.meta.env.PROD) return 'dev';
  return 'ok';
}
const hourLabel = (h) => `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`;

export default function AlertsPanel() {
  const fetchAuth = useFetchWithAuth();
  const [mode] = useState(support);
  const [sub, setSub] = useState(null);
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [state, setState] = useState('loading'); // loading | off | on | denied | error
  const [msg, setMsg] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const api = useCallback(async (path, body) => {
    const res = await fetchAuth(`${WORKER_URL}/push/${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) throw new Error(j.error || `server ${res.status}`);
    return j;
  }, [fetchAuth]);

  useEffect(() => {
    if (mode !== 'ok') return;
    let cancelled = false;
    (async () => {
      try {
        if (Notification.permission === 'denied') { if (!cancelled) setState('denied'); return; }
        const reg = await navigator.serviceWorker.ready;
        const s = await reg.pushManager.getSubscription();
        if (!s) { if (!cancelled) setState('off'); return; }
        const st = await api(`status?endpoint=${encodeURIComponent(s.endpoint)}`);
        if (cancelled) return;
        setSub(s);
        if (st.subscribed) { setPrefs(st.prefs); setState('on'); } else setState('off');
      } catch { if (!cancelled) setState('error'); }
    })();
    return () => { cancelled = true; };
  }, [mode, api]);

  async function enable() {
    setBusy(true); setMsg('');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setState(perm === 'denied' ? 'denied' : 'off'); return; }
      const { publicKey } = await api('key');
      const reg = await navigator.serviceWorker.ready;
      const s = (await reg.pushManager.getSubscription())
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
      const r = await api('subscribe', { subscription: s.toJSON(), prefs: { ...prefs, quiet: { ...prefs.quiet, tz } } });
      setSub(s); setPrefs(r.prefs); setState('on'); setDirty(false);
      setMsg('Alerts are on for this device.');
    } catch (e) { setMsg(`Couldn’t turn alerts on: ${e.message}`); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setMsg('');
    try { const r = await api('prefs', { endpoint: sub.endpoint, prefs }); setPrefs(r.prefs); setDirty(false); setMsg('Saved.'); }
    catch (e) { setMsg(`Couldn’t save: ${e.message}`); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setMsg('');
    try { await api('test', { endpoint: sub.endpoint }); setMsg('Test alert sent — it should arrive in a few seconds.'); }
    catch (e) { setMsg(`Test failed: ${e.message}`); }
    finally { setBusy(false); }
  }
  async function disable() {
    setBusy(true); setMsg('');
    try { await api('unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); setSub(null); setState('off'); setMsg('Alerts are off for this device.'); }
    catch (e) { setMsg(`Couldn’t turn alerts off: ${e.message}`); }
    finally { setBusy(false); }
  }
  const edit = (fn) => { setPrefs((p) => fn(structuredClone(p))); setDirty(true); };

  return (
    <div className="panel alerts-panel">
      <div className="panel-head">
        <div>
          <div className="panel-eyebrow">This device</div>
          <div className="panel-title">Phone alerts</div>
        </div>
        {state === 'on' && <span className="alerts-on">On</span>}
      </div>

      {mode === 'ios-install' && (
        <p className="alerts-note">
          On iPhone, alerts work in the installed app: tap <b>Share</b> → <b>Add to Home Screen</b>, then open
          <b> NWIH</b> from your Home Screen and turn alerts on there.
        </p>
      )}
      {mode === 'unsupported' && <p className="alerts-note">This browser doesn’t support push alerts.</p>}
      {mode === 'dev' && <p className="alerts-note">Alerts work in the deployed app (not the local dev server).</p>}

      {mode === 'ok' && state === 'loading' && <p className="alerts-note">Checking…</p>}
      {mode === 'ok' && state === 'denied' && (
        <p className="alerts-note">Notifications are blocked for this app. Allow them in your phone’s Settings → Notifications, then reload.</p>
      )}
      {mode === 'ok' && state === 'error' && <p className="alerts-note">Couldn’t reach the server. Try again shortly.</p>}

      {mode === 'ok' && (state === 'off' || state === 'on') && (
        <>
          <div className="alerts-grid">
            <fieldset>
              <legend>Alert me about</legend>
              {Object.entries(TYPE_LABELS).map(([k, label]) => (
                <label key={k} className="alerts-check">
                  <input type="checkbox" checked={!!prefs.types[k]} onChange={(e) => edit((p) => { p.types[k] = e.target.checked; return p; })} />
                  {label}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Leagues</legend>
              {['nba', 'wnba'].map((l) => (
                <label key={l} className="alerts-check">
                  <input type="checkbox" checked={prefs.leagues.includes(l)} onChange={(e) => edit((p) => {
                    p.leagues = e.target.checked ? [...new Set([...p.leagues, l])] : p.leagues.filter((x) => x !== l); return p;
                  })} />
                  {l.toUpperCase()}
                </label>
              ))}
              <label className="alerts-row">
                Minimum edge for edge / line-posted alerts
                <select value={prefs.minEdge} onChange={(e) => edit((p) => { p.minEdge = Number(e.target.value); return p; })}>
                  {[0, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n === 0 ? 'Any' : `${n}+ pts`}</option>)}
                </select>
              </label>
              <label className="alerts-check">
                <input type="checkbox" checked={prefs.quiet.enabled} onChange={(e) => edit((p) => { p.quiet.enabled = e.target.checked; return p; })} />
                Quiet hours
              </label>
              {prefs.quiet.enabled && (
                <div className="alerts-row">
                  <select value={prefs.quiet.start} onChange={(e) => edit((p) => { p.quiet.start = Number(e.target.value); return p; })} aria-label="Quiet from">
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                  </select>
                  to
                  <select value={prefs.quiet.end} onChange={(e) => edit((p) => { p.quiet.end = Number(e.target.value); return p; })} aria-label="Quiet until">
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                  </select>
                </div>
              )}
            </fieldset>
          </div>
          <div className="alerts-actions">
            {state === 'off' && <button type="button" className="install-btn" disabled={busy} onClick={enable}>Turn on alerts</button>}
            {state === 'on' && (
              <>
                <button type="button" className="install-btn" disabled={busy || !dirty} onClick={save}>Save settings</button>
                <button type="button" className="alerts-secondary" disabled={busy} onClick={test}>Send test alert</button>
                <button type="button" className="alerts-secondary" disabled={busy} onClick={disable}>Turn off</button>
              </>
            )}
          </div>
        </>
      )}
      {msg && <p className="alerts-msg" role="status">{msg}</p>}
    </div>
  );
}
