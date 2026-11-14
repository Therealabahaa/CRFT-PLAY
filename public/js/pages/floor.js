import { t } from '../i18n.js';
import { state, get, post, del, esc, money, moneyText, icon, modal, field, opt, delegate, busy, toast, toastErr, can, confirmBox, fmtTime, fmtMinutes, beep, formBox } from '../core.js';
import { loadCustomers, customerSelectHtml, wireCustomerSelect, payDialog, afterPayment, productPicker, mergeItems } from './shared.js';

let data = null;
const alerted = new Set();

const liveOf = (s) => Pricing.compute(s, data.pricing, Date.now() + (data.skew || 0));

function stationClass(c) {
  if (c.status === 'maintenance') return 'maint';
  const s = c.session;
  if (!s) return '';
  if (s.status === 'paused') return 'paused';
  if (s.planned_minutes && liveOf(s).minutes >= s.planned_minutes) return 'over';
  return 'busy';
}

function statusPill(c) {
  const cls = stationClass(c);
  const map = { '': ['good', 'available'], busy: ['info', 'busy'], paused: ['warn', 'paused'], over: ['crit', 'time_up'], maint: ['', 'maintenance'] };
  const [pc, key] = map[cls];
  return `<span class="pill ${pc}"><span class="dot"></span>${t('status.' + key)}</span>`;
}

function cardHtml(c) {
  const s = c.session;
  const head = `<div class="station-head"><div style="flex:1;min-width:0"><div class="station-name">${esc(c.name)}</div>
    <div class="station-meta">${money(c.price_single)} / ${t('hr')}${c.notes && c.status !== 'maintenance' ? ' · ' + esc(c.notes) : ''}</div></div>${statusPill(c)}</div>`;
  if (c.status === 'maintenance') {
    return `<div class="station maint" data-id="${c.id}">${head}<div class="station-body"><div class="station-idle">${icon('alert')} ${esc(c.notes || t('status.maintenance'))}</div></div></div>`;
  }
  const res = c.reservation ? `<div class="res-note">${icon('calendar')} ${t('reserved_for')} ${esc(c.reservation.customer_name)} · ${fmtTime(c.reservation.start_at)}</div>` : '';
  if (!s) {
    return `<div class="station" data-id="${c.id}">${head}<div class="station-body">
      ${res}</div>
      <div class="station-foot"><button class="btn btn-primary btn-lg" data-act="start" data-id="${c.id}">${icon('play')} ${t('start')}</button></div></div>`;
  }
  const who = s.customer?.name || s.customer_name;
  const pkg = s.package_minutes ? data.packages.find((p) => p.id === s.package_id) : null;
  return `<div class="station ${stationClass(c)}" data-id="${c.id}">${head}<div class="station-body">
    <div class="row small muted">${who ? `${icon('user')} ${esc(who)}` : ''}${pkg ? `${who ? ' · ' : ''}${esc(pkg.name)}` : ''}
      ${s.discount_pct ? `<span class="pill good">${t('discount')} ${s.discount_pct}%</span>` : ''}</div>
    <div class="timer num" data-timer></div>
    <div data-progress></div>
    <div class="station-money"><span class="muted small" data-items>${s.items_amount ? `${t('products')}: ${moneyText(s.items_amount)}` : ''}</span><span class="amt" data-amount></span></div>
    <div class="muted small">${t('started')} ${fmtTime(s.started_at)}</div>${res}</div>
    <div class="station-foot">
      ${s.status === 'paused'
        ? `<button class="btn" data-act="resume" data-sid="${s.id}">${icon('play')} ${t('resume')}</button>`
        : `<button class="btn" data-act="pause" data-sid="${s.id}">${icon('pause')} ${t('pause')}</button>`}
      <button class="btn" data-act="items" data-sid="${s.id}">${icon('cart')} ${t('order')}</button>
      <button class="btn" data-act="more" data-sid="${s.id}" aria-label="${t('more')}">⋯</button>
      <button class="btn btn-good" data-act="checkout" data-sid="${s.id}" style="flex-basis:100%">${icon('stop')} ${t('end_and_pay')}</button>
    </div></div>`;
}

