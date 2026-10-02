const PANELS = ['library', 'settings', 'opds', 'bookorbit', 'bookorbit-dash'];
const _inits  = {};
let _current  = null;

export function getCurrentPanel() { return _current; }

export async function showPanel(name, pushState = true, opts = {}) {
  if (!PANELS.includes(name)) name = 'library';

  PANELS.forEach(p => {
    const el = document.getElementById(`panel-${p}`);
    if (el) el.hidden = (p !== name);
  });

  // Drive body class for OPDS/BookOrbit overflow behaviour (both panels are flex-layout,
  // internally-scrolling catalogs rather than the normal scrolling page body).
  const bodyEl = document.querySelector('.app-body');
  bodyEl?.classList.toggle('opds-active', name === 'opds');
  bodyEl?.classList.toggle('bookorbit-active', name === 'bookorbit');

  _current = name;

  let url = name === 'library' ? '/' : `/?panel=${name}`;
  if (opts.tab) url += `${url.includes('?') ? '&' : '?'}tab=${opts.tab}`;
  if (pushState && (location.pathname + location.search !== url)) {
    history.pushState({ panel: name, ...opts }, '', url);
  }

  document.dispatchEvent(new CustomEvent('panelchange', { detail: { panel: name, ...opts } }));

  if (_inits[name]) {
    const fn = _inits[name];
    delete _inits[name]; // init each panel once
    await fn();
  }
}

export async function initRouter(initMap) {
  for (const [name, fn] of Object.entries(initMap)) {
    _inits[name] = fn;
  }

  window.addEventListener('popstate', e => {
    const params = new URLSearchParams(location.search);
    const p   = e.state?.panel || params.get('panel') || 'library';
    const tab = e.state?.tab   || params.get('tab')    || undefined;
    showPanel(p, false, tab ? { tab } : {});
  });

  const params  = new URLSearchParams(location.search);
  const initial = params.get('panel') || 'library';
  const tab     = params.get('tab') || undefined;
  await showPanel(initial, false, tab ? { tab } : {});
}
