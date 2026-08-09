/**
 * api.js — centralised fetch wrapper
 * Reads the JWT from localStorage and attaches it to every request.
 */
import { t } from './i18n.js';
import { log } from './logger.js';

const API_BASE = '/api';

export function getToken() {
  return localStorage.getItem('br_token');
}

export function setToken(token) {
  localStorage.setItem('br_token', token);
}

export function clearToken() {
  localStorage.removeItem('br_token');
  localStorage.removeItem('br_user');
}

export async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };

  // Strip internal timeout option before passing to fetch
  const { timeout: _unused, ...fetchOptions } = options;

  // NOTE: AbortController/signal intentionally omitted from fetch().
  // Passing signal to fetch() causes the request to hang indefinitely on some
  // old Chromium-based WebViews (inkPalmPlus/zxh_wv_te Android 11).
  // Timeouts for critical calls are handled via withTimeout() (Promise.race +
  // setTimeout) in the caller, or via XHR with native xhr.timeout.
  log('[api] fetch>', path);
  const res = await fetch(`${API_BASE}${path}`, {
    ...fetchOptions,
    headers,
  });
  log('[api] fetch<', path, res.status);

  // If the server sends 401 AND we had a token, it means the session expired.
  // If there was no token (e.g. a login attempt with wrong credentials), fall
  // through to the normal error handler so body.error is translated correctly.
  if (res.status === 401) {
    const hadToken = !!getToken();
    if (hadToken) {
      clearToken();
      if (!window.location.pathname.includes('/login.html')) {
        window.location.href = '/login.html';
      }
      throw new Error(t('error.session_expired'));
    }
  }

  if (!res.ok) {
    let msg = t('error.http_error', { status: res.status });
    let body = null;
    try {
      body = await res.json();
      // body.error may be an i18n key (e.g. 'error.wrong_credentials') or a plain message
      if (body.error) {
        const translated = t(body.error);
        msg = (translated !== body.error) ? translated : body.error;
      }
    } catch { /* ignore */ }
    const err = new Error(msg);
    if (body) err.data = body;
    throw err;
  }

  // 204 No Content
  if (res.status === 204) return null;

  // A reverse proxy in front of the API (e.g. Cloudflare Firewall/WAF rules, IP Access Rules,
  // "Managed Challenge") can answer with a 2xx HTTP status but an HTML interstitial body
  // instead of real JSON — res.ok is true here, so without this guard res.json() would throw
  // a raw SyntaxError that many callers across the app don't wrap in try/catch, instead of the
  // same translated error shape every other failure already produces.
  try {
    return await res.json();
  } catch {
    throw new Error(t('error.http_error', { status: res.status }));
  }
}

/**
 * Like apiFetch, but for FormData uploads that need progress reporting. fetch() only exposes
 * download progress (via the response body stream) — there's no cross-browser way to observe
 * request-upload progress through it, so this uses XMLHttpRequest's upload.onprogress instead.
 * Same auth header attachment and translated-error-on-failure behavior as apiFetch.
 * `onProgress(loaded, total)` fires repeatedly as the body streams to the server; `total` is
 * the request body size (the file(s) being uploaded), not the eventual server response.
 */
export function apiUpload(path, formData, onProgress) {
  const token = getToken();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}${path}`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    });

    xhr.addEventListener('load', () => {
      log('[api] upload<', path, xhr.status);
      if (xhr.status === 401 && token) {
        clearToken();
        if (!window.location.pathname.includes('/login.html')) {
          window.location.href = '/login.html';
        }
        reject(new Error(t('error.session_expired')));
        return;
      }
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON body */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body);
        return;
      }
      let msg = t('error.http_error', { status: xhr.status });
      if (body?.error) {
        const translated = t(body.error);
        msg = (translated !== body.error) ? translated : body.error;
      }
      const err = new Error(msg);
      if (body) err.data = body;
      reject(err);
    });

    xhr.addEventListener('error', () => reject(new Error(t('error.http_error', { status: 0 }))));

    log('[api] upload>', path);
    xhr.send(formData);
  });
}

export function requireAuth() {
  const token = getToken();
  if (!token) {
    window.location.href = '/login.html';
    return false;
  }
  return true;
}
