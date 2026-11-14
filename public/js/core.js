import { t, lang } from './i18n.js';

export const state = { user: null, shift: null, settings: {}, defaultPassword: false };

/* ---------- API ---------- */
export async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && url !== '/login') {
      window.dispatchEvent(new Event('psm:logout'));
    }
    const err = new Error((data && data.error) || 'server_error');
    err.code = (data && data.error) || 'server_error';
    err.data = data;
    throw err;
  }
  return data;
}
export const get = (u) => api('GET', u);
export const post = (u, b) => api('POST', u, b || {});
export const put = (u, b) => api('PUT', u, b || {});
export const del = (u) => api('DELETE', u);

export function errText(err) {
  const code = err.code || err.message;
  let msg = t('err.' + code);
  if (msg === 'err.' + code) msg = t('err.generic') + (code ? ` (${code})` : '');
  if (err.data && err.data.product) msg += ` — ${err.data.product} (${t('stock')}: ${err.data.stock})`;
  if (err.data && err.data.name && code === 'reservation_conflict') msg += ` — ${err.data.name} ${fmtTime(err.data.start_at)}`;
  return msg;
}

/* ---------- Formatting ---------- */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function money(n, withCur = true) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const s = v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return withCur ? `<span class="num">${s}</span> ${t('egp')}` : s;
}
export const moneyText = (n) => `${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${t('egp')}`;
const locale = () => (lang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');
export const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' }) : '');
export const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const fmtDateTime = (ts) => (ts ? `${fmtDate(ts)} ${fmtTime(ts)}` : '');
export function fmtMinutes(m) {
  m = Math.round(m || 0);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (!h) return `${mm} ${t('min')}`;
  return mm ? `${h} ${t('hr')} ${mm} ${t('min')}` : `${h} ${t('hr')}`;
}
export const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function toLocalInput(ts) {
  const d = new Date(ts);
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const can = (perm) => state.user && (state.user.role === 'admin' || state.user.perms.includes(perm));

/* ---------- UI helpers ---------- */
export function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), isErr ? 5000 : 2800);
}
export const toastErr = (err) => toast(errText(err), true);

/**
 * Open a modal. opts: { title, body (html), foot (html), wide, onMount(el, close) }
 * Returns a promise resolved with whatever close(value) is given.
 */
export function modal({ title, body, foot = '', wide = false, xl = false, onMount, locked = false }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal ${xl ? 'xl' : wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h2>${esc(title)}</h2>${locked ? '' : `<button class="icon-btn" data-close aria-label="${t('close')}">${icon('x')}</button>`}</div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div>`;
    const close = (val) => {
      back.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape' && !locked) close(null); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('mousedown', (e) => { if (e.target === back && !locked) close(null); });
    back.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(null)));
    root.appendChild(back);
    const first = back.querySelector('input:not([type=checkbox]), select, textarea');
    if (first) setTimeout(() => first.focus(), 30);
    if (onMount) onMount(back.querySelector('.modal'), close);
  });
}

export function confirmBox(message, { danger = false, okText } = {}) {
  return modal({
    title: t('confirm'),
    body: `<p style="margin:0">${esc(message)}</p>`,
    foot: `<button class="btn" data-close>${t('cancel')}</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${okText || t('ok')}</button>`,
    onMount: (el, close) => el.querySelector('[data-ok]').addEventListener('click', () => close(true)),
  });
}

// Prompt with a small form; returns object of values or null.
export function formBox(title, fieldsHtml, { okText, wide, validate } = {}) {
  return modal({
    title, wide,
    body: `<form class="form-grid" data-form>${fieldsHtml}<button type="submit" hidden></button></form>`,
    foot: `<button class="btn" data-close>${t('cancel')}</button><button class="btn btn-primary" data-ok>${okText || t('save')}</button>`,
    onMount: (el, close) => {
      const form = el.querySelector('[data-form]');
      const submit = (e) => {
        e && e.preventDefault();
        const vals = formValues(form);
        if (validate) { const msg = validate(vals); if (msg) return toast(msg, true); }
        close(vals);
      };
      form.addEventListener('submit', submit);
      el.querySelector('[data-ok]').addEventListener('click', submit);
    },
  });
}

export function formValues(form) {
  const out = {};
  for (const el of form.querySelectorAll('[name]')) {
    if (el.type === 'checkbox') {
      if (el.dataset.multi) { out[el.name] = out[el.name] || []; if (el.checked) out[el.name].push(el.value); }
      else out[el.name] = el.checked;
    } else out[el.name] = el.value;
  }
  return out;
}

export const field = (label, input, cls = '') => `<label class="field ${cls}">${esc(label)}${input}</label>`;
export const opt = (value, label, sel) => `<option value="${esc(value)}" ${String(value) === String(sel ?? '') ? 'selected' : ''}>${esc(label)}</option>`;

// Click delegation: data-act="name" -> handlers[name](el, event)
export function delegate(root, handlers) {
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    const fn = handlers[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el, e); }
  });
}

// Run an async action with button disabled and errors toasted.
export async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (err) { toastErr(err); return undefined; } finally { if (btn) btn.disabled = false; }
}

/* ---------- Icons (inline SVG, stroke = currentColor) ---------- */
const P = {
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  cart: 'M3 4h2l2.4 11h11L21 7H6.2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM18 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  users: 'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-2a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8',
  box: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  wallet: 'M3 7h18v13H3zM3 7l3-4h12l3 4M16 14h2',
  calendar: 'M4 5h16v16H4zM4 10h16M9 3v4M15 3v4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  cog: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  receipt: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h4v16H7zM13 4h4v16h-4z',
  stop: 'M5 5h14v14H5z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  move: 'M5 12h14M13 6l6 6-6 6',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  check: 'M20 6L9 17l-5-5',
  gamepad: 'M6 11h4M8 9v4M15 12h.01M18 10h.01M17.3 5H6.7a4 4 0 0 0-4 3.6L2 15a3 3 0 0 0 5.3 2l1.2-1.6h7l1.2 1.6A3 3 0 0 0 22 15l-.7-6.4A4 4 0 0 0 17.3 5z',
  print: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
};
export const icon = (name) => `<svg class="ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[name] || ''}"/></svg>`;

// Short beep for timers that reach their end (Web Audio — works offline).
let audioCtx;
export function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.6);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.6);
  } catch { /* no audio */ }
}

export function ls(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch { /* storage blocked */ }
  return null;
}
