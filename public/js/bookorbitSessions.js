// BookOrbit reading-session table — shared by the BookOrbit browser's book dialog (bookorbit.js)
// and the Reading tab of Codexa's own info dialog (library.js). These are BookOrbit's own rows for
// the account: every device/reader that reported time, not just what Codexa pushed (Codexa's
// pushed sessions are in there too, indistinguishable from BookOrbit's web reader — it sends no
// source and BookOrbit's list exposes no session ids).
import { t } from './i18n.js';
import { setButtonLoading } from './ui.js';

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDur(secs) {
  if (!secs || secs < 60) return `${secs || 0}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
const fmtDate  = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString() : '—');
const fmtClock = (ts) => (ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

// A session's `source` (web/ios/watchos/android/koreader/manual/kobo/null) collapses to the same
// display buckets BookOrbit's own UI uses — web, manual and unknown are all just "BookOrbit".
function sourceLabel(source) {
  const bucket = ['ios', 'watchos', 'android', 'koreader', 'kobo'].includes(source) ? source : 'bookorbit';
  const key = `stats.source_${bucket}`;
  const v = t(key);
  return v === key ? bucket : v;
}
const bucketLabel = (b) => { const key = `stats.source_${b}`; const v = t(key); return v === key ? b : v; };

function progressCell(r) {
  if (r.endProgress == null) return '—';
  const end = `${Math.round(r.endProgress)}%`;
  const d = r.progressDelta;
  if (d == null || Math.abs(d) < 0.5) return end;
  return `${end} <span class="imt-session-time">${d > 0 ? '+' : '−'}${Math.round(Math.abs(d))}%</span>`;
}

function rowHtml(r) {
  const range = r.endedAt ? `${fmtClock(r.startedAt)} – ${fmtClock(r.endedAt)}` : fmtClock(r.startedAt);
  return `
    <div class="imt-session-row">
      <span class="imt-session-date">${fmtDate(r.startedAt)}<span class="imt-session-time">${range}</span></span>
      <span class="imt-session-dur">${fmtDur(r.durationSeconds)}</span>
      <span class="imt-session-src">${escHtml(sourceLabel(r.source))}</span>
      <span class="imt-session-pages">${progressCell(r)}</span>
    </div>`;
}

function summaryHtml(stats) {
  if (!stats || !stats.totalSessions) return '';
  const range = stats.firstSessionAt
    ? ` &nbsp;&middot;&nbsp; ${fmtDate(stats.firstSessionAt)}${stats.lastSessionAt && fmtDate(stats.lastSessionAt) !== fmtDate(stats.firstSessionAt) ? ` – ${fmtDate(stats.lastSessionAt)}` : ''}`
    : '';
  const split = stats.bySource?.length > 1
    ? `<div class="imt-reading-summary" style="opacity:.8">${stats.bySource.map(x => `${escHtml(bucketLabel(x.bucket))}: ${fmtDur(x.totalSeconds)}`).join(' &nbsp;&middot;&nbsp; ')}</div>`
    : '';
  return `
    <div class="imt-reading-summary">${t('library.reading_total_time')}: <strong>${fmtDur(stats.totalSeconds)}</strong> &nbsp;&middot;&nbsp; ${stats.totalSessions} ${t('library.reading_sessions').toLowerCase()}${range}</div>
    ${split}`;
}

/**
 * Render the session table into `el`, loading pages on demand.
 * @param {HTMLElement} el
 * @param {(page:number) => Promise<{items, total, stats}>} load  — resolves one page (newest first)
 * @param {{summary?: boolean}} opts  summary=false when the caller already shows the totals itself
 */
export async function mountBoSessions(el, load, { summary = true } = {}) {
  if (!el) return;
  let page = 1;
  let items = [];
  let total = 0;
  let stats = null;

  function render() {
    if (!items.length) {
      el.innerHTML = `${summary ? summaryHtml(stats) : ''}<div class="imt-empty">${t('bookorbit.sessions_empty')}</div>`;
      return;
    }
    el.innerHTML = `
      ${summary ? summaryHtml(stats) : ''}
      <div class="imt-session-list imt-bo-sessions">
        <div class="imt-session-header">
          <span>${t('library.session_col_date')}</span>
          <span>${t('library.session_col_dur')}</span>
          <span>${t('bookorbit.session_col_source')}</span>
          <span>${t('bookorbit.session_col_progress')}</span>
        </div>
        ${items.map(rowHtml).join('')}
      </div>
      ${items.length < total ? `<button class="btn btn-secondary btn-sm imt-bo-more">${t('bookorbit.sessions_load_more')}</button>` : ''}`;

    el.querySelector('.imt-bo-more')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      setButtonLoading(btn, true, t('opds.loading'));
      try {
        const next = await load(page + 1);
        page += 1;
        items = items.concat(next.items || []);
        total = next.total ?? total;
        render();
      } catch (err) {
        setButtonLoading(btn, false, t('bookorbit.sessions_load_more'));
      }
    });
  }

  el.innerHTML = `<div class="imt-empty" style="padding:.5rem 0">${t('opds.loading')}</div>`;
  try {
    const first = await load(1);
    items = first?.items || [];
    total = first?.total ?? items.length;
    stats = first?.stats || null;
    render();
  } catch (err) {
    el.innerHTML = `<div class="imt-empty">${escHtml(t('common.err_prefix') + err.message)}</div>`;
  }
}
