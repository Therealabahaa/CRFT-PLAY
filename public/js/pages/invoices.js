import { t } from '../i18n.js';
import { state, get, post, esc, money, moneyText, icon, modal, field, opt, toast, toastErr, delegate, fmtDateTime, dayKey, can, busy } from '../core.js';
import { receiptHtml, printReceipt, METHOD_ICON, loadCustomers, customerSelectHtml, wireCustomerSelect } from './shared.js';

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Edit a paid invoice: change quantities, remove a line, or add what was forgotten.
 * Lines already on the bill keep the price they were sold at; added pieces cost today's price.
 * The difference is paid now (cash / Visa / online / on credit) or given back.
 */
async function editInvoiceDialog(inv) {
  const products = await get('/products');
  await loadCustomers();
  // the bill per product: the rows as sold (oldest first) and the quantity wanted now
  const lines = new Map();
  for (const it of inv.items) {
    if (!it.product_id) continue;
    const l = lines.get(it.product_id) || { product_id: it.product_id, name: it.name, rows: [], qty: 0 };
    l.rows.push({ qty: it.qty, price: it.price });
    l.qty = Math.round((l.qty + it.qty) * 1000) / 1000;
    lines.set(it.product_id, l);
  }
  for (const l of lines.values()) l.orig = l.qty;
  const priceOf = (pid) => products.find((p) => p.id === pid)?.sell_price ?? 0;
  const lineAmount = (l) => {
    if (l.qty >= l.orig) return l.rows.reduce((s, x) => s + x.qty * x.price, 0) + (l.qty - l.orig) * priceOf(l.product_id);
    let keep = l.qty; let s = 0; // pieces come off the newest rows first (same as the server)
    for (const x of l.rows) { const k = Math.min(keep, x.qty); s += k * x.price; keep -= k; }
    return s;
  };
  let mode = 'cash';

  return modal({
    title: `✏️ ${t('edit_invoice')} #${inv.id}`, xl: true,
    body: `<div class="checkout">
      <section class="checkout-bill">
        <p class="muted small" style="margin:0">${t('edit_invoice_hint')}</p>
        <div class="paylines" data-lines></div>
        <div class="paylines">
          <p class="payline"><span>${t('old_total')}</span><strong>${moneyText(inv.total)}</strong></p>
          <p class="payline payline--total"><span>${t('new_total')}</span><strong data-new></strong></p>
          <p class="payline"><span data-diff-label></span><strong data-diff></strong></p>
        </div>
      </section>
      <section class="checkout-pay">
        <span class="field-label">${t('add_forgotten')}</span>
        <input type="search" data-q placeholder="${t('search')}">
        <div class="product-grid" data-products style="max-height:260px;overflow-y:auto"></div>
        <div data-settle class="stack">
          <span class="field-label" data-settle-label></span>
          <div class="segmented segmented--wide pay-modes" data-mode style="grid-template-columns:repeat(4,1fr)"></div>
          <div data-cust class="hidden">${field(t('customer'), customerSelectHtml('customer_id', inv.customer_id))}</div>
        </div>
        ${field(t('reason'), `<input name="reason" placeholder="${t('edit_reason_ph')}">`)}
        <p class="si-status bad" data-err></p>
      </section></div>`,
    foot: `<button class="btn" data-close>${t('cancel')}</button><button class="btn btn-primary btn-lg" data-ok>${icon('check')} <span data-ok-label>${t('save')}</span></button>`,
    onMount: (el, close) => {
      wireCustomerSelect(el);
      const q = (s) => el.querySelector(s);
      const drawProducts = () => {
        const s = q('[data-q]').value.trim().toLowerCase();
        q('[data-products]').innerHTML = products.filter((p) => !s || p.name.toLowerCase().includes(s)).map((p) => {
          const used = (lines.get(p.id)?.qty || 0) - (lines.get(p.id)?.orig || 0);
          const left = p.stock - Math.max(0, used);
          return `<button class="product-tile" data-add="${p.id}" ${left <= 0 ? 'disabled' : ''}><span class="pn">${esc(p.name)}</span><span class="pp">${money(p.sell_price)}</span><span class="ps">${t('stock')}: <span class="num">${left}</span></span></button>`;
        }).join('') || `<div class="empty">${t('no_products')}</div>`;
      };
      const totals = () => {
        const items = [...lines.values()].reduce((s, l) => s + lineAmount(l), 0);
        const gross = r2(inv.time_amount + items);
        return { total: r2(gross - Math.min(inv.discount, gross)) };
      };
      const draw = () => {
        const rows = [];
        if (inv.session) rows.push(`<p class="payline"><span>${t('playtime')} <em>${esc(inv.session.console_name)}</em></span><strong>${moneyText(inv.time_amount)}</strong></p>`);
        for (const l of lines.values()) {
          const changed = l.qty !== l.orig;
          rows.push(`<div class="edit-line ${l.qty === 0 ? 'removed' : ''}"><span class="grow"><b>${esc(l.name)}</b>${changed ? ` <em class="muted small">(${t('was')} ${l.orig})</em>` : ''}</span>
            <div class="qty"><button type="button" data-dec="${l.product_id}" aria-label="-">−</button><b class="num" style="min-width:26px;text-align:center">${l.qty}</b><button type="button" data-inc="${l.product_id}" aria-label="+">+</button></div>
            <strong class="num" style="min-width:70px;text-align:end">${moneyText(lineAmount(l))}</strong>
            <button type="button" class="icon-btn" data-rm="${l.product_id}" aria-label="${t('remove')}">${icon('trash')}</button></div>`);
        }
        if (inv.discount) rows.push(`<p class="payline payline--disc"><span>${t('discount')}</span><strong>-${moneyText(inv.discount)}</strong></p>`);
        q('[data-lines]').innerHTML = rows.join('') || `<p class="muted" style="margin:0">${t('no_products')}</p>`;
        const { total } = totals();
        const diff = r2(total - inv.total);
        q('[data-new]').textContent = moneyText(total);
        q('[data-diff-label]').textContent = diff > 0 ? t('customer_pays_more') : diff < 0 ? t('give_back') : t('no_difference');
        q('[data-diff]').textContent = diff ? moneyText(Math.abs(diff)) : '—';
        q('[data-diff]').style.color = diff > 0 ? 'var(--accent)' : diff < 0 ? 'var(--crit-ink)' : 'inherit';
        // how the difference is settled
        q('[data-settle]').classList.toggle('hidden', !diff);
        const modes = diff > 0 ? ['cash', 'card', 'online', 'credit'] : ['cash', 'card', 'online'];
        if (!modes.includes(mode)) mode = 'cash';
        q('[data-settle-label]').textContent = diff > 0 ? t('paid_by') : t('give_back_by');
        q('[data-mode]').style.gridTemplateColumns = `repeat(${modes.length},1fr)`;
        q('[data-mode]').innerHTML = modes.map((m) => `<button type="button" class="segmented__opt ${m === mode ? 'is-active' : ''}" data-m="${m}">${m === 'credit' ? `🧾 ${t('on_credit')}` : `${METHOD_ICON[m]} ${t('pay_short.' + m)}`}</button>`).join('');
        q('[data-cust]').classList.toggle('hidden', !(diff > 0 && mode === 'credit'));
        q('[data-ok-label]').textContent = diff > 0 ? `${t('save_and_collect')} ${moneyText(diff)}` : diff < 0 ? `${t('save_and_give_back')} ${moneyText(-diff)}` : t('save');
        drawProducts();
      };
      const bump = (pid, d) => {
        const p = products.find((x) => x.id === pid);
        let l = lines.get(pid);
        if (!l) { l = { product_id: pid, name: p.name, rows: [], qty: 0, orig: 0 }; lines.set(pid, l); }
        const next = Math.max(0, Math.round((l.qty + d) * 1000) / 1000);
        if (d > 0 && p && next - l.orig > p.stock) return toast(t('err.insufficient_stock'), true);
        l.qty = next;
        if (l.qty === 0 && l.orig === 0) lines.delete(pid);
        draw();
      };
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-inc],[data-dec],[data-rm],[data-add],[data-m]');
        if (!b) return;
        if (b.dataset.inc) bump(Number(b.dataset.inc), 1);
        else if (b.dataset.dec) bump(Number(b.dataset.dec), -1);
        else if (b.dataset.rm) { const l = lines.get(Number(b.dataset.rm)); bump(l.product_id, -l.qty); }
        else if (b.dataset.add) bump(Number(b.dataset.add), 1);
        else if (b.dataset.m) { mode = b.dataset.m; draw(); }
      });
      q('[data-q]').addEventListener('input', drawProducts);
      draw();
      const ok = q('[data-ok]');
      ok.addEventListener('click', () => busy(ok, async () => {
        const reason = q('[name=reason]').value.trim();
        if (!reason) { q('[data-err]').textContent = t('err.reason_required'); q('[name=reason]').focus(); return; }
        const r = await post(`/invoices/${inv.id}/edit`, {
          items: [...lines.values()].map((l) => ({ product_id: l.product_id, qty: l.qty })),
          method: mode, reason, customer_id: q('[name=customer_id]')?.value || null,
        });
        toast(`${t('invoice_edited')} — ${r.difference > 0 ? `+${moneyText(r.difference)}` : r.difference < 0 ? `-${moneyText(-r.difference)}` : ''}`);
        window.dispatchEvent(new Event('psm:shift'));
        window.dispatchEvent(new Event('psm:invoice-changed'));
        if (state.settings.auto_print !== '0') printReceipt(r.invoice);
        close(r.invoice);
      }));
    },
  });
}

