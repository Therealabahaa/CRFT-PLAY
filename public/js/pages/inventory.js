// Inventory — the everyday jobs from Kur, for drinks & snacks: receive a delivery (several products, total price → unit cost),
// record waste, count the whole shelf, fix one amount, print a stock list / count sheet, export to Excel, and an item card per product.
import { t } from '../i18n.js';
import { state, get, post, put, esc, money, moneyText, icon, modal, field, opt, toast, delegate, fmtDateTime, dayKey, can, busy, confirmBox, formBox } from '../core.js';
import { printSlip, slipHead, slipLine, slipMoney, slipStamp } from '../print.js';

const ui = { tab: 'stock', q: '', cat: '' };
const WASTE_REASONS = ['expired', 'damaged', 'spilled', 'staff', 'other'];
const ADJUST_REASONS = ['counting', 'unknown', 'theft', 'other'];

let products = [];
const byId = (id) => products.find((p) => p.id === Number(id));
const active = () => products.filter((p) => p.active);
const statusOf = (p) => (p.stock <= 0 ? 'out' : p.stock <= p.low_stock ? 'low' : 'ok');
const statusPill = (s) => `<span class="pill ${s === 'out' ? 'crit' : s === 'low' ? 'warn' : 'good'}"><span class="dot"></span>${t('stk.' + s)}</span>`;
const worth = (p) => Math.max(0, p.stock) * p.cost_price;
const lasts = (p) => {
  const perDay = (p.sold_14d || 0) / 14;
  if (!(perDay > 0)) return '<span class="muted">—</span>';
  const days = Math.max(0, p.stock) / perDay;
  return days < 1 ? `<span style="color:var(--crit-ink)">${t('less_than_day')}</span>` : `${Math.round(days)} ${t('days')}`;
};
const cats = () => [...new Set(products.map((p) => p.category || ''))].sort((a, b) => (a || '￿').localeCompare(b || '￿'));
const signedQty = (q) => `${q > 0 ? '+' : ''}${q}`;
// The printed count sheet and the "Count stock" screen list products in exactly the same order — grouped by
// category (no category last), then by name, numbered 1, 2, 3… — so you can copy from the paper line by line.
const sheetOrder = () => active().sort((a, b) => (a.category || '￿').localeCompare(b.category || '￿') || a.name.localeCompare(b.name));

async function loadProducts() { products = await get('/products?all=1'); return products; }

