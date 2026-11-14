// Shift screen — laid out like Kur / the Iki till: what came in by cash / card (Visa) / online, the drawer,
// cash in / out, and an end-of-shift count of all three with a plain-words verdict and a printed cash-up sheet.
import { t } from '../i18n.js';
import { state, get, post, esc, money, moneyText, icon, modal, toast, delegate, fmtDateTime, fmtTime, dayKey, busy, can, field } from '../core.js';
import { desktop, openDrawer, printSlip, slipHead, slipLine, slipMoney, slipStamp } from '../print.js';

const NOTES = [200, 100, 50, 20, 10, 5, 1, 0.5];
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${moneyText(Math.abs(n))}`;
const diffColor = (d) => (d == null ? 'inherit' : d < 0 ? 'var(--crit-ink)' : d > 0 ? 'var(--warn-ink)' : 'var(--good-ink)');
const diffWords = (d) => (d == null ? t('not_counted') : Math.abs(d) < 0.005 ? `${t('balances')} ✓` : d > 0 ? `${t('over_by')} ${moneyText(d)}` : `${t('short_by')} ${moneyText(-d)}`);

export async function render(root) {
  let histFrom = (() => { const d = new Date(); d.setDate(d.getDate() - 6); return dayKey(d); })();
  let histTo = dayKey();

  async function draw() {
    const cur = await get('/shifts/current');
    state.shift = cur;
    const k = (label, value, sub = '') => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
    root.innerHTML = `<div class="page-head"><h1>${t('nav.shift')}</h1></div>
      ${cur ? `<div class="card"><div class="card-head" style="margin:0">
          <span class="pill good"><span class="dot"></span>${t('shift')} #${cur.id} ${t('open')}</span>
          <b>${esc(cur.user_name)}</b><span class="muted">${t('since')} ${fmtDateTime(cur.opened_at)}</span><span class="spacer"></span>
          <button class="btn" data-act="move">${icon('wallet')} ${t('cash_in_out')}</button>
          ${desktop() ? `<button class="btn" data-act="drawer">🗄 ${t('open_drawer')}</button>` : ''}
          <button class="btn" data-act="report">${icon('receipt')} ${t('shift_report')}</button>
          ${cur.user_id === state.user.id || state.user.role === 'admin' ? `<button class="btn btn-danger" data-act="end">${icon('stop')} ${t('end_shift')}</button>` : ''}</div>
          ${cur.user_id !== state.user.id ? `<p class="muted small" style="margin:8px 0 0">${t('working_on_shift').replace('{name}', esc(cur.user_name))}</p>` : ''}</div>
        <div class="kpis">
          ${k(t('revenue'), money(cur.revenue), `${cur.sessions_count} ${t('sessions')} · ${cur.sales_count} ${t('sales')}`)}
          ${k(`💵 ${t('method.cash')}`, money(cur.by_method.cash || 0))}
          ${k(`💳 ${t('method.card')}`, money(cur.card_total))}
          ${k(`🌐 ${t('method.online')}`, money(cur.online_total))}
          ${k(t('expected_cash'), money(cur.expected_cash), t('in_drawer_now'))}
          ${cur.unpaid ? k(`🧾 ${t('on_credit')}`, money(cur.unpaid), t('not_paid_yet')) : ''}
        </div>
        ${cur.moves.length ? `<div class="card"><h2 style="margin-bottom:8px">${t('cash_in_out')}</h2><div class="table-wrap"><table><tbody>
          ${cur.moves.map((m) => `<tr><td class="num">${fmtTime(m.created_at)}</td><td>${esc(m.reason)}</td><td class="muted">${esc(m.user_name || '')}</td>
          <td class="n num" style="color:${m.amount < 0 ? 'var(--crit-ink)' : 'var(--good-ink)'}"><b>${signed(m.amount)}</b></td></tr>`).join('')}</tbody></table></div></div>` : ''}
        ${cur.waste.length ? `<div class="card"><h2 style="margin-bottom:8px">🗑 ${t('waste_this_shift')}</h2><div class="table-wrap"><table><tbody>
          ${cur.waste.map((w) => `<tr><td class="num">${fmtTime(w.created_at)}</td><td><b>${esc(w.name)}</b></td><td class="muted">${esc(w.note || '')}</td><td class="n num">${w.qty}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`
      : `<div class="card stack" style="max-width:520px"><h2>${t('start_your_shift')}</h2><p class="muted" style="margin:0">${t('open_shift_hint')}</p>
          <label class="field">${t('opening_cash')}<input type="number" min="0" step="any" data-opening value="0"></label>
          <div><button class="btn btn-primary btn-lg" data-act="open">${icon('play')} ${t('start_shift_as').replace('{name}', esc(state.user.name))}</button></div></div>`}
      ${can('reports') ? `<div class="card"><div class="card-head"><h2>${t('shifts')}</h2><span class="spacer"></span>
          <div class="seg">${[[0, t('range.today')], [6, t('range.week')], [29, t('last_30')]].map(([d, l]) => `<button data-act="range" data-d="${d}">${l}</button>`).join('')}</div>
          <input type="date" data-from value="${histFrom}" style="width:auto"><span>→</span><input type="date" data-to value="${histTo}" style="width:auto"></div>
        <div data-hist><div class="empty">…</div></div></div>` : ''}`;
    root._cur = cur;
    if (can('reports')) {
      const list = await get(`/shifts?from=${histFrom}&to=${histTo}`);
      root._hist = list;
      root.querySelector('[data-hist]').innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>${t('cashier')}</th><th>${t('opened')}</th><th>${t('closed')}</th><th class="n">${t('revenue')}</th><th class="n">💵</th><th class="n">💳</th><th class="n">🌐</th><th class="n">${t('drawer')}</th><th class="n">${t('counted_cash')}</th><th class="n">${t('over_short')}</th></tr></thead>
        <tbody>${list.map((s) => `<tr class="clickable" data-act="view" data-id="${s.id}"><td><b>#${s.id}</b></td><td>${esc(s.user_name)}</td><td>${fmtDateTime(s.opened_at)}</td>
          <td>${s.closed_at ? fmtDateTime(s.closed_at) : `<span class="pill good">${t('open')}</span>`}</td><td class="n num"><b>${s.revenue}</b></td>
          <td class="n num">${s.by_method.cash || 0}</td><td class="n num">${s.card_total}</td><td class="n num">${s.online_total}</td><td class="n num">${s.expected_cash}</td>
          <td class="n num">${s.closed_at && s.counted_cash != null ? s.counted_cash : '—'}</td>
          <td class="n num" style="color:${diffColor(s.closed_at ? s.difference : null)}"><b>${s.closed_at && s.difference != null ? (Math.abs(s.difference) < 0.005 ? '✓' : signed(s.difference)) : '—'}</b></td></tr>`).join('')
          || `<tr><td colspan="11" class="empty">${t('no_records')}</td></tr>`}</tbody></table></div>`;
      root.querySelectorAll('[data-from],[data-to]').forEach((i) => i.addEventListener('change', () => { histFrom = root.querySelector('[data-from]').value || histFrom; histTo = root.querySelector('[data-to]').value || histTo; draw(); }));
    }
  }

  delegate(root, {
    open: (b) => busy(b, async () => {
      await post('/shifts/open', { opening_cash: Number(root.querySelector('[data-opening]').value) || 0 });
      toast(t('shift_opened'));
      window.dispatchEvent(new Event('psm:shift'));
      location.hash = '#/floor';
    }),
    move: () => moveDialog().then((ok) => ok && draw()),
    drawer: (b) => busy(b, async () => { const r = await openDrawer(); if (r.ok) toast(t('drawer_opened')); }),
    report: () => shiftReport(root._cur),
    end: () => endDialog(root._cur).then((ok) => { if (ok) { window.dispatchEvent(new Event('psm:shift')); draw(); } }),
    view: (r) => shiftReport(root._hist.find((s) => s.id === Number(r.dataset.id))),
    range: (b) => { const d = new Date(); d.setDate(d.getDate() - Number(b.dataset.d)); histFrom = dayKey(d); histTo = dayKey(); draw(); },
  });
  await draw();
}