export async function render(root) {
  let from = dayKey();
  let to = dayKey();
  let kind = '';

  async function draw() {
    const list = await get(`/invoices?from=${from}&to=${to}${kind ? '&kind=' + kind : ''}`);
    const closed = list.filter((i) => i.status === 'closed');
    const sum = (k) => closed.reduce((s, i) => s + i[k], 0);
    root.innerHTML = `<div class="page-head"><h1>${t('nav.invoices')}</h1><span class="spacer"></span>
        <label class="row small">${t('from')} <input type="date" data-from value="${from}" style="width:auto"></label>
        <label class="row small">${t('to')} <input type="date" data-to value="${to}" style="width:auto"></label>
        <select data-kind style="width:auto">${opt('', t('all'), kind)}${opt('session', t('kind.session'), kind)}${opt('sale', t('kind.sale'), kind)}</select></div>
      <div class="kpis">
        <div class="kpi"><div class="label">${t('invoices_count')}</div><div class="value num">${closed.length}</div></div>
        <div class="kpi"><div class="label">${t('total')}</div><div class="value">${money(sum('total'))}</div></div>
        <div class="kpi"><div class="label">${t('paid')}</div><div class="value">${money(sum('paid'))}</div></div>
        <div class="kpi"><div class="label">${t('discounts')}</div><div class="value">${money(sum('discount'))}</div></div>
      </div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>#</th><th>${t('time')}</th><th>${t('type')}</th><th>${t('customer')}</th><th>${t('cashier')}</th><th class="n">${t('playtime')}</th><th class="n">${t('products')}</th><th class="n">${t('discount')}</th><th class="n">${t('total')}</th><th class="n">${t('paid')}</th></tr></thead>
        <tbody>${list.map((i) => `<tr class="clickable" data-act="open" data-id="${i.id}">
          <td>${i.id}</td><td>${fmtDateTime(i.closed_at || i.created_at)}</td>
          <td>${t('kind.' + i.kind)}${i.console_name ? ` · ${esc(i.console_name)}` : ''} ${i.status === 'void' ? `<span class="pill">${t('status.void')}</span>` : ''}${i.edit_count ? ` <span class="pill info">✏️ ${t('edited')}</span>` : ''}</td>
          <td>${esc(i.customer_name || '')}</td><td class="muted">${esc(i.user_name || '')}</td>
          <td class="n num">${i.time_amount || ''}</td><td class="n num">${i.items_amount || ''}</td><td class="n num">${i.discount || ''}</td>
          <td class="n num"><b>${i.total}</b></td><td class="n num">${i.paid < i.total && i.status === 'closed' ? `<span class="pill crit">${i.paid}</span>` : i.paid}</td></tr>`).join('')
          || `<tr><td colspan="10" class="empty">${t('no_records')}</td></tr>`}</tbody></table></div></div>`;
    const reload = () => { from = root.querySelector('[data-from]').value || dayKey(); to = root.querySelector('[data-to]').value || from; kind = root.querySelector('[data-kind]').value; draw(); };
    root.querySelectorAll('[data-from],[data-to],[data-kind]').forEach((e) => e.addEventListener('change', reload));
  }

  delegate(root, { open: (el) => invoiceDialog(Number(el.dataset.id)).then(draw) });
  const onChanged = () => draw();
  window.addEventListener('psm:invoice-changed', onChanged);
  await draw();
  return () => window.removeEventListener('psm:invoice-changed', onChanged);
}

