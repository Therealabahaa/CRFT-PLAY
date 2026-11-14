import { t } from '../i18n.js';
import { get, post, put, esc, money, moneyText, icon, modal, field, opt, formBox, toast, toastErr, delegate, fmtDateTime, busy } from '../core.js';
import { newCustomerDialog, loadCustomers, METHODS, showReceipt } from './shared.js';

export async function render(root) {
  let q = '';
  let debtOnly = false;

  async function draw() {
    const list = await get(`/customers?q=${encodeURIComponent(q)}${debtOnly ? '&debt=1' : ''}`);
    const totalDebt = list.reduce((s, c) => s + Math.max(0, c.balance), 0);
    root.innerHTML = `<div class="page-head"><h1>${t('nav.customers')}</h1><span class="spacer"></span>
        <button class="btn btn-primary" data-act="new">${icon('plus')} ${t('new_customer')}</button></div>
      <div class="kpis"><div class="kpi"><div class="label">${t('total_debts')}</div><div class="value">${money(totalDebt)}</div><div class="sub">${list.filter((c) => c.balance > 0).length} ${t('customers_owing')}</div></div></div>
      <div class="card">
        <div class="card-head"><input type="search" data-search placeholder="${t('search_name_phone')}" value="${esc(q)}" style="max-width:320px">
          <label class="check"><input type="checkbox" data-debt ${debtOnly ? 'checked' : ''}> ${t('with_debt_only')}</label></div>
        <div class="table-wrap"><table><thead><tr><th>${t('name')}</th><th>${t('phone')}</th><th>${t('notes')}</th><th class="n">${t('balance')}</th></tr></thead>
        <tbody>${list.map((c) => `<tr class="clickable" data-act="open" data-id="${c.id}"><td><b>${esc(c.name)}</b></td><td class="num">${esc(c.phone || '')}</td>
          <td class="muted">${esc(c.notes || '')}</td><td class="n">${c.balance > 0.001 ? `<span class="pill crit">${moneyText(c.balance)}</span>` : `<span class="muted">0</span>`}</td></tr>`).join('')
          || `<tr><td colspan="4" class="empty">${t('no_customers')}</td></tr>`}</tbody></table></div></div>`;
    const s = root.querySelector('[data-search]');
    let deb;
    s.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => { q = s.value.trim(); draw().then(() => { const n = root.querySelector('[data-search]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 250); });
    root.querySelector('[data-debt]').addEventListener('change', (e) => { debtOnly = e.target.checked; draw(); });
  }

  delegate(root, {
    new: async () => { if (await newCustomerDialog()) draw(); },
    open: (el) => customerDialog(Number(el.dataset.id)).then(draw),
  });
  await draw();
}

export async function customerDialog(id) {
  const c = await get(`/customers/${id}`);
  const body = `
    <div class="row"><span class="num">${esc(c.phone || '')}</span><span class="muted">${esc(c.notes || '')}</span><span class="spacer" style="flex:1"></span>
      <button class="btn btn-sm" data-act="edit">${icon('edit')} ${t('edit')}</button></div>
    <div class="kpis"><div class="kpi"><div class="label">${t('balance')}</div><div class="value ${c.balance > 0 ? 'neg' : ''}">${money(c.balance)}</div></div></div>
    ${c.balance > 0.001 ? `<div class="card stack" style="box-shadow:none"><h3>${t('pay_debt')}</h3><div class="form-grid">
      ${field(t('amount'), `<input type="number" name="amount" min="0" step="any" value="${c.balance}">`)}
      ${field(t('method'), `<select name="method">${METHODS.map((m) => opt(m, t('method.' + m))).join('')}</select>`)}
      ${field(t('notes'), '<input name="note">')}</div>
      <div><button class="btn btn-good" data-act="pay">${icon('check')} ${t('record_payment')}</button></div></div>` : ''}
    <h3>${t('debt_history')}</h3>
    <div class="table-wrap"><table><thead><tr><th>${t('time')}</th><th>${t('details')}</th><th>${t('by')}</th><th class="n">${t('amount')}</th></tr></thead>
      <tbody>${c.ledger.map((l) => `<tr ${l.invoice_id ? `class="clickable" data-act="inv" data-id="${l.invoice_id}"` : ''}><td>${fmtDateTime(l.created_at)}</td>
        <td>${l.amount > 0 ? t('debt_added') : t('debt_paid')}${l.invoice_id ? ` · ${t('invoice')} #${l.invoice_id}` : ''}${l.note ? ` <span class="muted small">${esc(l.note)}</span>` : ''}</td>
        <td class="muted">${esc(l.user_name || '')}</td><td class="n num" style="color:${l.amount > 0 ? 'var(--crit-ink)' : 'var(--good-ink)'}">${l.amount > 0 ? '+' : ''}${l.amount}</td></tr>`).join('')
        || `<tr><td colspan="4" class="empty">${t('no_records')}</td></tr>`}</tbody></table></div>
    <h3>${t('nav.invoices')}</h3>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>${t('time')}</th><th>${t('type')}</th><th class="n">${t('total')}</th><th class="n">${t('paid')}</th></tr></thead>
      <tbody>${c.invoices.map((i) => `<tr class="clickable" data-act="inv" data-id="${i.id}"><td>${i.id}</td><td>${fmtDateTime(i.closed_at)}</td><td>${t('kind.' + i.kind)}${i.status === 'void' ? ` <span class="pill">${t('status.void')}</span>` : ''}</td>
        <td class="n num">${i.total}</td><td class="n num">${i.paid}</td></tr>`).join('') || `<tr><td colspan="5" class="empty">${t('no_records')}</td></tr>`}</tbody></table></div>`;
  return modal({
    title: c.name, body, wide: true,
    foot: `<button class="btn" data-close>${t('close')}</button>`,
    onMount: (el, close) => delegate(el, {
      pay: (b) => busy(b, async () => {
        await post(`/customers/${id}/pay`, { amount: Number(el.querySelector('[name=amount]').value), method: el.querySelector('[name=method]').value, note: el.querySelector('[name=note]').value });
        toast(t('paid_ok'));
        window.dispatchEvent(new Event('psm:shift'));
        close(); customerDialog(id);
      }),
      inv: async (r) => showReceipt(await get(`/invoices/${r.dataset.id}`)),
      edit: async () => {
        const v = await formBox(t('edit'), field(t('name'), `<input name="name" value="${esc(c.name)}" required>`) + field(t('phone'), `<input name="phone" value="${esc(c.phone || '')}">`) + field(t('notes'), `<input name="notes" value="${esc(c.notes || '')}">`));
        if (!v) return;
        try { await put(`/customers/${id}`, v); await loadCustomers(true); toast(t('saved')); close(); customerDialog(id); } catch (err) { toastErr(err); }
      },
    }),
  });
}
