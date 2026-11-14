import { t } from '../i18n.js';
import { state, get, post, esc, money, moneyText, modal, toast, toastErr, field, opt, fmtDateTime, fmtMinutes, formBox, icon, ls } from '../core.js';
import { printInvoice, openDrawer, mergeItems } from '../print.js';

// cash · card (Visa) · online (InstaPay / Vodafone Cash) — like Kur's checkout
export const METHODS = ['cash', 'card', 'online'];
export const METHOD_ICON = { cash: '💵', card: '💳', online: '🌐', wallet: '📱', instapay: '🌐' };

/* ---------- Customers ---------- */
let customerCache = null;
export async function loadCustomers(force) {
  if (!customerCache || force) customerCache = await get('/customers');
  return customerCache;
}
export async function newCustomerDialog(prefill = {}) {
  const v = await formBox(t('new_customer'),
    field(t('name'), `<input name="name" required value="${esc(prefill.name || '')}">`) +
    field(t('phone'), `<input name="phone" inputmode="tel" value="${esc(prefill.phone || '')}">`) +
    field(t('notes'), '<input name="notes">'),
    { validate: (x) => (!x.name.trim() ? t('err.name_required') : null) });
  if (!v) return null;
  try {
    const c = await post('/customers', v);
    await loadCustomers(true);
    return c;
  } catch (err) { toastErr(err); return null; }
}
// <select name> of customers plus a "+" button. Call wireCustomerSelect(container) after mounting.
export function customerSelectHtml(name, selected, { allowEmpty = true } = {}) {
  const list = customerCache || [];
  return `<div class="row" style="flex-wrap:nowrap"><select name="${name}" data-customer-select>
    ${allowEmpty ? opt('', '—') : ''}${list.map((c) => opt(c.id, `${c.name}${c.phone ? ' · ' + c.phone : ''}${c.balance > 0 ? ` (${t('owes')} ${c.balance})` : ''}`, selected)).join('')}
  </select><button type="button" class="btn" data-new-customer title="${t('new_customer')}">${icon('plus')}</button></div>`;
}
export function wireCustomerSelect(root, onChange) {
  root.querySelectorAll('[data-new-customer]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sel = btn.parentElement.querySelector('select');
      const c = await newCustomerDialog();
      if (!c) return;
      sel.insertAdjacentHTML('beforeend', opt(c.id, `${c.name}${c.phone ? ' · ' + c.phone : ''}`));
      sel.value = c.id;
      sel.dispatchEvent(new Event('change'));
      if (onChange) onChange(c);
    });
  });
}

export { mergeItems };

/* ---------- Checkout dialog (Iki style: the dialog *is* the bill) ---------- */
const round2 = (n) => Math.round(n * 100) / 100;
const PAY_MODES = ['cash', 'card', 'online', 'split', 'credit'];
// short labels so the five payment buttons fit on one row
const MODE_LABEL = (m) => (m === 'split' ? `✂️ ${t('split')}` : m === 'credit' ? `🧾 ${t('on_credit')}` : `${METHOD_ICON[m]} ${t('pay_short.' + m)}`);

/**
 * sub: one line under the title (e.g. "PS5 - 1 · 1 h 20 min").
 * lines: [{label, amount, sub}] — the itemised bill. gross: total before discount.
 * timeAmount: the playtime part; percent discounts apply to it only (drinks are never discounted).
 * Returns {discount, payments, customer_id, note, print} or null.
 */