export async function invoiceDialog(id) {
  const [inv, shift] = await Promise.all([get(`/invoices/${id}`), get('/shifts/current')]);
  const canRefund = can('refund') && inv.status === 'closed';
  // anyone can fix an invoice from the shift that is open now; older ones need the refunds permission
  const canEdit = inv.status === 'closed' && shift && (can('refund') || inv.shift_id === shift.id);
  return modal({
    title: `${t('invoice')} #${inv.id}`,
    body: (inv.edit_count ? `<div class="banner info">✏️ ${t('edited_times').replace('{n}', inv.edit_count)} · ${fmtDateTime(inv.edited_at)}</div>` : '') +
      receiptHtml(inv) + (inv.void_reason ? `<div class="banner warn">${t('reason')}: ${esc(inv.void_reason)}</div>` : '') +
      (canRefund ? `<details class="card" style="box-shadow:none"><summary><b>${t('refund')}</b></summary><div class="stack" style="margin-top:10px">
        ${field(t('reason'), '<input name="reason" required>')}
        <p class="muted small" style="margin:0">${t('refund_same_way')}</p>
        <label class="check"><input type="checkbox" name="restock" checked> ${t('return_to_stock')}</label>
        <div><button class="btn btn-danger" data-act="refund">${t('refund')} ${inv.paid ? '(' + inv.paid + ' ' + t('egp') + ')' : ''}</button></div></div></details>` : ''),
    foot: `${canEdit ? `<button class="btn" data-act="edit" style="margin-inline-end:auto">✏️ ${t('edit_invoice')}</button>` : ''}
      <button class="btn" data-close>${t('close')}</button><button class="btn btn-primary" data-print>${icon('print')} ${t('print')}</button>`,
    onMount: (el, close) => {
      el.querySelector('[data-print]').addEventListener('click', () => printReceipt(inv));
      el.closest('.modal').querySelector('.modal-foot').addEventListener('click', async (e) => {
        if (!e.target.closest('[data-act=edit]')) return;
        close();
        const saved = await editInvoiceDialog(inv);
        await invoiceDialog(saved ? saved.id : id); // show the bill again (updated)
      });
      delegate(el, {
        refund: (b) => busy(b, async () => {
          const reason = el.querySelector('[name=reason]').value.trim();
          if (!reason) return toast(t('err.reason_required'), true);
          await post(`/invoices/${id}/refund`, { reason, restock: el.querySelector('[name=restock]').checked });
          toast(t('refunded'));
          window.dispatchEvent(new Event('psm:shift'));
          close();
        }),
      });
    },
  });
}