export async function render(root) {
  const manage = can('inventory');

  async function draw() {
    const head = `<div class="page-head"><h1>${t('nav.inventory')}</h1>
      <div class="seg"><button data-act="tab" data-t="stock" class="${ui.tab === 'stock' ? 'on' : ''}">📦 ${t('stock')}</button>
      <button data-act="tab" data-t="history" class="${ui.tab === 'history' ? 'on' : ''}">🕑 ${t('history')}</button></div></div>`;
    if (ui.tab === 'history') return drawHistory(head);
    await loadProducts();
    const act = active();
    const low = act.filter((p) => statusOf(p) === 'low');
    const out = act.filter((p) => statusOf(p) === 'out');
    const q = ui.q.trim().toLowerCase();
    const list = products.filter((p) => (!q || p.name.toLowerCase().includes(q)) && (ui.cat === '' || (p.category || '') === ui.cat))
      .sort((a, b) => (b.active - a.active) || (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
    root.innerHTML = head + `
      ${low.length || out.length ? `<div class="banner warn">${icon('alert')} <b>${t('time_to_restock')}:</b> ${[...out, ...low].map((p) => `<b>${esc(p.name)}</b> (${Math.max(0, p.stock)})`).join(' · ')}</div>` : ''}
      <div class="kpis">
        <div class="kpi"><div class="label">${t('products')}</div><div class="value num">${act.length}</div></div>
        <div class="kpi"><div class="label">${t('stk.low')}</div><div class="value num" style="${low.length ? 'color:var(--warn-ink)' : ''}">${low.length}</div></div>
        <div class="kpi"><div class="label">${t('stk.out')}</div><div class="value num" style="${out.length ? 'color:var(--crit-ink)' : ''}">${out.length}</div></div>
        ${manage ? `<div class="kpi"><div class="label">${t('stock_value')}</div><div class="value">${money(act.reduce((a, p) => a + worth(p), 0))}</div><div class="sub">${t('at_cost')}</div></div>` : ''}
      </div>
      <div class="card">
        <div class="card-head">
          <input type="search" data-q placeholder="${t('search')}" value="${esc(ui.q)}" style="max-width:220px">
          <div class="quickpick">${['', ...cats()].map((c) => `<button class="btn btn-sm ${ui.cat === c ? 'on' : ''}" data-act="cat" data-c="${esc(c)}">${esc(c === '' ? t('all') : c || t('other'))}</button>`).join('')}
            ${manage && cats().some(Boolean) ? `<button class="btn btn-sm" data-act="cats" style="border-style:dashed">✏️ ${t('categories')}</button>` : ''}</div>
          <span class="spacer"></span>
          ${manage ? `<button class="btn btn-good" data-act="receive">📥 ${t('receive_delivery')}</button>` : ''}
          <button class="btn" data-act="waste">🗑 ${t('record_waste')}</button>
          ${manage ? `<button class="btn" data-act="print">🖨 ${t('print_stock')}</button>
            <button class="btn" data-act="csv">⬇ Excel</button>
            <button class="btn" data-act="count">🔢 ${t('count_stock')}</button>
            <button class="btn btn-primary" data-act="new">${icon('plus')} ${t('new_product')}</button>` : ''}
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>${t('product')}</th><th class="n">${t('in_stock')}</th><th>${t('status')}</th><th class="n">${t('lasts_about')}</th><th class="n">${t('sell_price')}</th>${manage ? `<th class="n">${t('worth')}</th><th></th>` : ''}</tr></thead>
          <tbody>${list.map((p) => `<tr ${manage ? `class="clickable" data-act="card" data-id="${p.id}"` : ''} style="${p.active ? '' : 'opacity:.55'}">
            <td><b>${esc(p.name)}</b>${p.active ? '' : ` <span class="pill">${t('inactive')}</span>`}${p.category && ui.cat === '' ? `<div class="muted small">${esc(p.category)}</div>` : ''}</td>
            <td class="n"><b class="num" style="font-size:16px;${p.stock <= 0 ? 'color:var(--crit-ink)' : ''}">${p.stock}</b><div class="muted small">${t('warn_below')} ${p.low_stock}</div></td>
            <td>${statusPill(statusOf(p))}</td><td class="n">${lasts(p)}</td><td class="n num">${p.sell_price}</td>
            ${manage ? `<td class="n num">${money(worth(p))}</td><td style="text-align:end">${p.active ? `<button class="btn btn-sm btn-good" data-act="receive" data-id="${p.id}">📥 ${t('receive')}</button>` : ''}</td>` : ''}</tr>`).join('')
            || `<tr><td colspan="7" class="empty">${products.length ? t('nothing_matches') : t('start_adding_products')}</td></tr>`}</tbody></table></div>
      </div>`;
    const s = root.querySelector('[data-q]');
    s.addEventListener('input', () => {
      ui.q = s.value;
      clearTimeout(s._t);
      s._t = setTimeout(() => draw().then(() => { const n = root.querySelector('[data-q]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }), 200);
    });
  }

  async function drawHistory(head) {
    if (!ui.hFrom) { const d = new Date(); d.setDate(d.getDate() - 6); ui.hFrom = dayKey(d); ui.hTo = dayKey(); }
    await loadProducts();
    const types = { '': t('all'), purchase: t('move.purchase'), sale: t('move.sale'), waste: t('move.waste'), 'count,correction,adjust': t('counts_fixes'), return: t('move.return') };
    const moves = await get(`/stock-movements?from=${ui.hFrom}&to=${ui.hTo}${ui.hType ? `&types=${ui.hType}` : ''}${ui.hItem ? `&product_id=${ui.hItem}` : ''}`);
    root.innerHTML = head + `<div class="card"><div class="card-head">
        <label class="row small">${t('from')} <input type="date" data-hf value="${ui.hFrom}" style="width:auto"></label>
        <label class="row small">${t('to')} <input type="date" data-ht value="${ui.hTo}" style="width:auto"></label>
        <select data-htype style="width:auto">${Object.entries(types).map(([k, l]) => opt(k, l, ui.hType || '')).join('')}</select>
        <select data-hitem style="width:auto">${opt('', t('all_products'), ui.hItem || '')}${products.map((p) => opt(p.id, p.name, ui.hItem || '')).join('')}</select></div>
      <div class="table-wrap"><table><thead><tr><th>${t('time')}</th><th>${t('product')}</th><th>${t('type')}</th><th class="n">${t('qty')}</th><th class="n">${t('unit_cost')}</th><th>${t('details')}</th><th>${t('by')}</th></tr></thead>
      <tbody>${moves.map((m) => `<tr><td class="num">${fmtDateTime(m.created_at)}</td><td><b>${esc(m.product_name)}</b></td><td>${t('move.' + m.type)}${m.invoice_id ? ` · #${m.invoice_id}` : ''}</td>
        <td class="n num" style="color:${m.qty < 0 ? 'var(--crit-ink)' : m.qty > 0 ? 'var(--good-ink)' : 'inherit'}"><b>${m.type === 'count' && m.qty === 0 ? '✓' : signedQty(m.qty)}</b></td>
        <td class="n num">${m.unit_cost ?? ''}</td><td class="muted small">${esc([m.supplier, m.note].filter(Boolean).join(' — '))}</td><td class="muted">${esc(m.user_name || '')}</td></tr>`).join('')
        || `<tr><td colspan="7" class="empty">${t('no_records')}</td></tr>`}</tbody></table></div></div>`;
    const reload = () => {
      ui.hFrom = root.querySelector('[data-hf]').value || ui.hFrom; ui.hTo = root.querySelector('[data-ht]').value || ui.hTo;
      ui.hType = root.querySelector('[data-htype]').value; ui.hItem = root.querySelector('[data-hitem]').value;
      draw();
    };
    root.querySelectorAll('[data-hf],[data-ht],[data-htype],[data-hitem]').forEach((e) => e.addEventListener('change', reload));
  }

  const after = () => draw();
  delegate(root, {
    tab: (b) => { ui.tab = b.dataset.t; draw(); },
    cat: (b) => { ui.cat = b.dataset.c; draw(); },
    cats: () => categoriesDialog().then((ok) => ok && after()),
    new: () => productDialog(null).then((ok) => ok && after()),
    card: (r, e) => { if (e.target.closest('button')) return; itemCard(byId(r.dataset.id), after); },
    receive: (b) => receiveDialog(b.dataset.id).then((ok) => ok && after()),
    waste: () => wasteDialog().then((ok) => ok && after()),
    count: () => countDialog().then((ok) => ok && after()),
    print: () => printStockDialog(),
    csv: () => downloadCSV(),
  });
  await draw();
}

/* ---------- item card: everything about one product ---------- */
async function itemCard(p, after) {
  const mv = await get(`/stock-movements?recent=1&product_id=${p.id}&limit=12`);
  const stat = (l, v) => `<div class="kpi"><div class="label">${l}</div><div class="value" style="font-size:20px">${v}</div></div>`;
  const margin = p.sell_price ? Math.round(((p.sell_price - p.cost_price) / p.sell_price) * 100) : 0;
  return modal({
    title: p.name, wide: true,
    body: `<div class="row" style="justify-content:space-between"><div><span style="font-size:34px;font-weight:800;color:var(--accent)" class="num">${p.stock}</span> <span class="muted">${t('in_stock')}</span></div>${statusPill(statusOf(p))}</div>
      <div class="kpis">${stat(t('warn_below'), p.low_stock)}${stat(t('lasts_about'), lasts(p))}${stat(t('worth'), money(worth(p)))}
        ${stat(t('sell_price'), money(p.sell_price))}${stat(t('cost_price'), money(p.cost_price))}${stat(t('margin'), margin + '%')}</div>
      <div class="muted small">${t('last_counted')}: ${p.last_count ? fmtDateTime(p.last_count) : t('never')}${p.category ? ` · ${t('category')}: ${esc(p.category)}` : ''}</div>
      <div class="row">${p.active ? `<button class="btn btn-good" data-a="recv">📥 ${t('receive_delivery')}</button><button class="btn" data-a="waste">🗑 ${t('record_waste')}</button>
        <button class="btn" data-a="fix">✏️ ${t('fix_amount')}</button>` : ''}<button class="btn" data-a="edit">${icon('edit')} ${t('edit_product')}</button></div>
      <div class="row" style="justify-content:space-between"><h3>${t('what_happened')}</h3><button class="btn btn-sm" data-a="hist">${t('full_history')} →</button></div>
      <div class="paylines">${mv.length ? mv.map((x) => `<p class="payline"><span><b>${t('move.' + x.type)}</b>${x.supplier || x.note ? ` <em>${esc([x.supplier, x.note].filter(Boolean).join(' — '))}</em>` : ''}<br><em>${fmtDateTime(x.created_at)}${x.user_name ? ' · ' + esc(x.user_name) : ''}</em></span>
        <strong style="color:${x.qty < 0 ? 'var(--crit-ink)' : 'var(--good-ink)'}">${x.type === 'count' && x.qty === 0 ? '✓' : signedQty(x.qty)}</strong></p>`).join('') : `<p class="muted" style="margin:0">${t('no_records')}</p>`}</div>`,
    foot: `<button class="btn" data-close>${t('close')}</button>`,
    onMount: (el, close) => el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      close();
      const done = (ok) => ok && after();
      ({
        recv: () => receiveDialog(p.id).then(done), waste: () => wasteDialog(p.id).then(done), fix: () => fixDialog(p).then(done),
        edit: () => productDialog(p).then(done), hist: () => { ui.tab = 'history'; ui.hItem = String(p.id); ui.hType = ''; ui.hFrom = '2000-01-01'; ui.hTo = dayKey(); after(); },
      })[b.dataset.a]();
    }),
  });
}

/* ---------- new / edit product (Kur's form) ---------- */
function productDialog(p) {
  const isNew = !p;
  const catList = cats().filter(Boolean);
  return modal({
    title: isNew ? t('new_product') : `${t('edit_product')} — ${p.name}`,
    body: `${field(t('what_called'), `<input name="name" placeholder="${t('product_name_ph')}" value="${esc(p?.name || '')}">`)}
      ${field(t('category'), `<div class="row" style="flex-wrap:nowrap"><select name="category">${opt('', '—', p?.category || '')}${catList.map((c) => opt(c, c, p?.category || '')).join('')}</select>
        <button type="button" class="btn" data-newcat>${icon('plus')} ${t('new_category')}</button></div>`)}
      <div class="form-grid">
        ${field(t('sell_price_q'), `<input name="sell_price" type="number" step="any" min="0" value="${p?.sell_price ?? ''}" placeholder="${t('egp')}">`)}
        ${field(t('cost_q'), `<input name="cost_price" type="number" step="any" min="0" value="${p?.cost_price ?? ''}" placeholder="${t('egp')}">`)}
        ${isNew ? field(t('have_now_q'), '<input name="stock" type="number" step="any" min="0" value="0">') : ''}
        ${field(t('warn_me_below'), `<input name="low_stock" type="number" step="any" min="0" value="${p?.low_stock ?? 5}">`)}
      </div>
      <p class="muted small" style="margin:0" data-margin></p>
      <p class="muted small" style="margin:0">${t('cost_hint')}</p>
      ${p ? `<label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> ${t('active')} <span class="muted">${t('untick_hide')}</span></label>` : ''}`,
    foot: `<button class="btn" data-close>${t('cancel')}</button><button class="btn btn-primary" data-ok>${isNew ? t('add_product') : t('save')}</button>`,
    onMount: (el, close) => {
      const q = (n) => el.querySelector(`[name=${n}]`);
      const showMargin = () => {
        const sp = Number(q('sell_price').value), cp = Number(q('cost_price').value);
        el.querySelector('[data-margin]').textContent = sp > 0 && cp >= 0 ? `${t('profit_per_piece')}: ${moneyText(sp - cp)} (${Math.round(((sp - cp) / sp) * 100)}%)` : '';
      };
      el.addEventListener('input', showMargin); showMargin();
      el.querySelector('[data-newcat]').addEventListener('click', async () => {
        const v = await formBox(t('new_category'), field(t('name'), `<input name="cat" placeholder="${t('category_ph')}">`), { okText: t('add') });
        const name = v && v.cat.trim();
        if (!name) return;
        const sel = q('category');
        sel.insertAdjacentHTML('beforeend', opt(name, name));
        sel.value = name;
      });
      const ok = el.querySelector('[data-ok]');
      ok.addEventListener('click', () => busy(ok, async () => {
        const name = q('name').value.trim();
        if (!name) throw Object.assign(new Error(), { code: 'name_required' });
        if (!(Number(q('sell_price').value) > 0)) throw Object.assign(new Error(), { code: 'sell_price_required' });
        const body = { name, category: q('category').value, sell_price: q('sell_price').value, cost_price: q('cost_price').value || 0, low_stock: q('low_stock').value, active: p ? q('active').checked : true };
        if (isNew) await post('/products', { ...body, stock: q('stock').value });
        else await put(`/products/${p.id}`, body);
        toast(t('saved'));
        close(true);
      }));
    },
  });
}

function categoriesDialog() {
  const list = cats().filter(Boolean);
  return modal({
    title: t('categories'),
    body: `<p class="muted small" style="margin:0">${t('rename_cat_hint')}</p>${list.map((c) => `<div class="row" style="flex-wrap:nowrap"><input data-cat="${esc(c)}" value="${esc(c)}"><span class="muted small">${products.filter((p) => p.category === c).length}</span></div>`).join('')}`,
    foot: `<button class="btn" data-close>${t('cancel')}</button><button class="btn btn-primary" data-ok>${t('save')}</button>`,
    onMount: (el, close) => {
      const ok = el.querySelector('[data-ok]');
      ok.addEventListener('click', () => busy(ok, async () => {
        for (const i of el.querySelectorAll('[data-cat]')) if (i.value.trim() !== i.dataset.cat) await post('/products/rename-category', { from: i.dataset.cat, to: i.value.trim() });
        toast(t('saved'));
        close(true);
      }));
    },
  });
}

/* ---------- receive a delivery: several products, the total paid for each line ---------- */
async function receiveDialog(preId) {
  const shift = await get('/shifts/current');
  const list = active();
  const lines = [{ product_id: preId ? Number(preId) : '', qty: '', total: '' }];
  return modal({
    title: `📥 ${t('receive_delivery')}`, wide: true,
    body: `<p class="muted" style="margin:0">${t('receive_hint')}</p>
      <div class="table-wrap"><table><thead><tr><th>${t('product')}</th><th>${t('how_many')}</th><th>${t('total_paid')}</th><th>${t('adds_to_stock')}</th><th></th></tr></thead><tbody data-lines></tbody></table></div>
      <div><button class="btn btn-sm" data-add>${icon('plus')} ${t('another_item')}</button></div>
      <div class="form-grid">${field(t('supplier'), '<input name="supplier" list="psm-sups">')}${field(t('notes'), '<input name="note">')}</div>
      <label class="check"><input type="checkbox" name="from_drawer" ${shift ? '' : 'disabled'}> ${shift ? `${t('paid_from_drawer')} (${t('shift')} #${shift.id})` : `${t('paid_from_drawer')} — ${t('no_shift')}`}</label>`,
    foot: `<span style="margin-inline-end:auto">${t('total_paid')}: <b data-sum style="font-size:18px"></b></span><button class="btn" data-close>${t('cancel')}</button><button class="btn btn-good btn-lg" data-ok>📥 ${t('receive_stock')}</button>`,
    onMount: (el, close) => {
      const tbody = el.querySelector('[data-lines]');
      const redraw = () => {
        tbody.innerHTML = lines.map((l, i) => `<tr data-i="${i}">
          <td><select data-f="product_id" style="min-width:180px">${opt('', '—')}${list.map((p) => opt(p.id, `${p.name} (${p.stock})`, l.product_id)).join('')}</select></td>
          <td><input data-f="qty" type="number" min="0" step="any" value="${l.qty}" style="width:90px" placeholder="0"></td>
          <td><input data-f="total" type="number" min="0" step="any" value="${l.total}" style="width:110px" placeholder="${t('egp')}"></td>
          <td class="small" data-info></td><td><button class="icon-btn" data-rm="${i}" aria-label="${t('remove')}">${icon('x')}</button></td></tr>`).join('');
        derived();
      };
      const derived = () => {
        let sum = 0;
        lines.forEach((l, i) => {
          const p = byId(l.product_id), qty = Number(l.qty) || 0, tot = Number(l.total) || 0;
          sum += tot;
          tbody.querySelector(`tr[data-i="${i}"] [data-info]`).innerHTML = p && qty ? `<b>${p.stock} → ${p.stock + qty}</b>${tot ? `<br><span class="muted">${moneyText(tot / qty)} ${t('per_piece')}${Math.abs(tot / qty - p.cost_price) > 0.01 ? ` (${t('was')} ${p.cost_price})` : ''}</span>` : ''}` : '<span class="muted">—</span>';
        });
        el.querySelector('[data-sum]').textContent = moneyText(sum);
      };
      tbody.addEventListener('input', (e) => { const i = e.target.closest('tr')?.dataset.i; if (i == null || !e.target.dataset.f) return; lines[i][e.target.dataset.f] = e.target.value; derived(); });
      tbody.addEventListener('change', (e) => { const i = e.target.closest('tr')?.dataset.i; if (i == null || e.target.dataset.f !== 'product_id') return; lines[i].product_id = Number(e.target.value) || ''; derived(); el.querySelector(`tr[data-i="${i}"] [data-f=qty]`).focus(); });
      tbody.addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (!b) return; lines.splice(Number(b.dataset.rm), 1); if (!lines.length) lines.push({ product_id: '', qty: '', total: '' }); redraw(); });
      el.querySelector('[data-add]').addEventListener('click', () => { lines.push({ product_id: '', qty: '', total: '' }); redraw(); tbody.querySelector('tr:last-child select').focus(); });
      redraw();
      const ok = el.querySelector('[data-ok]');
      ok.addEventListener('click', () => busy(ok, async () => {
        const send = lines.filter((l) => l.product_id && Number(l.qty) > 0);
        if (!send.length) throw Object.assign(new Error(), { code: 'empty_delivery' });
        const r = await post('/inventory/receive', {
          supplier: el.querySelector('[name=supplier]').value, note: el.querySelector('[name=note]').value, from_drawer: el.querySelector('[name=from_drawer]').checked,
          lines: send.map((l) => ({ product_id: l.product_id, qty: Number(l.qty), total_cost: Number(l.total) || 0 })),
        });
        toast(`${t('delivery_received')} — ${moneyText(r.total)}`);
        if (el.querySelector('[name=from_drawer]').checked) window.dispatchEvent(new Event('psm:shift'));
        close(true);
      }));
    },
  });
}

/* ---------- waste ---------- */
function wasteDialog(preId) {
  const list = active();
  return modal({
    title: `🗑 ${t('record_waste')}`,
    body: `<p class="muted" style="margin:0">${t('waste_hint')}</p>
      ${field(t('what_wasted'), `<select name="pid">${list.map((p) => opt(p.id, `${p.name} (${p.stock})`, preId)).join('')}</select>`)}
      <div class="form-grid">${field(t('how_many'), '<input name="qty" type="number" min="0" step="any" value="1">')}
        ${field(t('why'), `<select name="reason">${WASTE_REASONS.map((r) => opt(t('wr.' + r), t('wr.' + r))).join('')}</select>`)}</div>
      ${field(t('notes'), '<input name="note">')}`,
    foot: `<button class="btn" data-close>${t('cancel')}</button><button class="btn btn-danger" data-ok>🗑 ${t('record_waste')}</button>`,
    onMount: (el, close) => {
      const ok = el.querySelector('[data-ok]');
      ok.addEventListener('click', () => busy(ok, async () => {
        const p = byId(el.querySelector('[name=pid]').value);
        const qty = Number(el.querySelector('[name=qty]').value);
        await post(`/products/${p.id}/waste`, { qty, reason: el.querySelector('[name=reason]').value, note: el.querySelector('[name=note]').value });
        toast(`${t('waste_recorded')}: ${p.name} × ${qty}`);
        close(true);
      }));
    },
  });
}

/* ---------- count the whole shelf ---------- */
function countDialog() {
  const list = sheetOrder();
  const grouped = cats().length > 1;
  let lastCat = null;
  const rows = list.map((p, i) => {
    const cat = p.category || '';
    const head = grouped && cat !== lastCat ? `<tr class="sheet-cat" data-cat="${esc(cat)}"><td colspan="5">— ${esc(cat || t('other'))} —</td></tr>` : '';
    lastCat = cat;
    return head + `<tr data-n="${esc(p.name.toLowerCase())}" data-c="${esc(cat)}"><td class="num muted">${i + 1}</td><td><b>${esc(p.name)}</b></td><td class="n num">${p.stock}</td>
      <td><input data-id="${p.id}" type="number" min="0" step="any" style="max-width:110px"></td><td class="n num" data-d="${p.id}">—</td></tr>`;
  }).join('');
  return modal({
    title: `🔢 ${t('count_stock')}`, wide: true,
    body: `<p class="muted" style="margin:0">${t('count_all_hint')}</p>
      <div class="row"><input type="search" data-q placeholder="${t('search')}" style="max-width:220px">
        <button type="button" class="btn btn-sm" data-print-sheet>🖨 ${t('count_sheet')}</button>
        <span class="muted small">${t('same_order_as_sheet')}</span></div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>${t('product')}</th><th class="n">${t('system_says')}</th><th>${t('you_counted')}</th><th class="n">${t('difference')}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <div class="form-grid">${field(t('why_mismatch'), `<select name="reason">${ADJUST_REASONS.map((r) => opt(t('ar.' + r), t('ar.' + r))).join('')}</select>`)}${field(t('notes'), '<input name="note">')}</div>
      <div class="muted small" data-summary></div>`,
    foot: `<button class="btn" data-close>${t('cancel')}</button><button class="btn btn-primary btn-lg" data-ok>${t('save_count')}</button>`,
    onMount: (el, close) => {
      const summary = () => {
        let n = 0, diff = 0, value = 0;
        el.querySelectorAll('[data-id]').forEach((i) => {
          if (i.value === '') return;
          const p = byId(i.dataset.id), d = Math.round((Number(i.value) - p.stock) * 1000) / 1000;
          n++; if (d) diff++; value += d * p.cost_price;
        });
        el.querySelector('[data-summary]').textContent = n ? `${n} ${t('counted_items')} · ${diff} ${t('different')} · ${t('value')} ${value >= 0 ? '+' : ''}${moneyText(value)}` : '';
      };
      el.querySelector('[data-q]').addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        el.querySelectorAll('tr[data-n]').forEach((tr) => tr.classList.toggle('hidden', !!q && !tr.dataset.n.includes(q)));
        // hide a category heading when none of its products match
        el.querySelectorAll('tr.sheet-cat').forEach((h) => h.classList.toggle('hidden', !!q && ![...el.querySelectorAll(`tr[data-n][data-c="${CSS.escape(h.dataset.cat)}"]`)].some((tr) => !tr.classList.contains('hidden'))));
      });
      el.querySelector('[data-print-sheet]').addEventListener('click', () => printStock('sheet'));
      el.addEventListener('input', (e) => {
        const id = e.target.dataset.id;
        if (!id) return;
        const p = byId(id), c = el.querySelector(`[data-d="${id}"]`);
        if (e.target.value === '') { c.textContent = '—'; c.style.color = ''; summary(); return; }
        const d = Math.round((Number(e.target.value) - p.stock) * 1000) / 1000;
        c.innerHTML = d === 0 ? `✓ ${t('matches')}` : `<b>${signedQty(d)}</b>`;
        c.style.color = d === 0 ? 'var(--good-ink)' : d < 0 ? 'var(--crit-ink)' : 'var(--accent)';
        summary();
      });
      const ok = el.querySelector('[data-ok]');
      ok.addEventListener('click', () => busy(ok, async () => {
        const lines = [...el.querySelectorAll('[data-id]')].filter((i) => i.value !== '').map((i) => ({ product_id: Number(i.dataset.id), counted: Number(i.value) }));
        if (!lines.length) throw Object.assign(new Error(), { code: 'empty_count' });
        const diffs = lines.filter((l) => Math.abs(l.counted - byId(l.product_id).stock) > 0.0001).length;
        if (!(await confirmBox(t('confirm_count').replace('{n}', lines.length).replace('{d}', diffs), { okText: t('save_count') }))) return;
        const r = await post('/inventory/count', { reason: el.querySelector('[name=reason]').value, note: el.querySelector('[name=note]').value, lines });
        close(true);
        toast(t('count_saved'));
        const lost = r.lines.reduce((s, l) => s + l.value, 0);
        modal({
          title: t('count_result'),
          body: `<div class="paylines">${r.lines.map((l) => `<p class="payline"><span><b>${esc(l.name)}</b> <em>${l.system} → ${l.counted}</em></span>
            <strong style="color:${l.difference < 0 ? 'var(--crit-ink)' : l.difference > 0 ? 'var(--accent)' : 'var(--good-ink)'}">${l.difference ? signedQty(l.difference) : '✓'}</strong></p>`).join('')}
            <p class="payline payline--total"><span>${t('value')}</span><strong>${lost >= 0 ? '+' : ''}${moneyText(lost)}</strong></p></div>`,
          foot: `<button class="btn btn-primary" data-close>${t('close')}</button>`,
        });
      }));
    },
  });
}

/* ---------- fix the amount of one product ---------- */
function fixDialog(p) {
  const admin = state.user.role === 'admin';
  let mode = 'count';
  return modal({
    title: `✏️ ${t('fix_amount')} — ${p.name}`,
    body: `<div class="lang-choices">
        <button type="button" class="lang-choice on" data-m="count"><b>${t('i_counted_it')}</b><span class="muted small">${t('set_exact')}</span></button>
        ${admin ? `<button type="button" class="lang-choice" data-m="entry"><b>✏️ ${t('entered_wrong')}</b><span class="muted small">${t('fix_typing')}</span></button>` : ''}</div>
      <div class="banner info hidden" data-entry-hint style="display:block">${t('entry_hint')}</div>
      <div class="form-grid">${field(`${t('actual_stock')} (${t('system_stock')}: ${p.stock})`, `<input name="stock" type="number" min="0" step="any" value="${p.stock}">`)}
        <div data-reason>${field(t('why_mismatch'), `<select name="reason">${ADJUST_REASONS.map((r) => opt(t('ar.' + r), t('ar.' + r))).join('')}</select>`)}</div></div>
      ${field(t('notes'), '<input name="note">')}`,
    foot: `<button class="btn" data-close>${t('cancel')}</button><button class="btn btn-primary" data-ok>${t('save')}</button>`,
    onMount: (el, close) => {
      el.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => {
        mode = b.dataset.m;
        el.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === b));
        el.querySelector('[data-entry-hint]').classList.toggle('hidden', mode !== 'entry');
        el.querySelector('[data-reason]').classList.toggle('hidden', mode === 'entry');
      }));
      const ok = el.querySelector('[data-ok]');
      ok.addEventListener('click', () => busy(ok, async () => {
        const stock = Number(el.querySelector('[name=stock]').value);
        await post(`/products/${p.id}/count`, { stock, mode, reason: mode === 'entry' ? '' : el.querySelector('[name=reason]').value, note: el.querySelector('[name=note]').value });
        toast(`${p.name}: ${stock} ✔${mode === 'entry' ? ` (${t('not_loss')})` : ''}`);
        close(true);
      }));
    },
  });
}