export async function payDialog({ title, sub, lines, gross, timeAmount = 0, customerId, discountPct = 0 }) {
  await loadCustomers();
  // the owner's limit for this user (Settings → General → Discounts); admins / "unlimited discount" have none
  const lim = state.discountLimit || { unlimited: true, pct: 100, egp: null };
  const pctBase = timeAmount > 0 ? timeAmount : gross;
  // a discount already approved on the session counts as allowed, even above this cashier's own limit
  const preapproved = discountPct ? round2((pctBase * discountPct) / 100) : 0;
  const maxDisc = lim.unlimited ? gross : Math.max(preapproved, preapproved + Math.min(gross * lim.pct / 100, lim.egp == null ? Infinity : lim.egp));
  let mode = ls('psm_pay_mode') || 'cash';
  if (!PAY_MODES.includes(mode) || mode === 'credit' || mode === 'split') mode = 'cash';
  let discount = discountPct ? round2((pctBase * discountPct) / 100) : 0;
  const printPref = state.settings.auto_print !== '0';

  // Two columns (bill | payment) so the whole checkout fits on the screen without scrolling.
  const body = `<div class="checkout">
   <section class="checkout-bill">
    ${sub ? `<p class="modal-sub">${[].concat(sub).filter(Boolean).map((s) => `<bdi>${esc(s)}</bdi>`).join(' · ')}</p>` : ''}
    <div class="due"><span>${t('amount_due')}</span><b data-due></b></div>
    <div class="paylines">
      ${lines.map((l) => `<p class="payline ${l.subtotal ? 'payline--sub' : ''}"><span>${esc(l.label)}${l.sub ? ` <em>${esc(l.sub)}</em>` : ''}</span><strong>${moneyText(l.amount)}</strong></p>`).join('')}
      <p class="payline payline--disc hidden" data-disc-line><span>${t('discount')}</span><strong data-disc-amt></strong></p>
      <p class="payline payline--total"><span>${t('total')}</span><strong data-total></strong></p>
    </div>
   </section>
   <section class="checkout-pay">
    <div class="field-block">
      <div class="row" style="justify-content:space-between;flex-wrap:nowrap">
        <span class="field-label">${t('discount')} <em>${timeAmount > 0 ? t('disc_time_only') : ''}</em></span>
        <div class="seg seg-sm" data-unit><button type="button" data-u="pct">%</button><button type="button" data-u="egp">${t('egp')}</button></div>
      </div>
      <div class="quickpick"><span data-quick class="quickpick"></span>
        <input type="number" min="0" step="any" data-disc style="width:100px"><span class="muted small" data-disc-eq dir="ltr"></span></div>
      ${lim.unlimited ? '' : `<span class="muted small">${t('your_discount_limit')}: ${lim.pct}%${lim.egp != null ? ` · ${lim.egp} ${t('egp')}` : ''}</span>`}</div>
    <div class="field-block"><span class="field-label">${t('paid_by')}</span>
      <div class="segmented segmented--wide pay-modes" data-mode>${PAY_MODES.map((m) => `<button type="button" class="segmented__opt ${m === mode ? 'is-active' : ''}" data-m="${m}">${MODE_LABEL(m)}</button>`).join('')}</div></div>
    <div data-pane="cash" class="form-grid">
      ${field(t('cash_received'), '<input name="received" type="number" min="0" step="any" placeholder="0">')}
      <div class="change-box"><span class="muted small">${t('change')}</span><b data-change>0</b></div>
    </div>
    <div data-pane="split" class="form-grid hidden">
      ${METHODS.map((m) => field(t('method.' + m), `<input name="pay_${m}" type="number" min="0" step="any" value="0" data-pay>`)).join('')}
      <div class="change-box"><span class="muted small">${t('remaining_credit')}</span><b data-remaining>0</b></div>
    </div>
    <div class="form-grid">
      ${field(t('customer'), customerSelectHtml('customer_id', customerId))}
      ${field(t('notes'), '<input name="note">')}
    </div>
    <div class="banner warn hidden" data-debt-warn>${icon('alert')} ${t('debt_needs_customer_hint')}</div>
    <p class="si-status bad" data-err></p>
   </section></div>`;

  return modal({
    title, body, xl: true,
    foot: `<label class="check" style="margin-inline-end:auto"><input type="checkbox" data-print ${printPref ? 'checked' : ''}> ${t('print_receipt')}</label>
      <button class="btn" data-close>${t('cancel')}</button>
      <button class="btn btn-good btn-lg" data-ok>${icon('check')} <span data-ok-label></span></button>`,
    onMount: (el, close) => {
      wireCustomerSelect(el);
      const q = (s) => el.querySelector(s);
      const total = () => Math.max(0, round2(gross - discount));
      const payments = () => {
        const tot = total();
        if (mode === 'credit') return [];
        if (mode === 'split') return METHODS.map((m) => ({ method: m, amount: Number(q(`[name=pay_${m}]`).value) || 0 })).filter((p) => p.amount > 0);
        return tot > 0 ? [{ method: mode, amount: tot }] : [];
      };
      const update = () => {
        const tot = total();
        q('[data-total]').textContent = moneyText(tot);
        q('[data-due]').textContent = moneyText(tot);
        const overLimit = discount > maxDisc + 0.001;
        q('[data-err]').textContent = overLimit ? `${t('err.discount_over_limit')} (${lim.pct}%${lim.egp != null ? ` · ${lim.egp} ${t('egp')}` : ''})` : '';
        q('[data-disc-line]').classList.toggle('hidden', !discount);
        q('[data-disc-amt]').textContent = '-' + moneyText(discount);
        el.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== (mode === 'split' ? 'split' : mode === 'cash' ? 'cash' : '-')));
        const received = Number(q('[name=received]').value) || 0;
        q('[data-change]').textContent = moneyText(received > tot ? received - tot : 0);
        const paid = payments().reduce((s, p) => s + p.amount, 0);
        const rem = round2(tot - paid);
        q('[data-remaining]').textContent = moneyText(Math.max(0, rem));
        const needCustomer = rem > 0.001 && !q('[name=customer_id]').value;
        q('[data-debt-warn]').classList.toggle('hidden', !needCustomer);
        q('[data-ok]').disabled = rem < -0.001 || overLimit;
        const printing = q('[data-print]').checked;
        q('[data-ok-label]').textContent = mode === 'credit' ? t('record_on_credit') : printing ? t('take_payment_print') : t('take_payment');
      };
      // Discount as % (of the playtime charge) or as a fixed amount in EGP — the cashier picks; the choice is remembered.
      let unit = ls('psm_disc_unit') === 'egp' ? 'egp' : 'pct';
      const QUICK = { pct: [0, 10, 25, 50, 100], egp: [0, 5, 10, 20, 50] };
      const input = q('[data-disc]');
      const quick = q('[data-quick]');
      // an EGP discount can't go past the playtime charge either — drinks are never discounted
      const toAmount = (v) => (unit === 'pct' ? round2((pctBase * Math.min(100, Math.max(0, v))) / 100) : round2(Math.min(pctBase, Math.max(0, v))));
      const showEq = () => {
        const eq = q('[data-disc-eq]');
        if (!discount) { eq.textContent = ''; return; }
        eq.textContent = unit === 'pct' ? `= ${moneyText(discount)}` : (pctBase > 0 ? `= ${Math.round((discount / pctBase) * 1000) / 10}%` : '');
      };
      const drawQuick = () => {
        el.querySelectorAll('[data-unit] button').forEach((b) => b.classList.toggle('on', b.dataset.u === unit));
        input.placeholder = unit === 'pct' ? '%' : t('egp');
        quick.innerHTML = QUICK[unit].map((v) => {
          const amt = toAmount(v);
          const on = v === 0 ? discount === 0 : Math.abs(amt - discount) < 0.005 && input.value === '';
          const label = v === 0 ? t('none') : unit === 'pct' ? (v === 100 ? t('free') : `${v}%`) : `${v} ${t('egp')}`;
          const tooBig = amt > maxDisc + 0.001 || (unit === 'egp' && v > pctBase + 0.001);
          return `<button type="button" class="btn btn-sm ${on ? 'on' : ''}" data-q="${v}" ${tooBig ? 'disabled' : ''}>${label}</button>`;
        }).join('');
        showEq();
      };
      // a discount set on the room before checkout shows up already chosen
      if (discount && !(unit === 'pct' && QUICK.pct.includes(discountPct))) input.value = unit === 'pct' ? discountPct : discount;
      drawQuick();
      quick.addEventListener('click', (e) => {
        const b = e.target.closest('[data-q]');
        if (!b || b.disabled) return;
        input.value = '';
        discount = toAmount(Number(b.dataset.q));
        drawQuick(); update();
      });
      input.addEventListener('input', () => {
        discount = input.value === '' ? 0 : toAmount(Number(input.value) || 0);
        drawQuick(); update();
      });
      // typing more than allowed (over 100%, or more EGP than the playtime) snaps back to the real maximum
      input.addEventListener('change', () => { if (input.value !== '' && unit === 'egp' && Number(input.value) > discount) input.value = discount; if (input.value !== '' && unit === 'pct' && Number(input.value) > 100) input.value = 100; });
      q('[data-unit]').addEventListener('click', (e) => {
        const b = e.target.closest('[data-u]');
        if (!b || b.dataset.u === unit) return;
        unit = b.dataset.u;
        ls('psm_disc_unit', unit);
        // keep the same money discount, shown in the new unit
        if (input.value !== '') input.value = unit === 'pct' ? (pctBase > 0 ? Math.round((discount / pctBase) * 1000) / 10 : 0) : discount;
        drawQuick(); update();
      });
      q('[data-mode]').addEventListener('click', (e) => {
        const b = e.target.closest('[data-m]');
        if (!b) return;
        mode = b.dataset.m;
        el.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('is-active', x === b));
        if (mode === 'split') { const c = q('[name=pay_cash]'); if (!Number(c.value)) c.value = total(); }
        if (mode !== 'split' && mode !== 'credit') ls('psm_pay_mode', mode);
        update();
        if (mode === 'cash') q('[name=received]').focus();
      });
      el.querySelectorAll('input, select').forEach((i) => { i.addEventListener('input', update); i.addEventListener('change', update); });
      update();
      setTimeout(() => (mode === 'cash' ? q('[name=received]') : q('[data-ok]')).focus(), 40);

      const confirm = () => {
        const err = q('[data-err]');
        const pays = payments();
        const paid = pays.reduce((s, p) => s + p.amount, 0);
        if (paid > total() + 0.001) { err.textContent = t('err.overpaid'); return; }
        if (paid < total() - 0.001 && !q('[name=customer_id]').value) { err.textContent = t('err.debt_needs_customer'); return; }
        const print = q('[data-print]').checked;
        close({
          discount, payments: pays, print,
          customer_id: q('[name=customer_id]').value ? Number(q('[name=customer_id]').value) : null,
          note: q('[name=note]').value,
        });
      };
      q('[data-ok]').addEventListener('click', confirm);
      q('[name=received]').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); });
    },
  });
}

