import { t } from '../i18n.js';
import { get, post, del, esc, money, icon, field, opt, formBox, toast, toastErr, delegate, fmtDateTime, dayKey, can, confirmBox } from '../core.js';

const CATS = ['rent', 'electricity', 'internet', 'maintenance', 'controllers', 'salaries', 'stock', 'other'];

export async function render(root) {
  const d0 = new Date();
  let from = dayKey(new Date(d0.getFullYear(), d0.getMonth(), 1));
  let to = dayKey();

  async function draw() {
    const list = await get(`/expenses?from=${from}&to=${to}`);
    const byCat = {};
    for (const e of list) byCat[e.category] = (byCat[e.category] || 0) + e.amount;
    const total = list.filter((e) => e.category !== 'stock').reduce((s, e) => s + e.amount, 0);
    root.innerHTML = `<div class="page-head"><h1>${t('nav.expenses')}</h1><span class="spacer"></span>
        <label class="row small">${t('from')} <input type="date" data-from value="${from}" style="width:auto"></label>
        <label class="row small">${t('to')} <input type="date" data-to value="${to}" style="width:auto"></label>
        <button class="btn btn-primary" data-act="new">${icon('plus')} ${t('new_expense')}</button></div>
      <div class="kpis"><div class="kpi"><div class="label">${t('total_expenses')}</div><div class="value">${money(total)}</div><div class="sub">${t('excl_stock')}</div></div>
        ${Object.entries(byCat).map(([c, v]) => `<div class="kpi"><div class="label">${t('exp.' + c)}</div><div class="value">${money(v)}</div></div>`).join('')}</div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>${t('date')}</th><th>${t('category')}</th><th>${t('notes')}</th><th>${t('from_drawer')}</th><th>${t('by')}</th><th class="n">${t('amount')}</th><th></th></tr></thead>
        <tbody>${list.map((e) => `<tr><td>${fmtDateTime(e.spent_at)}</td><td>${t('exp.' + e.category)}</td><td>${esc(e.note || '')}</td>
          <td>${e.from_drawer ? `<span class="pill info">${icon('check')} ${t('yes')}</span>` : ''}</td><td class="muted">${esc(e.user_name || '')}</td>
          <td class="n num"><b>${e.amount}</b></td><td>${can('manage') ? `<button class="icon-btn" data-act="del" data-id="${e.id}" aria-label="${t('delete')}">${icon('trash')}</button>` : ''}</td></tr>`).join('')
          || `<tr><td colspan="7" class="empty">${t('no_records')}</td></tr>`}</tbody></table></div></div>`;
    const reload = () => { from = root.querySelector('[data-from]').value || dayKey(); to = root.querySelector('[data-to]').value || from; draw(); };
    root.querySelectorAll('[data-from],[data-to]').forEach((e) => e.addEventListener('change', reload));
  }

  delegate(root, {
    new: async () => {
      const v = await formBox(t('new_expense'),
        field(t('category'), `<select name="category">${CATS.filter((c) => c !== 'stock').map((c) => opt(c, t('exp.' + c))).join('')}</select>`) +
        field(t('amount'), '<input name="amount" type="number" step="any" min="0" required>') +
        field(t('date'), `<input name="date" type="date" value="${dayKey()}">`) +
        field(t('notes'), '<input name="note">') +
        `<label class="check" style="grid-column:1/-1"><input type="checkbox" name="from_drawer"> ${t('paid_from_drawer_hint')}</label>`,
        { validate: (x) => (!(Number(x.amount) > 0) ? t('err.invalid_amount') : null) });
      if (!v) return;
      try { await post('/expenses', v); toast(t('saved')); window.dispatchEvent(new Event('psm:shift')); draw(); } catch (err) { toastErr(err); }
    },
    del: async (b) => {
      if (!(await confirmBox(t('confirm_delete'), { danger: true, okText: t('delete') }))) return;
      try { await del(`/expenses/${b.dataset.id}`); toast(t('deleted')); draw(); } catch (err) { toastErr(err); }
    },
  });
  await draw();
}