/* ---------- print: stock list or a count sheet on the receipt printer ---------- */
function printStockDialog() {
  let kind = 'list';
  return modal({
    title: `🖨 ${t('print_stock')}`,
    body: `<p class="muted" style="margin:0">${t('print_stock_hint')}</p>
      <div class="lang-choices">
        <button type="button" class="lang-choice on" data-k="list"><b>📋 ${t('stock_list')}</b><span class="muted small">${t('stock_list_hint')}</span></button>
        <button type="button" class="lang-choice" data-k="sheet"><b>✍️ ${t('count_sheet')}</b><span class="muted small">${t('count_sheet_hint')}</span></button></div>`,
    foot: `<button class="btn" data-close>${t('cancel')}</button><button class="btn btn-primary btn-lg" data-ok>🖨 ${t('print')}</button>`,
    onMount: (el, close) => {
      el.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => { kind = b.dataset.k; el.querySelectorAll('[data-k]').forEach((x) => x.classList.toggle('on', x === b)); }));
      const ok = el.querySelector('[data-ok]');
      ok.addEventListener('click', () => busy(ok, async () => { await printStock(kind); close(true); }));
    },
  });
}
async function printStock(kind) {
  const list = sheetOrder();
  const sheet = kind === 'sheet';
  const total = list.reduce((a, p) => a + worth(p), 0);
  let lastCat = null;
  const rows = list.map((p, i) => {
    const head = (p.category || '') !== lastCat && cats().length > 1 ? `<div class="sec">— ${esc(p.category || t('other'))} —</div>` : '';
    lastCat = p.category || '';
    return head + (sheet
      ? `<div class="l"><span><b>${i + 1}. ${esc(p.name)}</b><br>${t('system')}: ${p.stock}</span><span class="box"></span></div>`
      : slipLine(`${i + 1}. ${esc(p.name)}${statusOf(p) !== 'ok' ? ' ⚠' : ''}`, `<b>${p.stock}</b>`));
  }).join('');
  const inner = `${slipHead(sheet ? t('count_sheet') : t('stock_list'))}<hr>
    <div>${slipStamp(Date.now())}</div><div>${t('by')}: ${esc(state.user.name)}</div><hr>
    ${rows}<hr>
    ${slipLine(`${list.length} ${t('products')}`, sheet ? '' : `<b>${t('worth')} ${slipMoney(total)}</b>`)}
    ${sheet ? `<hr><div class="c">${t('counted_by')}: ____________</div>` : ''}`;
  const r = await printSlip(inner, sheet ? 'count-sheet' : 'stock-list');
  if (r && r.ok) toast(t('sent_to_printer'));
}

/* ---------- Excel (CSV with BOM so Arabic opens right in Excel) ---------- */
function downloadCSV() {
  const rows = [[t('product'), t('category'), t('in_stock'), t('warn_below'), t('status'), t('sell_price'), t('cost_price'), t('worth'), t('sold_14d')]];
  for (const p of active()) rows.push([p.name, p.category || '', p.stock, p.low_stock, t('stk.' + statusOf(p)), p.sell_price, p.cost_price, Math.round(worth(p) * 100) / 100, p.sold_14d || 0]);
  const csv = '﻿' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `stock-${dayKey()}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