/* ---------- cash in / out (Kur) ---------- */
function moveDialog() {
  return modal({
    title: t('cash_in_out'),
    body: `<p class="muted" style="margin:0">${t('cash_move_hint')}</p>
      <div class="seg" data-type><button type="button" class="on" data-v="out">➖ ${t('cash_out')}</button><button type="button" data-v="in">➕ ${t('cash_in')}</button></div>
      <div class="form-grid">${field(t('amount'), '<input name="amount" type="number" min="0" step="any">')}${field(t('reason'), `<input name="reason" placeholder="${t('cash_move_ph')}">`)}</div>`,
    foot: `<button class="btn" data-close>${t('cancel')}</button><button class="btn btn-primary" data-ok>${t('save')}</button>`,
    onMount: (el, close) => {
      let type = 'out';
      el.querySelector('[data-type]').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; type = b.dataset.v; el.querySelectorAll('[data-type] button').forEach((x) => x.classList.toggle('on', x === b)); });
      const ok = el.querySelector('[data-ok]');
      ok.addEventListener('click', () => busy(ok, async () => {
        await post('/shifts/move', { type, amount: Number(el.querySelector('[name=amount]').value), reason: el.querySelector('[name=reason]').value });
        toast(t('saved'));
        close(true);
      }));
    },
  });
}

