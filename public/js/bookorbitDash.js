// BookOrbit Dash — account-wide reading stats panel, powered by BookOrbit's own
// /dashboard/widgets/* endpoints (proxied through server/routes/bookorbit.js's GET /dashboard).
// Distinct from Codexa's own local Statistics modal (library.js's openStatsDialog): that one only
// knows about reading done inside Codexa itself; these numbers cover the whole BookOrbit account
// (KOReader/Kobo/manual sessions too) and include concepts Codexa has no local equivalent of,
// like a yearly reading goal. Gated behind the same "BookOrbit sync enabled" nav visibility as
// the BookOrbit library browser (sidebar.js) and the same offline guard every other
// network-dependent nav item uses (see sidebar.js's #nav-bookorbit-dash click handler).
import { apiFetch } from './api.js';
import { toast } from './ui.js';
import { t } from './i18n.js';

let _initialized = false;
let _lastData     = null; // last successfully fetched dashboard payload, re-rendered (not re-fetched) on langchange

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function coverSrc(boBookId) {
  const token = encodeURIComponent(localStorage.getItem('br_token') || '');
  return `/api/books/bookorbit-cover/${boBookId}?token=${token}`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

// ── Small numeric-input modal for the yearly goal ──────────────────────────────
// Matches the app's established "no native prompt()/confirm()" modal style (see
// reader.js's presetNamePrompt for the text-input sibling of this).
function goalPrompt(defaultValue) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="max-width:320px">
        <h2>${escHtml(t('bookorbit_dash.goal_edit_title'))}</h2>
        <div class="form-group">
          <input type="number" id="bod-goal-input" min="0" step="1" autofocus />
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="bod-goal-cancel">${t('common.cancel')}</button>
          <button class="btn btn-primary"   id="bod-goal-save">${t('common.save')}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const input = backdrop.querySelector('#bod-goal-input');
    input.value = defaultValue != null ? String(defaultValue) : '';
    const close = value => { backdrop.remove(); resolve(value); };
    backdrop.querySelector('#bod-goal-cancel').addEventListener('click', () => close(undefined));
    backdrop.querySelector('#bod-goal-save').addEventListener('click', () => close(input.value));
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(undefined); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') close(input.value); });
    input.focus();
    input.select();
  });
}

async function editGoal(currentGoal) {
  const raw = await goalPrompt(currentGoal);
  if (raw === undefined) return; // cancelled
  const trimmed = String(raw).trim();
  const goalBooks = trimmed === '' ? null : parseInt(trimmed, 10);
  if (goalBooks !== null && (!Number.isInteger(goalBooks) || goalBooks < 0)) {
    toast.error(t('bookorbit_dash.goal_invalid'));
    return;
  }
  try {
    await apiFetch('/bookorbit/dashboard/goal', { method: 'PUT', body: JSON.stringify({ goalBooks }) });
    toast.success(t('bookorbit_dash.goal_saved'));
    await loadDashboard();
  } catch (err) {
    toast.error(t('common.err_prefix') + err.message);
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────────
function renderCards(data) {
  const streak = data.readingStreak;
  const goal = data.readingGoal;
  const overview = data.libraryOverview;

  const streakDots = streak
    ? `<div class="bod-streak-dots">${streak.lastSevenDays.map(d => `<span class="bod-streak-dot${d ? ' filled' : ''}"></span>`).join('')}</div>`
    : '';

  const cards = [];
  cards.push(`
    <div class="stats-card">
      <div class="stats-card-value">${streak ? streak.currentStreak : '–'}</div>
      <div class="stats-card-label">${t('bookorbit_dash.streak_current')}</div>
      ${streakDots}
    </div>`);
  cards.push(`
    <div class="stats-card">
      <div class="stats-card-value">${streak ? streak.longestStreak : '–'}</div>
      <div class="stats-card-label">${t('bookorbit_dash.streak_longest')}</div>
    </div>`);
  cards.push(`
    <div class="stats-card bod-goal-card" id="bod-goal-card" role="button" tabindex="0" title="${escHtml(t('bookorbit_dash.goal_edit_hint'))}">
      <div class="stats-card-value">${goal ? (goal.goalBooks != null ? `${goal.completedBooks} / ${goal.goalBooks}` : t('bookorbit_dash.goal_unset')) : '–'}</div>
      <div class="stats-card-label">${goal ? `${goal.year} ${t('bookorbit_dash.goal_label')}` : t('bookorbit_dash.goal_label')}</div>
    </div>`);
  if (overview) {
    cards.push(`
      <div class="stats-card">
        <div class="stats-card-value">${overview.totalBooks}</div>
        <div class="stats-card-label">${t('bookorbit_dash.overview_books')}</div>
      </div>`);
    cards.push(`
      <div class="stats-card">
        <div class="stats-card-value">${overview.totalAuthors}</div>
        <div class="stats-card-label">${t('bookorbit_dash.overview_authors')}</div>
      </div>`);
    cards.push(`
      <div class="stats-card">
        <div class="stats-card-value">${formatBytes(overview.totalStorageBytes)}</div>
        <div class="stats-card-label">${t('bookorbit_dash.overview_storage')}</div>
      </div>`);
  }

  document.getElementById('bookorbit-dash-cards').innerHTML = cards.join('');
  document.getElementById('bod-goal-card')?.addEventListener('click', () => editGoal(goal?.goalBooks ?? null));
  document.getElementById('bod-goal-card')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editGoal(goal?.goalBooks ?? null); }
  });
}