function tick(root) {
  if (!data) return;
  for (const c of data.consoles) {
    const s = c.session;
    if (!s) continue;
    const card = root.querySelector(`.station[data-id="${c.id}"]`);
    if (!card) continue;
    const p = liveOf(s);
    const tm = card.querySelector('[data-timer]');
    if (s.planned_minutes) {
      const left = s.planned_minutes - p.minutes;
      tm.textContent = (left < 0 ? '+' : '') + Pricing.formatDuration(Math.abs(left));
      card.querySelector('[data-progress]').innerHTML = `<div class="progress" title="${fmtMinutes(s.planned_minutes)}"><div style="width:${Math.min(100, (p.minutes / s.planned_minutes) * 100)}%"></div></div>
        <div class="muted small">${left >= 0 ? t('time_left') : t('overtime')} · ${t('of')} ${fmtMinutes(s.planned_minutes)}</div>`;
      const cls = stationClass(c);
      card.className = `station ${cls}`;
      const pill = card.querySelector('.pill');
      if (pill) pill.outerHTML = statusPill(c);
      if (left <= 0 && s.status === 'active' && !alerted.has(s.id)) {
        alerted.add(s.id);
        beep(); setTimeout(beep, 700);
        toast(`${c.name}: ${t('time_up_msg')}`, true);
        // a Windows notification too — seen even when the app is minimised or behind another window
        if (window.psmDesktop) window.psmDesktop.notify(`⏰ ${c.name}`, `${t('time_up_msg')} (${fmtMinutes(s.planned_minutes)})`).catch(() => {});
      }
    } else {
      tm.textContent = Pricing.formatDuration(p.minutes);
    }
    const disc = Math.round(p.amount * (s.discount_pct || 0)) / 100;
    card.querySelector('[data-amount]').innerHTML = money(p.amount - disc + (s.items_amount || 0));
  }
}

function summaryHtml() {
  const cs = data.consoles;
  const n = (fn) => cs.filter(fn).length;
  const busyN = n((c) => c.session && c.session.status === 'active');
  const pausedN = n((c) => c.session && c.session.status === 'paused');
  const freeN = n((c) => !c.session && c.status === 'active');
  const upcoming = cs.filter((c) => c.reservation).map((c) => c.reservation);
  return `<div class="page-head"><h1>${t('nav.floor')}</h1>
    <span class="pill good"><span class="dot"></span>${t('status.available')}: ${freeN}</span>
    <span class="pill info"><span class="dot"></span>${t('status.busy')}: ${busyN}</span>
    ${pausedN ? `<span class="pill warn"><span class="dot"></span>${t('status.paused')}: ${pausedN}</span>` : ''}
    <span class="spacer"></span>
    <a class="btn" href="#/pos">${icon('cart')} ${t('quick_sale')}</a>
    <a class="btn" href="#/reservations">${icon('calendar')} ${t('new_reservation')}</a></div>
    ${!data.shift ? `<div class="banner warn">${icon('alert')} ${t('no_shift_banner')} <a class="btn btn-sm" href="#/shift">${t('open_shift')}</a></div>` : ''}
    ${upcoming.length ? `<div class="banner info">${icon('calendar')} ${upcoming.map((r) => `${esc(r.customer_name)} · ${esc(data.consoles.find((c) => c.id === r.console_id)?.name || '')} · ${fmtTime(r.start_at)}`).join(' &nbsp;|&nbsp; ')}</div>` : ''}
    ${data.consoles.length ? '' : `<div class="card empty">${t('no_consoles')} <a href="#/settings">${t('nav.settings')}</a></div>`}`;
}