/* ---------- end shift (Kur): count cash, card machine and online — each box may be left empty ---------- */
function endDialog(cur) {
  const pl = (l, v, cls = '') => `<p class="payline ${cls}"><span>${l}</span><strong>${v}</strong></p>`;
  const body = `
    <div class="paylines">
      ${pl(`💵 ${t('cash_payments')}`, moneyText(cur.cash_received))}
      ${pl(`💳 ${t('method.card')}`, moneyText(cur.card_total))}
      ${pl(`🌐 ${t('method.online')}`, moneyText(cur.online_total))}
      ${cur.opening_cash ? pl(t('opening_cash'), moneyText(cur.opening_cash)) : ''}
      ${cur.moves_in ? pl(t('cash_in'), '+' + moneyText(cur.moves_in)) : ''}
      ${cur.moves_out ? pl(t('cash_out'), '−' + moneyText(cur.moves_out)) : ''}
      ${cur.drawer_expenses ? pl(t('drawer_expenses'), '−' + moneyText(cur.drawer_expenses)) : ''}
      ${cur.cash_refunds ? pl(t('cash_refunds'), '−' + moneyText(cur.cash_refunds)) : ''}
      ${pl(t('drawer_should_hold'), moneyText(cur.expected_cash), 'payline--total')}
      ${pl(t('card_should_show'), moneyText(cur.expected_card))}
      ${pl(t('online_should_be'), moneyText(cur.expected_online))}
    </div>
    <div class="form-grid">
      ${field(`💵 ${t('cash_counted')}`, '<input name="counted_cash" type="number" min="0" step="any" placeholder="0">')}
      ${field(`💳 ${t('card_counted')}`, '<input name="counted_card" type="number" min="0" step="any" placeholder="0">')}
      ${field(`🌐 ${t('online_counted')}`, '<input name="counted_online" type="number" min="0" step="any" placeholder="0">')}
    </div>
    <details><summary class="muted small">${t('count_by_banknote')}</summary>
      <div class="table-wrap"><table><tbody>${NOTES.map((n) => `<tr><td class="num"><b>${n}</b> ${t('egp')}</td><td><input type="number" min="0" step="1" data-note="${n}" style="max-width:100px"></td><td class="n num" data-sub="${n}">0</td></tr>`).join('')}</tbody></table></div></details>
    <div data-diffs style="font-weight:700"></div>
    ${field(t('notes'), `<input name="notes" maxlength="200" placeholder="${t('end_note_ph')}">`)}`;
  return modal({
    title: t('end_shift'), body,
    foot: `<button class="btn" data-close>${t('cancel')}</button><button class="btn btn-danger btn-lg" data-ok>${icon('stop')} ${t('end_shift')}</button>`,
    onMount: (el, close) => {
      const v = (n) => el.querySelector(`[name=${n}]`).value;
      const one = (label, exp, val) => {
        if (val === '') return '';
        const d = Math.round((Number(val) - exp) * 100) / 100;
        return `<div style="color:${diffColor(d)}">${label}: ${diffWords(d)}</div>`;
      };
      const upd = () => {
        const c = v('counted_cash'), k = v('counted_card'), o = v('counted_online');
        el.querySelector('[data-diffs]').innerHTML = c === '' && k === '' && o === ''
          ? `<span class="muted" style="font-weight:400">${t('blank_not_counted')}</span>`
          : one(`💵 ${t('method.cash')}`, cur.expected_cash, c) + one(`💳 ${t('method.card')}`, cur.expected_card, k) + one(`🌐 ${t('method.online')}`, cur.expected_online, o);
      };
      el.querySelectorAll('[data-note]').forEach((i) => i.addEventListener('input', () => {
        let sum = 0;
        el.querySelectorAll('[data-note]').forEach((x) => { const s = (Number(x.value) || 0) * Number(x.dataset.note); sum += s; el.querySelector(`[data-sub="${x.dataset.note}"]`).textContent = s; });
        el.querySelector('[name=counted_cash]').value = Math.round(sum * 100) / 100;
        upd();
      }));
      el.addEventListener('input', upd);
      upd();
      const ok = el.querySelector('[data-ok]');
      const submit = () => busy(ok, async () => {
        const s = await post('/shifts/close', { counted_cash: v('counted_cash'), counted_card: v('counted_card'), counted_online: v('counted_online'), notes: v('notes') });
        close(true);
        toast(t('shift_closed'));
        if (state.settings.auto_print !== '0' && desktop()) printShiftSheet(s); // the cash-up sheet prints by itself
        const report = shiftReport(s, `${t('shift')} #${s.id} ${t('closed_ok')} ✔`, state.user.role !== 'admin');
        return report;
      });
      ok.addEventListener('click', submit);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); } });
    },
  });
}

