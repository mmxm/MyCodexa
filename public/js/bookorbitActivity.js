// BookOrbit Dash → Activity tab. Everything here comes from BookOrbit's own user-statistics
// (proxied and trimmed by server/routes/bookorbit.js: GET /bookorbit/activity, /activity/calendar/:year,
// /activity/day/:day), so it covers every device on the BookOrbit account — KOReader, Kobo, the
// web reader, mobile apps, and what Codexa itself pushed — unlike Codexa's own local Statistics
// dialog. Charts are inline SVG on the theme's CSS variables (no chart library; monochrome-safe for
// the e-ink theme, where intensity is stepped opacity rather than hue). No Array.at / aspect-ratio:
// this also has to run in the old Android WebView.
import { apiFetch } from './api.js';
import { t, getCurrentLang } from './i18n.js';

const STALE_MS = 5 * 60 * 1000;

let root = null;          // the pane element
let data = null;          // GET /bookorbit/activity payload
let calendar = null;      // calendar for the selected year (data.calendar initially)
let selectedDay = null;
const dayCache = new Map(); // 'YYYY-MM-DD' -> day detail
let loadedAt = 0;

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDur(secs) {
  secs = Math.round(secs || 0);
  if (secs < 60) return `${secs}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
const mins = (secs) => Math.round((secs || 0) / 60);

const lang = () => getCurrentLang() || undefined;
// Mon-first helpers over Intl. dayOfWeek is BookOrbit's 0=Sunday; 2024-01-07 was a Sunday.
const weekdayName = (dow, style = 'short') => new Date(2024, 0, 7 + dow).toLocaleDateString(lang(), { weekday: style });
const monthName   = (m, style = 'short')   => new Date(2024, m - 1, 1).toLocaleDateString(lang(), { month: style });
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseDay(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
const fmtLongDay = (ymd) => { const d = parseDay(ymd); return d ? d.toLocaleDateString(lang(), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : ymd; };

function sourceLabel(bucket) {
  const k = `stats.source_${bucket}`;
  const v = t(k);
  return v === k ? bucket : v;
}

// ── summary cards ────────────────────────────────────────────────────────────
function deltaHtml(cur, prev) {
  if (!prev && !cur) return '';
  if (!prev) return ` <span class="bod-delta">▲</span>`;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return '';
  return ` <span class="bod-delta">${pct > 0 ? '▲' : '▼'}${Math.abs(pct)}%</span>`;
}

function cardsHtml(d) {
  const s = d.snapshot;
  const fav = d.rhythm.favoriteDayOfWeek;
  const cards = [
    [t('bookorbit_dash.act_today'),      fmtDur(s.todaySeconds)],
    [t('bookorbit_dash.act_week'),       `${fmtDur(s.lastSevenDays)}${deltaHtml(s.lastSevenDays, s.previousSevenDays)}`],
    [t('bookorbit_dash.act_year_books'), String(s.completedBooksYtd)],
    [t('bookorbit_dash.act_median'),     d.medianSessionSeconds != null ? fmtDur(d.medianSessionSeconds) : '–'],
    [t('bookorbit_dash.act_fav_day'),    fav != null ? weekdayName(fav) : '–'],
    [t('bookorbit_dash.act_peak_hour'),  d.rhythm.peakHour != null ? `${String(d.rhythm.peakHour).padStart(2, '0')}:00` : '–'],
  ];
  return `<div class="stats-summary-grid">${cards.map(([label, value]) =>
    `<div class="stats-card"><div class="stats-card-value">${value}</div><div class="stats-card-label">${escHtml(label)}</div></div>`).join('')}</div>`;
}

// ── heatmap ──────────────────────────────────────────────────────────────────
const CELL = 11, GAP = 2, STEP = CELL + GAP, PAD_L = 24, PAD_T = 16;

function quantiles(vals) {
  const s = vals.slice().sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return [q(0.25), q(0.5), q(0.75)];
}

function heatmapSvg(cal) {
  const byDay = new Map(cal.days.map(x => [x.day, x.readingSeconds]));
  const active = cal.days.filter(x => x.readingSeconds > 0).map(x => x.readingSeconds);
  const th = active.length ? quantiles(active) : [0, 0, 0];
  const level = (sec) => {
    if (sec <= 0) return 0;
    let l = 1;
    if (sec > th[0]) l++;
    if (sec > th[1]) l++;
    if (sec > th[2]) l++;
    return l;
  };

  const jan1 = new Date(cal.year, 0, 1);
  const offset = (jan1.getDay() + 6) % 7; // Monday-first row of Jan 1
  const daysInYear = (new Date(cal.year + 1, 0, 1) - jan1) / 86400000;
  const cols = Math.ceil((offset + daysInYear) / 7);
  const width = PAD_L + cols * STEP;
  const height = PAD_T + 7 * STEP;
  const todayStr = ymdLocal(new Date());

  let cells = '';
  let monthLabels = '';
  let lastMonth = -1;
  for (let i = 0; i < daysInYear; i++) {
    const d = new Date(cal.year, 0, 1 + i);
    const ymd = ymdLocal(d);
    const col = Math.floor((i + offset) / 7);
    const row = (i + offset) % 7;
    const x = PAD_L + col * STEP;
    const y = PAD_T + row * STEP;
    if (d.getMonth() !== lastMonth && row < 4) { // label the column where a month starts
      lastMonth = d.getMonth();
      monthLabels += `<text x="${x}" y="${PAD_T - 5}">${escHtml(monthName(d.getMonth() + 1))}</text>`;
    }
    const sec = byDay.get(ymd) || 0;
    const future = ymd > todayStr;
    const cls = future ? 'hc f' : `hc h${level(sec)}${ymd === selectedDay ? ' sel' : ''}`;
    const title = future ? '' : `<title>${escHtml(fmtLongDay(ymd))} · ${sec > 0 ? fmtDur(sec) : '0'}</title>`;
    const interactive = !future && sec > 0;
    cells += `<rect class="${cls}" x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2"${interactive ? ` data-day="${ymd}" tabindex="0" role="button" aria-label="${escHtml(fmtLongDay(ymd))}, ${fmtDur(sec)}"` : ''}>${title}</rect>`;
  }
  const rowLabels = [0, 2, 4].map(r =>
    `<text x="${PAD_L - 5}" y="${PAD_T + r * STEP + CELL - 1}" text-anchor="end">${escHtml(weekdayName(MON_FIRST[r]))}</text>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escHtml(t('bookorbit_dash.act_heatmap_title'))}">${monthLabels}${rowLabels}${cells}</svg>`;
}