export async function render(root) {
  async function load() {
    const res = await get('/floor');
    res.skew = res.now - Date.now();
    data = res;
    state.shift = res.shift;
    // grouped by room: the main hall first, then each room with its price
    const groups = [{ room: null, list: data.consoles.filter((c) => !c.room_id || !data.rooms.some((r) => r.id === c.room_id)) },
      ...data.rooms.map((r) => ({ room: r, list: data.consoles.filter((c) => c.room_id === r.id) }))].filter((g) => g.list.length);
    const multi = groups.length > 1;
    root.innerHTML = `${summaryHtml()}${groups.map((g) => `${multi ? `<div class="room-head"><h2>${g.room ? esc(g.room.name) : t('main_hall')}</h2>
        ${g.room && g.room.rate_single > 0 ? `<span class="pill info">${t('single')} ${money(g.room.rate_single)}/${t('hr')} · ${t('multi')} ${money(g.room.rate_multi || g.room.rate_single)}/${t('hr')}</span>` : ''}
        <span class="muted small">${g.list.filter((c) => !c.session && c.status === 'active').length}/${g.list.length} ${t('status.available')}</span></div>` : ''}
      <div class="floor">${g.list.map(cardHtml).join('')}</div>`).join('')}`;
    tick(root);
  }
  await load();
  const findSession = (sid) => data.consoles.map((c) => c.session).find((s) => s && s.id === Number(sid));
  const action = (btn, fn) => busy(btn, async () => { await fn(); await load(); });

  delegate(root, {
    start: (btn) => startDialog(data.consoles.find((c) => c.id === Number(btn.dataset.id))).then((ok) => ok && load()),
    pause: (btn) => action(btn, () => post(`/sessions/${btn.dataset.sid}/pause`)),
    resume: (btn) => action(btn, () => post(`/sessions/${btn.dataset.sid}/resume`)),
    items: async (btn) => {
      const s = findSession(btn.dataset.sid);
      let current = s.items;
      await productPicker(t('add_products'), async (pid) => {
        await post(`/sessions/${s.id}/items`, { product_id: pid, qty: 1 });
        current = (await get('/floor')).consoles.find((c) => c.session && c.session.id === s.id).session.items;
      }, () => itemsListHtml(current));
      load();
    },
    more: (btn) => moreDialog(findSession(btn.dataset.sid)).then(load),
    checkout: (btn) => checkout(findSession(btn.dataset.sid)).then(load),
  });

  // Right-click a room card: the actions for that room, like a desktop program.
  const closeCtx = () => document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  root.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.station');
    if (!card) return;
    e.preventDefault();
    closeCtx();
    const c = data.consoles.find((x) => x.id === Number(card.dataset.id));
    if (!c) return;
    const s = c.session;
    const items = c.status === 'maintenance' ? [] : !s
      ? [['start', '▶', t('start')], ['reserve', '📅', t('new_reservation')]]
      : [s.status === 'paused' ? ['resume', '▶', t('resume')] : ['pause', '⏸', t('pause')], ['items', '🛒', t('add_products')],
        ['more', '🏷', `${t('discount')} / ${t('move_console')}`], null, ['checkout', '💵', t('end_and_pay')]];
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.innerHTML = `<div class="ctx-title">${esc(c.name)}</div>${items.length ? items.map((it) => (it ? `<button data-a="${it[0]}"><span>${it[1]}</span>${esc(it[2])}</button>` : '<hr>')).join('')
      : `<button disabled>${t('status.maintenance')}</button>`}`;
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
    menu.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-a]');
      if (!b) return;
      closeCtx();
      const a = b.dataset.a;
      if (a === 'start') startDialog(c).then((ok) => ok && load());
      else if (a === 'reserve') location.hash = '#/reservations';
      else if (a === 'pause' || a === 'resume') busy(null, async () => { await post(`/sessions/${s.id}/${a}`); await load(); });
      else root.querySelector(`.station[data-id="${c.id}"] [data-act="${a}"]`)?.click();
    });
  });
  const onDocDown = (e) => { if (!e.target.closest('.ctx-menu')) closeCtx(); };
  const onKey = (e) => { if (e.key === 'Escape') closeCtx(); };
  document.addEventListener('mousedown', onDocDown);
  document.addEventListener('keydown', onKey);
  window.addEventListener('blur', closeCtx);

  const timer = setInterval(() => tick(root), 1000);
  const refresher = setInterval(() => { if (!document.querySelector('.modal-back')) load().catch(() => {}); }, 20000);
  return () => {
    clearInterval(timer); clearInterval(refresher); closeCtx();
    document.removeEventListener('mousedown', onDocDown); document.removeEventListener('keydown', onKey); window.removeEventListener('blur', closeCtx);
  };
}