// After a successful payment: open the cash drawer for cash (if enabled) and print straight away (no extra dialog), like Iki / Kur.
export function afterPayment(inv, pay) {
  toast(`${t('paid_ok')} — ${moneyText(inv.total)}`);
  window.dispatchEvent(new Event('psm:shift'));
  if (state.settings.open_drawer_on_cash === '1' && (pay.payments || []).some((p) => p.method === 'cash')) openDrawer(true);
  if (pay.print) printInvoice(inv);
}

/* ---------- Receipt ---------- */
export function receiptHtml(inv) {
  const shop = state.settings.shop_name || t('app_name');
  const s = inv.session;
  const rows = [];
  if (s) rows.push([`${t('playtime')} — ${s.console_name} (${fmtMinutes(s.minutes)})`, inv.time_amount]);
  for (const it of mergeItems(inv.items)) rows.push([`${it.name} × ${it.qty}`, it.qty * it.price]);
  return `<div class="receipt">
    <div style="text-align:center"><b style="font-size:16px">${esc(shop)}</b><div class="muted">${t('invoice')} #${inv.id} · ${fmtDateTime(inv.closed_at || inv.created_at)}</div>
    ${inv.user_name ? `<div class="muted">${t('cashier')}: ${esc(inv.user_name)}</div>` : ''}
    ${inv.customer ? `<div>${t('customer')}: ${esc(inv.customer.name)}</div>` : ''}</div>
    <hr>
    ${rows.map(([l, a]) => `<div class="line"><span>${esc(l)}</span><span>${moneyText(a)}</span></div>`).join('')}
    <hr>
    ${inv.discount ? `<div class="line"><span>${t('discount')}</span><span>-${moneyText(inv.discount)}</span></div>` : ''}
    <div class="line"><b>${t('total')}</b><b>${moneyText(inv.total)}</b></div>
    ${(inv.payments || []).map((p) => `<div class="line"><span>${t('method.' + p.method)}${p.kind === 'refund' ? ' (' + t('refund') + ')' : ''}</span><span>${moneyText(p.amount)}</span></div>`).join('')}
    ${inv.total - inv.paid > 0.001 && inv.status !== 'void' ? `<div class="line"><b>${t('remaining_credit')}</b><b>${moneyText(inv.total - inv.paid)}</b></div>` : ''}
    ${inv.status === 'void' ? `<div style="text-align:center"><b>${t('status.void')}</b></div>` : ''}
    ${state.settings.receipt_footer ? `<hr><div style="text-align:center">${esc(state.settings.receipt_footer)}</div>` : ''}
  </div>`;
}