function heatmapSectionHtml() {
  const years = calendar.availableYears?.length ? calendar.availableYears.slice().sort((a, b) => a - b) : [calendar.year];
  const i = years.indexOf(calendar.year);
  const prev = i > 0 ? years[i - 1] : null;
  const next = i >= 0 && i < years.length - 1 ? years[i + 1] : null;
  const activeDays = calendar.days.filter(x => x.readingSeconds > 0);
  const total = activeDays.reduce((a, x) => a + x.readingSeconds, 0);
  return `
    <div class="bod-heat-head">
      <div class="stats-section-title" style="margin:0">${t('bookorbit_dash.act_heatmap_title')}</div>
      <div class="bod-year-nav">
        <button type="button" class="btn btn-secondary btn-sm bod-year-btn" data-year="${prev ?? ''}" ${prev == null ? 'disabled' : ''} aria-label="${escHtml(t('bookorbit_dash.act_prev_year'))}">‹</button>
        <strong>${calendar.year}</strong>
        <button type="button" class="btn btn-secondary btn-sm bod-year-btn" data-year="${next ?? ''}" ${next == null ? 'disabled' : ''} aria-label="${escHtml(t('bookorbit_dash.act_next_year'))}">›</button>
      </div>
    </div>
    <div class="imt-reading-summary">${t('bookorbit_dash.act_heatmap_summary', { days: activeDays.length, time: fmtDur(total) })}</div>
    <div class="bod-heat"><div class="bod-heat-scroll" id="bod-heat-scroll">${heatmapSvg(calendar)}</div></div>
    <div class="bod-heat-legend"><span>${t('bookorbit_dash.act_less')}</span>
      <svg viewBox="0 0 70 11" width="70" height="11" aria-hidden="true">${[0, 1, 2, 3, 4].map(l => `<rect class="hc h${l}" x="${l * 14}" y="0" width="11" height="11" rx="2"/>`).join('')}</svg>
      <span>${t('bookorbit_dash.act_more')}</span></div>
    <div id="bod-day-detail" class="bod-day-detail"></div>`;
}