/* ---------- the shift report (Kur / Iki layout) ---------- */
export function shiftReport(s, title, signOutAfter = false) {
  const closed = !!s.closed_at;
  const row = (l, v, cls = '') => `<p class="payline ${cls}"><span>${l}</span><strong>${v}</strong></p>`;
  const verdicts = [];
  let bad = false;
  if (!closed) verdicts.push(t('still_open'));
  else {
    verdicts.push(`💵 ${t('cash_drawer')} ${diffWords(s.difference)}.`);
    verdicts.push(`💳 ${t('method.card')} ${diffWords(s.card_difference)}.`);
    verdicts.push(`🌐 ${t('method.online')} ${diffWords(s.online_difference)}.`);
    bad = [s.difference, s.card_difference, s.online_difference].some((d) => d != null && d < -0.005);
  }
  const counted = (v) => (closed && v != null ? moneyText(v) : t('not_counted'));
  const body = `
    <p class="modal-sub">${esc(s.user_name)} · ${fmtDateTime(s.opened_at)} → ${closed ? fmtDateTime(s.closed_at) : t('still_open')} · ${s.hours} ${t('hr')} · ${s.sessions_count} ${t('sessions')} · ${s.sales_count} ${t('sales')}</p>
    <div class="grid grid-2">
      <section class="stack">
        <h3>${t('money_in')}</h3>
        <div class="paylines">${row(`💵 ${t('method.cash')}`, moneyText(s.by_method.cash || 0))}${row(`💳 ${t('method.card')}`, moneyText(s.card_total))}${row(`🌐 ${t('method.online')}`, moneyText(s.online_total))}
          ${row(t('revenue'), moneyText(s.revenue), 'payline--total')}${row(`🎮 ${t('playtime')}`, moneyText(s.time_revenue))}${row(`🥤 ${t('products')}`, moneyText(s.items_revenue))}
          ${s.discounts ? row(t('discounts'), moneyText(s.discounts)) : ''}${s.debt_collected ? row(t('debt_collected'), moneyText(s.debt_collected)) : ''}${s.moves_in ? row(t('cash_in'), moneyText(s.moves_in)) : ''}</div>
        <h3>${t('money_out')}</h3>
        <div class="paylines">${row(t('cash_out'), moneyText(s.moves_out))}${row(t('drawer_expenses'), moneyText(s.drawer_expenses))}
          ${s.refunds ? row(`${t('refunds')} (${s.refunds_count})`, moneyText(s.refunds)) : ''}${s.unpaid ? row(`🧾 ${t('on_credit')}`, moneyText(s.unpaid)) : ''}</div>
      </section>
      <section class="stack">
        <h3>${t('the_drawer')}</h3>
        <div class="paylines">${s.opening_cash ? row(t('opening_cash'), moneyText(s.opening_cash)) : ''}${row(t('should_hold'), moneyText(s.expected_cash), 'payline--total')}${row(t('counted_cash'), counted(s.counted_cash))}</div>
        <h3>💳 ${t('card_machine')}</h3>
        <div class="paylines">${row(t('should_be'), moneyText(s.expected_card), 'payline--total')}${row(t('counted'), counted(s.counted_card))}</div>
        <h3>🌐 ${t('method.online')}</h3>
        <div class="paylines">${row(t('should_be'), moneyText(s.expected_online), 'payline--total')}${row(t('counted'), counted(s.counted_online))}</div>
        <div class="banner ${bad ? 'crit' : closed ? 'info' : 'warn'}" style="display:block">${verdicts.join(' ')}</div>
        ${s.notes ? `<div class="banner info">${t('notes')}: ${esc(s.notes)}</div>` : ''}
      </section>
    </div>
    <h3>${t('cash_in_out')}</h3>
    ${s.moves.length ? `<div class="table-wrap"><table><tbody>${s.moves.map((x) => `<tr><td><b>${esc(x.reason)}</b></td><td class="muted">${x.amount > 0 ? t('cash_in') : t('cash_out')}</td><td class="num muted">${fmtDateTime(x.created_at)}</td><td class="muted">${esc(x.user_name || '')}</td>
      <td class="n num" style="color:${x.amount < 0 ? 'var(--crit-ink)' : 'var(--good-ink)'}"><b>${signed(x.amount)}</b></td></tr>`).join('')}</tbody></table></div>` : `<p class="muted small" style="margin:0">${t('no_cash_moves')}</p>`}
    ${s.waste.length ? `<h3>🗑 ${t('waste_this_shift')}</h3><div class="paylines">${s.waste.map((w) => row(`${esc(w.name)} <em>${esc(w.note || '')}</em>`, w.qty)).join('')}</div>` : ''}
    ${s.top.length ? `<h3>${t('top_items')}</h3><div class="paylines">${s.top.map((i) => row(esc(i.name), `${i.qty} · ${moneyText(i.amount)}`)).join('')}</div>` : ''}`;
  return modal({
    title: title || `${t('shift')} #${s.id} · ${s.user_name}`, wide: true, body, locked: signOutAfter,
    foot: signOutAfter
      ? `<button class="btn" data-print>${icon('print')} ${t('print_cashup')}</button><button class="btn btn-danger" data-signout>${icon('logout')} ${t('done_sign_out')}</button>`
      : `<button class="btn" data-close>${t('close')}</button><button class="btn btn-primary" data-print>${icon('print')} ${t('print_cashup')}</button>`,
    onMount: (el, close) => {
      el.querySelector('[data-print]').addEventListener('click', () => printShiftSheet(s));
      if (signOutAfter) {
        // a cashier's day is over: show the report, then sign out (the next cashier signs in to start theirs)
        el.querySelector('[data-signout]').addEventListener('click', async () => {
          try { await post('/logout'); } catch { /* ignore */ }
          close();
          window.dispatchEvent(new Event('psm:logout'));
        });
      }
    },
  });
}