export const printReceipt = (inv) => printInvoice(inv);

export function showReceipt(inv) {
  return modal({
    title: `${t('invoice')} #${inv.id}`,
    body: receiptHtml(inv),
    foot: `<button class="btn" data-close>${t('close')}</button><button class="btn btn-primary" data-print>${icon('print')} ${t('print')}</button>`,
    onMount: (el) => el.querySelector('[data-print]').addEventListener('click', () => printReceipt(inv)),
  });
}

/* ---------- Product picker (adds straight to a session) ---------- */
export async function productPicker(title, onAdd, currentItemsHtml) {
  const products = await get('/products');
  const cats = [...new Set(products.map((p) => p.category || ''))];
  return modal({
    title, wide: true,
    body: `<input type="search" placeholder="${t('search')}" data-search>
      <div data-current>${currentItemsHtml ? currentItemsHtml() : ''}</div>
      ${cats.map((c) => `<div class="stack" data-cat><h3 class="muted">${esc(c || t('other'))}</h3><div class="product-grid">
        ${products.filter((p) => (p.category || '') === c).map((p) => `<button class="product-tile" data-pid="${p.id}" data-name="${esc(p.name.toLowerCase())}" ${p.stock <= 0 ? 'disabled' : ''}>
          <span class="pn">${esc(p.name)}</span><span class="pp">${money(p.sell_price)}</span><span class="ps">${t('stock')}: <span class="num">${p.stock}</span></span></button>`).join('')}
      </div></div>`).join('')}`,
    foot: `<button class="btn btn-primary" data-close>${t('done')}</button>`,
    onMount: (el) => {
      el.querySelector('[data-search]').addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        el.querySelectorAll('[data-pid]').forEach((b) => b.classList.toggle('hidden', q && !b.dataset.name.includes(q)));
      });
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-pid]');
        if (!b) return;
        b.disabled = true;
        try {
          await onAdd(Number(b.dataset.pid));
          const ps = b.querySelector('.ps .num');
          ps.textContent = Number(ps.textContent) - 1;
          if (currentItemsHtml) el.querySelector('[data-current]').innerHTML = currentItemsHtml();
          toast(`${t('added')}: ${b.querySelector('.pn').textContent}`);
          b.disabled = Number(ps.textContent) <= 0;
        } catch (err) { toastErr(err); b.disabled = false; }
      });
    },
  });
}
