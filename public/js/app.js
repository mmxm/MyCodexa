import { initI18n } from './i18n.js';
import { initSidebar } from './sidebar.js';
import { initRouter } from './router.js';
import { initLibrary, selectShelf, initGridDensityToggle } from './library.js';
import { initSettings } from './settings.js';
import { initOpds } from './opds.js';
import { initBookorbit } from './bookorbit.js';
import { initBookorbitDash } from './bookorbitDash.js';
import { requireAuth } from './api.js';
import { flushProgressOutbox } from './progress-outbox.js';
import { log } from './logger.js';

if (!requireAuth()) {
  window.location.href = '/login.html';
  throw new Error('not authenticated');
}

// Don't let the WebView restore a stale scroll position from a previous visit — on
// old Android WebViews this leaves the page scrolled up under the status bar until a
// later reflow corrects it (it looked like the page "jumped down" once books loaded).
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

// Numeric per-segment comparison of "X.Y.Z" version strings — a plain string/inequality
// check would wrongly flag an update for e.g. remote "1.2.100" vs local "1.2.99" (lexically
// "100" < "99"), and would also flag one for a LOCAL build ahead of what's published on
// GitHub (a dev/pre-release version), which should never show an update badge.
function parseVersionParts(v) {
  return String(v || '').trim().split('.').map(n => parseInt(n, 10) || 0);
}
function isNewerVersion(remote, local) {
  const r = parseVersionParts(remote);
  const l = parseVersionParts(local);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rn = r[i] || 0, ln = l[i] || 0;
    if (rn !== ln) return rn > ln;
  }
  return false;
}

async function checkForUpdate(localVersion) {
  if (sessionStorage.getItem('br_update_checked')) return;
  sessionStorage.setItem('br_update_checked', '1');
  try {
    const r = await fetch('https://api.github.com/repos/thehijacker/codexa/releases/latest');
    if (!r.ok) return;
    const { tag_name } = await r.json();
    const remote = String(tag_name || '').replace(/^v/, '');
    if (remote && isNewerVersion(remote, localVersion)) {
      document.querySelectorAll('a.logo').forEach(logo => {
        if (logo.querySelector('.update-badge')) return;
        logo.insertAdjacentHTML('beforeend',
          `<a class="update-badge" href="https://github.com/thehijacker/codexa/releases" target="_blank" rel="noopener">v${remote} ↑</a>`
        );
      });
    }
  } catch { /* network unavailable — silently skip */ }
}

function fetchAndShowVersion() {
  fetch('/api/version').then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }).then(({ version }) => {
    // A successful fetch is proof the API is reachable — clear is-offline here too, not
    // just on the 'online' event. navigator.onLine can get stuck reporting false after
    // some network transitions (VPN toggle, adapter change, sleep/resume) without the
    // browser ever firing a matching 'online' event, which otherwise left this class
    // (and the hidden version number) stuck indefinitely.
    document.body.classList.remove('is-offline');
    document.title = `Codexa v${version}`;
    document.querySelectorAll('a.logo').forEach(logo => {
      const ver = logo.querySelector('.app-version');
      if (ver) { ver.textContent = `v${version}`; }
      else { logo.insertAdjacentHTML('beforeend', ` <span class="app-version">v${version}</span>`); }
    });
    checkForUpdate(version);
  }).catch(() => {});
}
fetchAndShowVersion();

// Toggle is-offline class so CSS can show/hide the offline icon and version number.
// Note: body.is-offline is also set/cleared by library.js based on actual API
// reachability, which is more reliable than navigator.onLine on desktop.
function syncOfflineClass() {
  document.body.classList.toggle('is-offline', !navigator.onLine);
  if (navigator.onLine) fetchAndShowVersion();
}
window.addEventListener('online',  syncOfflineClass);
window.addEventListener('offline', syncOfflineClass);

// Self-heal a stuck is-offline: re-verify actual reachability whenever the tab regains
// focus, instead of only reacting to the browser's (occasionally unreliable) online/offline
// events. If the API is really reachable, fetchAndShowVersion's success path above clears
// is-offline regardless of what navigator.onLine currently claims.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') fetchAndShowVersion();
});
syncOfflineClass();

// Push any reading progress made while offline to the server + KOSync. Triggered
// on reconnect and once on load. app:network-restored is the most reliable signal
// (library.js fires it only after the API is confirmed reachable); 'online' is a
// backup for LAN/desktop. Idempotent — safe to call repeatedly.
function flushOfflineProgress() {
  flushProgressOutbox().then(({ count }) => { if (count) log('[app] synced', count, 'offline progress entr' + (count === 1 ? 'y' : 'ies')); }).catch(() => {});
}
window.addEventListener('online', flushOfflineProgress);
document.addEventListener('app:network-restored', flushOfflineProgress);
flushOfflineProgress();

// Fired by library.js when the API becomes reachable after an offline period,
// even when navigator.onLine was already true (LAN-connected, no internet).
document.addEventListener('app:network-restored', fetchAndShowVersion);

(async () => {
  await initI18n();
  await initSidebar({ onShelfSelect: selectShelf });
  initGridDensityToggle();
  // Force an early layout pass + reset scroll so the mobile header's safe-area
  // padding settles immediately after the sidebar/header render, instead of only
  // once the book grid fills in (old WebViews report env(safe-area-inset-*) as 0
  // until a content layout runs).
  requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    void document.body.offsetHeight; // reflow nudge
  });
  await initRouter({
    library:   initLibrary,
    settings:  initSettings,
    opds:      initOpds,
    bookorbit: initBookorbit,
    'bookorbit-dash': initBookorbitDash,
  });
})();

