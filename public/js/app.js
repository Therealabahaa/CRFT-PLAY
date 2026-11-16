import { t, lang, setLang, applyDir, setDefaultLang } from './i18n.js';
import { state, get, post, esc, icon, can, errText, ls, fmtTime, planOk, lockedHtml, PLAN_NAMES } from './core.js';

// plan: the bundle a page needs (src/plan.js); below it the page shows 🔒 and a short note instead
const PAGES = [
  { id: 'floor', icon: 'gamepad', mod: './pages/floor.js' },
  { id: 'pos', icon: 'cart', mod: './pages/pos.js' },
  { id: 'reservations', icon: 'calendar', mod: './pages/reservations.js', plan: 'pro' },
  { id: 'customers', icon: 'users', mod: './pages/customers.js', plan: 'pro' },
  { id: 'invoices', icon: 'receipt', mod: './pages/invoices.js' },
  { id: 'inventory', icon: 'box', mod: './pages/inventory.js', plan: 'pro' },
  { id: 'expenses', icon: 'wallet', mod: './pages/expenses.js', perm: 'expenses', plan: 'pro' },
  { id: 'shift', icon: 'clock', mod: './pages/shift.js' },
  { id: 'reports', icon: 'chart', mod: './pages/reports.js', perm: 'reports', plan: 'pro' },
  { id: 'settings', icon: 'cog', mod: './pages/settings.js' },
];

const app = document.getElementById('app');
let cleanup = null;
let clockTimer = null;

function applyTheme() {
  const th = ls('psm_theme');
  if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th;
  else delete document.documentElement.dataset.theme;
}

// Sign-in screen — brand panel + staff picker, adapted from Kur / Iki.
let loginClock = null;
async function renderLogin() {
  if (cleanup) { cleanup(); cleanup = null; }
  clearInterval(loginClock);
  let info;
  try { info = await get('/login-info'); } catch {
    app.innerHTML = `<main class="signin"><section class="si-panel"><div class="si-inner"><h2>${t('cant_start')}</h2><p class="muted">${t('cant_start_hint')}</p></div></section></main>`;
    return;
  }
  setDefaultLang(info.language);
  const sh = info.open_shift;
  const last = ls('psm_last_user');
  app.innerHTML = `<main class="signin">
    <section class="si-brand"><div class="si-grid"></div><div class="si-glow"></div>
      <div class="si-brandin"><img class="si-mark" src="/crft-mark.png" alt="crft."><h1>${esc(info.shop_name || t('app_name'))}</h1><p>${t('si_tagline')}</p></div>
      <footer class="si-clock num" id="si-clock">&nbsp;</footer></section>
    <section class="si-panel"><div class="si-inner">
      <header><h2>${t('sign_in')}</h2><p>${t('si_hint')}</p></header>
      ${sh ? `<p class="si-banner">${icon('clock')} ${t('si_shift_open').replace('{id}', sh.id).replace('{name}', esc(sh.owner_name)).replace('{time}', fmtTime(sh.opened_at))}</p>` : ''}
      <label class="si-field"><span>${t('staff')}</span><select id="si-staff">${info.staff.length
        ? info.staff.map((s) => `<option value="${s.id}" ${String(s.id) === last ? 'selected' : ''}>${esc(s.name)} — ${t('role.' + s.role)}</option>`).join('')
        : `<option value="">${t('no_staff')}</option>`}</select></label>
      <label class="si-field"><span>${t('password')}</span><input id="si-pw" type="password" maxlength="40" autocomplete="off" placeholder="${t('type_password')}"></label>
      <p class="si-status" id="si-status" role="status">&nbsp;</p>
      <button class="si-btn" id="si-go" disabled>${t('sign_in')}</button>
      ${info.default_admin ? `<p class="si-hint">${icon('alert')} ${t('first_login_hint')}</p>` : ''}
      <button type="button" class="btn btn-ghost btn-sm si-lang" id="lang-btn">${icon('globe')} ${lang() === 'ar' ? 'English' : 'العربية'}</button>
    </div></section></main>`;
  const $ = (s) => app.querySelector(s);
  const staffEl = $('#si-staff'), pw = $('#si-pw'), go = $('#si-go'), status = $('#si-status');
  let busy = false;
  const refresh = () => { go.disabled = busy || !staffEl.value || !pw.value.length; };
  const setStatus = (m, isBad) => { status.textContent = m || ' '; status.className = 'si-status' + (isBad ? ' bad' : ''); };
  const tick = () => {
    const c = document.getElementById('si-clock');
    if (!c) return clearInterval(loginClock);
    const n = new Date();
    const loc = lang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';
    c.textContent = `${n.toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}  ·  ${n.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })}`;
  };
  tick();
  loginClock = setInterval(tick, 1000);
  const submit = async () => {
    if (go.disabled) return;
    busy = true; refresh(); setStatus(t('checking'));
    try {
      const res = await post('/login', { user_id: Number(staffEl.value), password: pw.value });
      clearInterval(loginClock);
      ls('psm_last_user', staffEl.value);
      state.user = res.user;
      state.defaultPassword = res.default_password;
      if (res.needs_shift) location.hash = '#/shift';
      await boot();
    } catch (err) {
      busy = false;
      let msg = errText(err);
      if (err.code === 'wrong_password_login' && err.data && err.data.left <= 2) msg += ` — ${t('attempts_left').replace('{n}', err.data.left)}`;
      if (err.code === 'too_many_attempts' && err.data) msg = t('err.too_many_attempts').replace('{s}', err.data.wait);
      setStatus(msg, true);
      pw.value = '';
      pw.classList.remove('shake'); void pw.offsetWidth; pw.classList.add('shake');
      refresh(); pw.focus();
    }
  };
  pw.addEventListener('input', () => { pw.classList.remove('shake'); refresh(); });
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  staffEl.addEventListener('change', () => { setStatus(''); refresh(); pw.focus(); });
  go.addEventListener('click', submit);
  $('#lang-btn').onclick = () => { setLang(lang() === 'ar' ? 'en' : 'ar'); renderLogin(); tellDesktopLanguage(); };
  pw.focus();
}