function bookRowHtml(book, { boBookId, hasCover, title, authors, progress }) {
  const coverHtml = hasCover
    ? `<img src="${coverSrc(boBookId)}" class="stats-book-cover" alt="" loading="lazy">`
    : `<div class="stats-book-cover-ph">\u{1F4D6}</div>`;
  const progressHtml = progress != null
    ? `<div class="bod-progress-track"><div class="bod-progress-bar" style="width:${Math.max(0, Math.min(100, progress))}%"></div></div>`
    : '';
  return `
    <div class="stats-book-row bod-book-row"${book.localBookId ? ` data-local-id="${book.localBookId}" role="button" tabindex="0"` : ''}>
      ${coverHtml}
      <div class="stats-book-info">
        <div class="stats-book-title">${escHtml(title || '')}</div>
        <div class="stats-book-meta">${escHtml((authors || []).join(', '))}</div>
        ${progressHtml}
      </div>
    </div>`;
}

function renderCurrentlyReading(data) {
  const el = document.getElementById('bookorbit-dash-reading');
  const books = data.currentlyReading?.books || [];
  if (!books.length) {
    el.innerHTML = `<div class="stats-section-title">${t('bookorbit_dash.reading_title')}</div><p class="imt-empty">${t('bookorbit_dash.reading_empty')}</p>`;
    return;
  }
  el.innerHTML = `
    <div class="stats-section-title">${t('bookorbit_dash.reading_title')}</div>
    <div class="stats-top-books">
      ${books.map(b => bookRowHtml(b, { boBookId: b.bookId, hasCover: b.hasCover, title: b.title, authors: b.authors, progress: b.progress })).join('')}
    </div>`;
  el.querySelectorAll('.bod-book-row[data-local-id]').forEach(row => {
    const go = () => { window.location.href = `/reader.html?id=${row.dataset.localId}`; };
    row.addEventListener('click', go);
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

function renderHighlight(data) {
  const el = document.getElementById('bookorbit-dash-highlight');
  const h = data.highlightOfTheDay;
  if (!h) { el.innerHTML = ''; return; }
  const coverHtml = h.hasCover
    ? `<img src="${coverSrc(h.bookId)}" class="stats-book-cover" alt="" loading="lazy">`
    : `<div class="stats-book-cover-ph">\u{1F4D6}</div>`;
  el.innerHTML = `
    <div class="stats-section-title">${t('bookorbit_dash.highlight_title')}</div>
    <div class="bod-highlight-card${h.localBookId ? ' bod-clickable' : ''}"${h.localBookId ? ` data-local-id="${h.localBookId}" role="button" tabindex="0"` : ''}>
      ${coverHtml}
      <div class="bod-highlight-body">
        <p class="bod-highlight-text">“${escHtml(h.text)}”</p>
        ${h.note ? `<p class="bod-highlight-note">${escHtml(h.note)}</p>` : ''}
        <div class="stats-book-meta">${escHtml(h.bookTitle || '')}${h.chapterTitle ? ` · ${escHtml(h.chapterTitle)}` : ''}</div>
      </div>
    </div>`;
  const card = el.querySelector('.bod-highlight-card[data-local-id]');
  if (card) {
    const go = () => { window.location.href = `/reader.html?id=${card.dataset.localId}`; };
    card.addEventListener('click', go);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  }
}

async function loadDashboard() {
  const loadingEl = document.getElementById('bookorbit-dash-loading');
  const errorEl   = document.getElementById('bookorbit-dash-error');
  const contentEl = document.getElementById('bookorbit-dash-content');

  loadingEl.hidden = false;
  errorEl.hidden = true;
  contentEl.hidden = true;

  try {
    const data = await apiFetch('/bookorbit/dashboard');
    _lastData = data;
    renderCards(data);
    renderCurrentlyReading(data);
    renderHighlight(data);
    contentEl.hidden = false;
  } catch (err) {
    errorEl.textContent = t('common.err_prefix') + err.message;
    errorEl.hidden = false;
  } finally {
    loadingEl.hidden = true;
  }
}

// Static labels (panel title, loading text, card labels marked up with data-i18n in index.html)
// already re-translate via i18n.js's own applyTranslations() on every langchange — this only
// needs to re-render the JS-built dynamic HTML (cards, currently-reading rows, highlight card),
// which baked in t()-translated strings at render time. Re-renders from the cached last
// response instead of re-fetching, same convention as library.js's own langchange handler.
document.addEventListener('langchange', () => {
  if (!_lastData) return;
  renderCards(_lastData);
  renderCurrentlyReading(_lastData);
  renderHighlight(_lastData);
});

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initBookorbitDash() {
  if (_initialized) return;
  _initialized = true;
  await loadDashboard();
}
