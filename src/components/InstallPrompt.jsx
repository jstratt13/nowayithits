import { useEffect, useState } from 'react';

// "Install the app" banner. Push notifications on iPhone only work after the
// site is added to the Home Screen (iOS 16.4+), so this nudges that step.
//   • already installed (standalone) → nothing
//   • iPhone/iPad Safari            → Share → Add to Home Screen instructions
//   • Chrome / Edge / Android       → one-tap Install button
// Dismissal is remembered per device (localStorage, best-effort).
const KEY = 'nwih-install-dismissed-v1';

function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOS() {
  const ua = window.navigator.userAgent || '';
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}
function wasDismissed() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [hidden, setHidden] = useState(() => isStandalone() || wasDismissed());

  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setDeferred(e); };
    const onInstalled = () => setHidden(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (hidden) return null;
  const ios = isIOS();
  if (!ios && !deferred) return null; // browser can't install (or already offered)

  function dismiss() {
    try { localStorage.setItem(KEY, '1'); } catch { /* private mode */ }
    setHidden(true);
  }
  async function install() {
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === 'accepted') setHidden(true);
    setDeferred(null);
  }

  return (
    <div className="install-banner" role="region" aria-label="Install the app">
      <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="" className="install-icon" />
      <div className="install-text">
        <strong>Get the app</strong>
        {ios
          ? <span>Tap <b>Share</b> <span aria-hidden="true">⎋</span> then <b>Add to Home Screen</b> — needed for game alerts on iPhone.</span>
          : <span>Install No Way It Hits for full-screen access and game alerts.</span>}
      </div>
      {!ios && <button type="button" className="install-btn" onClick={install}>Install</button>}
      <button type="button" className="install-close" onClick={dismiss} aria-label="Dismiss">×</button>
    </div>
  );
}