function dayDetailHtml(det) {
  if (!det.sessions.length) return `<div class="imt-empty">${t('bookorbit_dash.act_day_empty')}</div>`;
  const clock = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const rows = det.sessions.map(s => {
    const title = escHtml(s.bookTitle || '—');
    const name = s.localBookId ? `<a href="/reader.html?id=${s.localBookId}">${title}</a>` : title;
    const delta = s.progressDelta != null && Math.abs(s.progressDelta) >= 0.5 ? ` &middot; ${s.progressDelta > 0 ? '+' : '−'}${Math.round(Math.abs(s.progressDelta))}%` : '';
    return `
      <div class="imt-session-row">
        <span class="imt-session-date">${name}<span class="imt-session-time">${clock(s.startedAt)} – ${clock(s.endedAt)}${delta}</span></span>
        <span class="imt-session-dur">${fmtDur(s.durationOnDaySeconds)}</span>
        <span class="imt-session-src">${escHtml(sourceLabel(s.sourceBucket))}</span>
      </div>`;
  }).join('');
  return `
    <div class="imt-reading-summary" style="margin-top:.6rem"><strong>${escHtml(fmtLongDay(det.day))}</strong> &middot; ${fmtDur(det.readingSeconds)}</div>
    <div class="imt-session-list bod-day-list">${rows}</div>`;
}

// ── small chart helpers (shared by goal / rhythm / finished-per-month) ───────
const CW = 300, CH = 96, CL = 28, CR = 8, CT = 8, CB = 18;