export async function refreshShift() {
  try { state.shift = await get('/shifts/current'); } catch { state.shift = null; }
  const el = document.getElementById('shift-pill');
  if (el) {
    el.className = 'pill ' + (state.shift ? 'good' : 'warn');
    el.innerHTML = state.shift
      ? `<span class="dot"></span>${t('shift_open')} · ${esc(state.shift.user_name)} · ${fmtTime(state.shift.opened_at)}`
      : `<span class="dot"></span>${t('no_shift')}`;
  }
}

function renderShell() {
  const visible = PAGES.filter((p) => !p.perm || can(p.perm));
  app.innerHTML = `<div class="shell">
    <aside class="side">
      <div class="brand"><img class="brand-logo" src="/crft-icon.png" alt=""><span>${esc(state.settings.shop_name || t('app_name'))}</span></div>
      <nav class="nav">${visible.map((p) => `<a href="#/${p.id}" data-page="${p.id}" draggable="false">${icon(p.icon)}<span>${t('nav.' + p.id)}${planOk(p.plan) ? '' : ` <small style="opacity:.6" title="${PLAN_NAMES[p.plan]}">🔒</small>`}</span></a>`).join('')}</nav>
      <div class="side-foot">
        <div class="row small"><span>${icon('user')}</span><b>${esc(state.user.name)}</b><span class="muted">${t('role.' + state.user.role)}</span></div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <a href="#/shift" id="shift-pill" class="pill" style="text-decoration:none"></a>
        <span class="spacer"></span>
        <span class="num muted" id="clock"></span>
        <button class="icon-btn" id="theme-btn" title="${t('theme')}" aria-label="${t('theme')}">${icon('moon')}</button>
        <button class="btn btn-sm btn-ghost" id="lang-btn">${icon('globe')} ${lang() === 'ar' ? 'EN' : 'ع'}</button>
        <button class="btn btn-sm btn-ghost" id="logout-btn">${icon('logout')} ${t('logout')}</button>
      </header>
      ${state.defaultPassword ? `<div class="banner crit" style="margin:16px 24px 0">${icon('alert')} ${t('default_password_warning')} <a href="#/settings">${t('change_password')}</a></div>` : ''}
      <div id="page"></div>
    </div>
  </div>`;
  app.querySelector('#lang-btn').onclick = () => { setLang(lang() === 'ar' ? 'en' : 'ar'); renderShell(); route(); tellDesktopLanguage(); };
  app.querySelector('#theme-btn').onclick = () => {
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    ls('psm_theme', dark ? 'light' : 'dark');
    applyTheme();
  };
  app.querySelector('#logout-btn').onclick = async () => {
    try { await post('/logout'); } catch { /* ignore */ }
    state.user = null;
    renderLogin();
  };
  const tick = () => { const c = document.getElementById('clock'); if (c) c.textContent = new Date().toLocaleTimeString(lang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { hour: 'numeric', minute: '2-digit' }); };
  clearInterval(clockTimer);
  clockTimer = setInterval(tick, 10000);
  tick();
  refreshShift();
}

async function route() {
  if (!state.user) return;
  const id = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'floor';
  const page = PAGES.find((p) => p.id === id && (!p.perm || can(p.perm))) || PAGES[0];
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page.id));
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  // Fresh container each time so listeners from the previous page don't pile up.
  const old = document.getElementById('page');
  const el = document.createElement('div');
  el.id = 'page';
  el.className = 'page';
  old.replaceWith(el);
  document.title = `${t('nav.' + page.id)} · ${state.settings.shop_name || t('app_name')}`;
  if (!planOk(page.plan)) { el.innerHTML = lockedHtml(t('nav.' + page.id), page.plan); return; } // not in this bundle
  try {
    const mod = await import(page.mod);
    cleanup = (await mod.render(el)) || null;
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="banner crit">${esc(errText(err))}</div>`;
  }
}

async function boot() {
  const me = await get('/me');
  state.user = me.user;
  state.defaultPassword = me.default_password;
  state.discountLimit = me.discount_limit;
  state.plan = me.plan || 'max';
  state.settings = await get('/settings');
  setDefaultLang(state.settings.language);
  renderShell();
  route();
}

window.addEventListener('hashchange', route);
window.addEventListener('psm:logout', () => { if (state.user) { state.user = null; renderLogin(); } });
window.addEventListener('psm:shift', refreshShift);
// Settings → Language changed: redraw everything in the new language.
window.addEventListener('psm:lang', () => { renderShell(); route(); });

// Desktop app: behave like a Windows program, not a web page.
if (window.psmDesktop) {
  document.documentElement.classList.add('desktop');
  window.psmDesktop.onNavigate((page) => { if (state.user) location.hash = '#/' + page; });
  // no file drops / link drags turning the window into something else
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { if (!e.target.closest('input')) e.preventDefault(); });
}
const tellDesktopLanguage = () => { if (window.psmDesktop) window.psmDesktop.setLanguage(lang()).catch(() => {}); };
window.addEventListener('psm:lang', tellDesktopLanguage);

applyTheme();
applyDir();
boot().catch(() => renderLogin()).finally(tellDesktopLanguage);