function itemsListHtml(items) {
  if (!items || !items.length) return '';
  return `<div class="card" style="padding:10px 14px"><b>${t('current_order')}</b>${items.map((i) => `<div class="line row small" style="justify-content:space-between"><span>${esc(i.name)} × ${i.qty}</span><span>${moneyText(i.qty * i.price)}</span></div>`).join('')}</div>`;
}

async function startDialog(c) {
  await loadCustomers();
  const pkgs = data.packages;
  const r = c.reservation;
  const body = `
    <div class="row"><span class="pill info">${moneyText(c.price_single)} / ${t('hr')}</span></div>
    ${field(t('mode'), `<div class="seg" data-mode>
      <button type="button" class="on" data-v="open">${t('open_time')}</button>
      <button type="button" data-v="fixed">${t('fixed_time')}</button>
      ${pkgs.length ? `<button type="button" data-v="package">${t('package')}</button>` : ''}</div>`)}
    <div data-fixed class="hidden">${field(t('planned_minutes'), `<div class="row">${[30, 60, 90, 120, 180].map((m) => `<button type="button" class="btn btn-sm" data-min="${m}">${fmtMinutes(m)}</button>`).join('')}<input name="planned_minutes" type="number" min="1" style="width:100px"></div>`)}</div>
    <div data-package class="hidden">${field(t('package'), `<select name="package_id">${pkgs.map((p) => opt(p.id, `${p.name} — ${fmtMinutes(p.minutes)} — ${moneyText(p.price)}`)).join('')}</select>`)}</div>
    <div class="form-grid">
      ${field(t('customer'), customerSelectHtml('customer_id', r?.customer_id))}
      ${field(t('customer_name_optional'), `<input name="customer_name" value="${esc(r?.customer_name || '')}">`)}
    </div>
    ${field(t('notes'), '<input name="notes">')}
    ${r ? `<label class="check"><input type="checkbox" name="use_res" checked> ${t('from_reservation')}: ${esc(r.customer_name)} ${fmtTime(r.start_at)}</label>` : ''}`;
  return modal({
    title: `${t('start')} — ${c.name}`, body,
    foot: `<button class="btn" data-close>${t('cancel')}</button><button class="btn btn-primary btn-lg" data-ok>${icon('play')} ${t('start')}</button>`,
    onMount: (el, close) => {
      wireCustomerSelect(el);
      let players = 2;
      let mode = 'open';
      const segWire = (sel, cb) => el.querySelector(sel).addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        el.querySelectorAll(`${sel} button`).forEach((x) => x.classList.toggle('on', x === b));
        cb(b.dataset.v);
      });
      segWire('[data-mode]', (v) => {
        mode = v;
        el.querySelector('[data-fixed]').classList.toggle('hidden', v !== 'fixed');
        el.querySelector('[data-package]').classList.toggle('hidden', v !== 'package');
      });
      el.querySelectorAll('[data-min]').forEach((b) => b.addEventListener('click', () => { el.querySelector('[name=planned_minutes]').value = b.dataset.min; }));
      const btn = el.querySelector('[data-ok]');
      btn.addEventListener('click', () => busy(btn, async () => {
        const q = (n) => el.querySelector(`[name=${n}]`);
        const body = { console_id: c.id, players, customer_id: q('customer_id').value || null, customer_name: q('customer_name').value, notes: q('notes').value };
        if (mode === 'fixed') {
          body.planned_minutes = Number(q('planned_minutes').value) || null;
          if (!body.planned_minutes) throw Object.assign(new Error(), { code: 'planned_required' });
        }
        if (mode === 'package') body.package_id = Number(q('package_id').value);
        if (r && q('use_res')?.checked) body.reservation_id = r.id;
        await post('/sessions', body);
        toast(`${c.name}: ${t('started')}`);
        close(true);
      }));
    },
  });
}