function barChart(items, { labelEvery = 1, unit = 'm', ariaLabel }) {
  // items: [{ label, value, title, hl }]
  const max = Math.max(1, ...items.map(i => i.value));
  const slot = (CW - CL - CR) / items.length;
  const bw = Math.max(2, slot * 0.7);
  const bars = items.map((it, i) => {
    const h = (it.value / max) * (CH - CT - CB);
    const x = CL + i * slot + (slot - bw) / 2;
    return `<rect class="bar${it.hl ? ' hl' : ''}" x="${x.toFixed(1)}" y="${(CH - CB - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"><title>${escHtml(it.title)}</title></rect>` +
      (i % labelEvery === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${CH - 4}" text-anchor="middle">${escHtml(it.label)}</text>` : '');
  }).join('');
  return `<div class="imt-bo-chart bod-bars"><svg viewBox="0 0 ${CW} ${CH}" role="img" aria-label="${escHtml(ariaLabel)}">
    <line class="gr" x1="${CL}" x2="${CW - CR}" y1="${CH - CB}" y2="${CH - CB}"/>
    <text x="${CL - 4}" y="${CT + 3}" text-anchor="end">${max}${unit}</text>${bars}</svg></div>`;
}

function goalHtml(g) {
  if (!g || g.goalBooks == null) {
    return `<div class="stats-section-title">${t('bookorbit_dash.act_goal_title')}</div><div class="imt-empty">${t('bookorbit_dash.act_goal_none')}</div>`;
  }
  const nowMonth = g.year === new Date().getFullYear() ? new Date().getMonth() + 1 : 12;
  const pts = g.points;
  const actual = pts.filter(p => p.month <= nowMonth);
  const max = Math.max(1, g.goalBooks, ...pts.map(p => Math.max(p.actualCumulative, p.targetCumulative || 0)));
  const X = m => (CL + (m - 1) / 11 * (CW - CL - CR)).toFixed(1);
  const Y = v => (CT + (1 - v / max) * (CH - CT - CB)).toFixed(1);
  const line = (arr, key) => arr.filter(p => p[key] != null).map((p, i) => `${i ? 'L' : 'M'}${X(p.month)} ${Y(p[key])}`).join(' ');
  const labels = [1, 4, 7, 10, 12].map(m => `<text x="${X(m)}" y="${CH - 4}" text-anchor="middle">${escHtml(monthName(m, 'narrow'))}</text>`).join('');
  const status = g.status ? t(`bookorbit_dash.act_goal_${g.status === 'on_pace' ? 'on_pace' : g.status}`) : '';
  return `
    <div class="stats-section-title">${t('bookorbit_dash.act_goal_title')}</div>
    <div class="imt-reading-summary"><strong>${g.completedBooks} / ${g.goalBooks}</strong>${status ? ` &middot; ${escHtml(status)}` : ''} &middot; ${t('bookorbit_dash.act_goal_projected', { n: Math.round(g.projectedBooks * 10) / 10 })}</div>
    <div class="imt-bo-chart"><svg viewBox="0 0 ${CW} ${CH}" role="img" aria-label="${escHtml(t('bookorbit_dash.act_goal_title'))}">
      <line class="gr" x1="${CL}" x2="${CW - CR}" y1="${CH - CB}" y2="${CH - CB}"/>
      <text x="${CL - 4}" y="${Number(Y(max)) + 3}" text-anchor="end">${max}</text>
      <path class="ln tgt" d="${line(pts, 'targetCumulative')}"/>
      <path class="ln" d="${line(actual, 'actualCumulative')}"/>${labels}
    </svg></div>
    <div class="imt-reading-summary" style="opacity:.8"><span class="bod-key bod-key-actual"></span> ${t('bookorbit_dash.act_actual')} &nbsp; <span class="bod-key bod-key-target"></span> ${t('bookorbit_dash.act_target')}</div>`;
}

function rhythmHtml(r) {
  const byDow = new Map(r.weekdays.map(w => [w.dayOfWeek, w.averageReadingSeconds]));
  const wk = MON_FIRST.map(dow => ({ label: weekdayName(dow), value: mins(byDow.get(dow)), title: `${weekdayName(dow, 'long')} · ${fmtDur(byDow.get(dow))}`, hl: dow === r.favoriteDayOfWeek }));
  const byHour = new Map(r.hours.map(h => [h.hour, h.readingSeconds]));
  const hrs = Array.from({ length: 24 }, (_, h) => ({ label: String(h), value: mins(byHour.get(h)), title: `${String(h).padStart(2, '0')}:00 · ${fmtDur(byHour.get(h))}`, hl: h === r.peakHour }));
  const anyHour = hrs.some(h => h.value > 0);
  return `
    <div class="stats-section-title">${t('bookorbit_dash.act_weekday_title')}</div>
    ${barChart(wk, { ariaLabel: t('bookorbit_dash.act_weekday_title') })}
    ${anyHour ? `<div class="stats-section-title">${t('bookorbit_dash.act_hour_title')}</div>${barChart(hrs, { labelEvery: 6, ariaLabel: t('bookorbit_dash.act_hour_title') })}` : ''}`;
}

function sourcesHtml(sources) {
  const total = sources.reduce((a, s) => a + s.totalSeconds, 0);
  if (!total) return '';
  const rows = sources.slice().sort((a, b) => b.totalSeconds - a.totalSeconds).map(s => {
    const pct = Math.round(s.totalSeconds / total * 100);
    return `
      <div class="bod-src-row">
        <div class="bod-src-label"><span>${escHtml(sourceLabel(s.bucket))}</span><span>${fmtDur(s.totalSeconds)} &middot; ${pct}%</span></div>
        <div class="bod-progress-track"><div class="bod-progress-bar" style="width:${Math.max(2, pct)}%"></div></div>
      </div>`;
  }).join('');
  return `<div class="stats-section-title">${t('bookorbit_dash.act_sources_title')}</div>${rows}`;
}

function finishedHtml(months) {
  // Last 12 calendar months ending now, gaps filled with 0.
  const now = new Date();
  const counts = new Map(months.map(m => [`${m.year}-${m.month}`, m.count]));
  const items = [];
  for (let k = 11; k >= 0; k--) {
    const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const n = counts.get(`${d.getFullYear()}-${d.getMonth() + 1}`) || 0;
    items.push({ label: monthName(d.getMonth() + 1, 'narrow'), value: n, title: `${d.toLocaleDateString(lang(), { month: 'long', year: 'numeric' })} · ${n}` });
  }
  if (!items.some(i => i.value > 0)) return '';
  return `<div class="stats-section-title">${t('bookorbit_dash.act_finished_title')}</div>${barChart(items, { unit: '', ariaLabel: t('bookorbit_dash.act_finished_title') })}`;
}

// ── mounting / interaction ───────────────────────────────────────────────────
function isEmpty(d) {
  return !d.calendar?.days?.some(x => x.readingSeconds > 0) && !d.snapshot.lastSevenDays && !d.snapshot.completedBooksYtd;
}

function render() {
  if (!root || !data) return;
  if (isEmpty(data)) { root.innerHTML = `<div class="imt-empty" style="padding:1rem 0">${t('bookorbit_dash.act_empty')}</div>`; return; }
  root.innerHTML = `
    ${cardsHtml(data)}
    <div class="bookorbit-dash-section" id="bod-heat-section">${calendar ? heatmapSectionHtml() : ''}</div>
    <div class="bookorbit-dash-section">${goalHtml(data.goal)}</div>
    <div class="bookorbit-dash-section">${rhythmHtml(data.rhythm)}</div>
    <div class="bookorbit-dash-section">${sourcesHtml(data.sources)}${finishedHtml(data.completion.months)}</div>`;
  bindHeatmap();
  scrollHeatmap();
  if (selectedDay && dayCache.has(selectedDay)) {
    const el = root.querySelector('#bod-day-detail');
    if (el) el.innerHTML = dayDetailHtml(dayCache.get(selectedDay));
  }
}

function renderHeatSection() {
  const sec = root?.querySelector('#bod-heat-section');
  if (!sec || !calendar) return;
  sec.innerHTML = heatmapSectionHtml();
  bindHeatmap();
  scrollHeatmap();
}

function scrollHeatmap() {
  const sc = root?.querySelector('#bod-heat-scroll');
  if (sc) sc.scrollLeft = calendar?.year === new Date().getFullYear() ? sc.scrollWidth : 0; // show the latest weeks
}

async function selectDay(ymd) {
  selectedDay = ymd;
  root.querySelectorAll('.hc.sel').forEach(el => el.classList.remove('sel'));
  root.querySelector(`.hc[data-day="${ymd}"]`)?.classList.add('sel');
  const el = root.querySelector('#bod-day-detail');
  if (!el) return;
  if (!dayCache.has(ymd)) {
    el.innerHTML = `<div class="imt-empty" style="padding:.5rem 0">${t('opds.loading')}</div>`;
    try {
      dayCache.set(ymd, await apiFetch(`/bookorbit/activity/day/${ymd}`));
    } catch (err) {
      el.innerHTML = `<div class="imt-empty">${escHtml(t('common.err_prefix') + err.message)}</div>`;
      return;
    }
  }
  if (selectedDay === ymd) el.innerHTML = dayDetailHtml(dayCache.get(ymd));
}

async function changeYear(year) {
  try {
    calendar = await apiFetch(`/bookorbit/activity/calendar/${year}`);
    selectedDay = null;
    renderHeatSection();
  } catch (err) {
    const el = root?.querySelector('#bod-day-detail');
    if (el) el.innerHTML = `<div class="imt-empty">${escHtml(t('common.err_prefix') + err.message)}</div>`;
  }
}

function bindHeatmap() {
  const sec = root?.querySelector('#bod-heat-section');
  if (!sec || sec.dataset.bound) return; // renderHeatSection() rewrites this same element's contents — bind once
  sec.dataset.bound = '1';
  const pick = (e) => e.target.closest?.('[data-day]');
  sec.addEventListener('click', (e) => {
    const yb = e.target.closest?.('.bod-year-btn');
    if (yb && !yb.disabled && yb.dataset.year) { changeYear(yb.dataset.year); return; }
    const c = pick(e);
    if (c) selectDay(c.dataset.day);
  });
  sec.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const c = pick(e);
    if (c) { e.preventDefault(); selectDay(c.dataset.day); }
  });
}

export const activityIsStale = () => !data || Date.now() - loadedAt > STALE_MS;

export async function mountActivity(el, { refresh = false } = {}) {
  root = el;
  if (!data) root.innerHTML = `<div class="imt-empty" style="padding:1rem 0">${t('opds.loading')}</div>`;
  try {
    data = await apiFetch(`/bookorbit/activity${refresh ? '?refresh=1' : ''}`);
    calendar = data.calendar;
    selectedDay = null;
    dayCache.clear();
    loadedAt = Date.now();
    render();
  } catch (err) {
    if (!data) root.innerHTML = `<div class="alert alert-error">${escHtml(t('common.err_prefix') + err.message)}</div>`;
  }
}

// Weekday/month names, legends and card labels were baked in with t()/Intl at render time.
document.addEventListener('langchange', () => { if (data) render(); });