/* ---------- the printed cash-up sheet (receipt printer) ---------- */
export function printShiftSheet(s) {
  const closed = !!s.closed_at;
  const L = slipLine, m = slipMoney;
  const cl = (counted, diff) => (counted == null ? t('not_counted') : `${m(counted)}${diff ? ` (${diff < 0 ? t('short_by') : t('over_by')} ${m(Math.abs(diff))})` : ' ✓'}`);
  const inner = `${slipHead(`${t('cashup_sheet')} · ${t('shift')} #${s.id}`)}<hr>
    ${L(t('cashier'), esc(s.user_name))}${L(t('opened'), slipStamp(s.opened_at))}${L(t('closed'), closed ? slipStamp(s.closed_at) : t('still_open'))}<hr>
    ${L(`${t('revenue')} (${s.sessions_count + s.sales_count})`, m(s.revenue), 'big')}
    ${L(`  ${t('playtime')}`, m(s.time_revenue))}${L(`  ${t('products')}`, m(s.items_revenue))}
    ${L(`  ${t('method.cash')}`, m(s.by_method.cash || 0))}${L(`  ${t('method.card')}`, m(s.card_total))}${L(`  ${t('method.online')}`, m(s.online_total))}
    ${s.discounts ? L(t('discounts'), m(s.discounts)) : ''}${s.unpaid ? L(t('on_credit'), m(s.unpaid)) : ''}${s.refunds ? L(t('refunds'), m(s.refunds)) : ''}<hr>
    ${s.opening_cash ? L(t('opening_cash'), m(s.opening_cash)) : ''}${L(`+ ${t('cash_payments')}`, m(s.cash_received))}
    ${s.moves_in ? L(`+ ${t('cash_in')}`, m(s.moves_in)) : ''}${s.moves_out ? L(`− ${t('cash_out')}`, m(s.moves_out)) : ''}
    ${s.drawer_expenses ? L(`− ${t('drawer_expenses')}`, m(s.drawer_expenses)) : ''}${s.cash_refunds ? L(`− ${t('cash_refunds')}`, m(s.cash_refunds)) : ''}
    ${L(t('drawer_should_hold'), m(s.expected_cash), 'big')}${closed ? L(t('cash_counted'), cl(s.counted_cash, s.difference)) : ''}<hr>
    ${L(t('card_should_show'), m(s.expected_card), 'big')}${closed ? L(t('counted'), cl(s.counted_card, s.card_difference)) : ''}
    ${L(t('online_should_be'), m(s.expected_online), 'big')}${closed ? L(t('counted'), cl(s.counted_online, s.online_difference)) : ''}
    ${s.moves.length ? `<hr><div class="sec">${t('cash_in_out')}</div>${s.moves.map((x) => L(esc(x.reason), (x.amount > 0 ? '+' : '−') + m(Math.abs(x.amount)))).join('')}` : ''}
    ${s.waste.length ? `<hr><div class="sec">${t('waste_this_shift')}</div>${s.waste.map((w) => L(esc(w.name), w.qty)).join('')}` : ''}
    ${closed && s.notes ? `<hr><div>${t('notes')}: ${esc(s.notes)}</div>` : ''}
    <hr><div class="c">${t('signature')}: ______________</div>`;
  return printSlip(inner, `cashup-${s.id}`);
}