async function moreDialog(s) {
  const c = data.consoles.find((x) => x.id === s.console_id);
  const free = data.consoles.filter((x) => !x.session && x.status === 'active');
  const lim = data.discount_limit || { unlimited: true, pct: 100 };
  await loadCustomers();
  const body = `
    <div class="card stack" style="box-shadow:none">
      <h3>${t('discount')} <span class="muted small">${t('disc_time_only')}</span></h3>
      <div class="quickpick">${[0, 10, 25, 50, 100].map((p) => `<button class="btn btn-sm ${Number(s.discount_pct || 0) === p ? 'on' : ''}" data-act="disc" data-pct="${p}" ${!lim.unlimited && p > lim.pct ? 'disabled' : ''}>${p === 0 ? t('none') : p === 100 ? t('free') : p + '%'}</button>`).join('')}
        <input type="number" min="0" max="${lim.unlimited ? 100 : lim.pct}" step="any" data-disc-pct placeholder="%" style="width:80px" value="${[0, 10, 25, 50, 100].includes(Number(s.discount_pct || 0)) ? '' : s.discount_pct}">
        <button class="btn btn-sm" data-act="disc-custom">${t('apply')}</button></div>
      ${lim.unlimited ? '' : `<span class="muted small">${t('your_discount_limit')}: ${lim.pct}%${lim.egp != null ? ` · ${lim.egp} ${t('egp')}` : ''}</span>`}
    </div>
    <div class="card stack" style="box-shadow:none">
      <h3>${t('move_console')}</h3>
      <div class="row"><select data-move-target>${free.map((x) => opt(x.id, `${x.name} (${x.price_single}/${t('hr')})`)).join('')}</select>
      <button class="btn" data-act="move" ${free.length ? '' : 'disabled'}>${icon('move')} ${t('move')}</button></div>
    </div>
    <div class="card stack" style="box-shadow:none">
      <h3>${t('details')}</h3>
      <div class="form-grid">
        ${field(t('customer'), customerSelectHtml('customer_id', s.customer_id))}
        ${field(t('customer_name_optional'), `<input name="customer_name" value="${esc(s.customer_name || '')}">`)}
        ${field(t('planned_minutes'), `<input name="planned_minutes" type="number" min="0" value="${s.planned_minutes || ''}">`)}
        ${field(t('notes'), `<input name="notes" value="${esc(s.notes || '')}">`)}
      </div>
      <div><button class="btn" data-act="save">${t('save')}</button></div>
    </div>
    ${s.items.length ? `<div class="card stack" style="box-shadow:none"><h3>${t('current_order')}</h3>
      ${s.items.map((i) => `<div class="row" style="justify-content:space-between"><span>${esc(i.name)} × ${i.qty} — ${moneyText(i.qty * i.price)}</span>
      <button class="icon-btn" data-act="rm-item" data-item="${i.id}" aria-label="${t('remove')}">${icon('trash')}</button></div>`).join('')}</div>` : ''}
    ${can('refund') ? `<div><button class="btn btn-danger" data-act="cancel">${icon('x')} ${t('cancel_session')}</button></div>` : ''}`;
  return modal({
    title: `${c.name} — ${t('session')} #${s.id}`, body,
    foot: `<button class="btn" data-close>${t('close')}</button>`,
    onMount: (el, close) => {
      wireCustomerSelect(el);
      delegate(el, {
        disc: (b) => busy(b, async () => { await post(`/sessions/${s.id}/discount`, { pct: Number(b.dataset.pct) }); toast(t('saved')); close(); }),
        'disc-custom': (b) => busy(b, async () => {
          const pct = Number(el.querySelector('[data-disc-pct]').value);
          if (!(pct >= 0 && pct <= 100)) return toast(t('err.invalid_discount'), true);
          await post(`/sessions/${s.id}/discount`, { pct }); toast(t('saved')); close();
        }),
        players: (b) => busy(b, async () => { await post(`/sessions/${s.id}/players`, { players: Number(b.dataset.n) }); toast(t('saved')); close(); }),
        move: (b) => busy(b, async () => { await post(`/sessions/${s.id}/move`, { console_id: Number(el.querySelector('[data-move-target]').value) }); toast(t('saved')); close(); }),
        save: (b) => busy(b, async () => {
          const q = (n) => el.querySelector(`[name=${n}]`).value;
          await post(`/sessions/${s.id}/update`, { customer_id: q('customer_id') || null, customer_name: q('customer_name'), planned_minutes: q('planned_minutes'), notes: q('notes') });
          alerted.delete(s.id);
          toast(t('saved')); close();
        }),
        'rm-item': (b) => busy(b, async () => { await del(`/sessions/${s.id}/items/${b.dataset.item}`); toast(t('removed')); close(); }),
        cancel: async () => {
          const v = await formBox(t('cancel_session'), field(t('reason'), '<input name="reason" required>'), { okText: t('cancel_session'), validate: (x) => (!x.reason.trim() ? t('err.reason_required') : null) });
          if (!v) return;
          try { await post(`/sessions/${s.id}/cancel`, v); toast(t('session_cancelled')); close(); } catch (err) { toastErr(err); }
        },
      });
    },
  });
}

async function checkout(s) {
  if (!data.shift) { toast(t('err.no_open_shift'), true); return; }
  const full = await get(`/sessions/${s.id}`);
  const c = data.consoles.find((x) => x.id === s.console_id);
  const pkg = full.package_id ? data.packages.find((p) => p.id === full.package_id) : null;
  const lines = [{ label: t('playtime'), sub: [pkg ? pkg.name : `${moneyText(c.price_single)}/${t('hr')}`, full.overtime ? `${t('overtime')} ${fmtMinutes(full.overtime)}` : ''].filter(Boolean).join(' · '), amount: full.time_amount }];
  // the same product ordered twice shows as one line (Pepsi ×2), not two
  for (const it of mergeItems(full.invoice.items)) lines.push({ label: `${it.name} ×${it.qty}`, amount: it.qty * it.price });
  if (full.invoice.items.length) lines.push({ label: t('food_drinks'), amount: full.items_amount, subtotal: true });
  const who = s.customer?.name || s.customer_name;
  const pay = await payDialog({
    title: t('checkout'), sub: [c.name, who, fmtMinutes(full.minutes)],
    lines, gross: full.total, timeAmount: full.time_amount, customerId: s.customer_id, discountPct: full.discount_pct || 0,
  });
  if (!pay) return;
  try {
    const inv = await post(`/sessions/${s.id}/checkout`, { ...pay, at: full.priced_at, expected_gross: full.total });
    alerted.delete(s.id);
    afterPayment(inv, pay);
  } catch (err) {
    if (err.code === 'price_changed') { // the bill moved while the window was open: show the new bill instead of guessing
      toast(t('price_changed_reopen'), true);
      return checkout(s);
    }
    toastErr(err);
  }
}
