import { t, lang } from '../i18n.js';
import { get, esc, money, moneyText, icon, dayKey, fmtMinutes, pad } from '../core.js';

/* ---------- Column chart (inline SVG, stacked when >1 series) ---------- */
function columnChart(el, { labels, series, fmt = (v) => v, tipTitle = (i) => labels[i] }) {
  const W = 800, H = 220, padL = 44, padB = 24, padT = 8, gap = 2;
  const totals = labels.map((_, i) => series.reduce((s, se) => s + Math.max(0, se.values[i] || 0), 0));
  const max = Math.max(1, ...totals);
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const plotW = W - padL - 8, plotH = H - padT - padB;
  const bw = plotW / labels.length;
  const barW = Math.max(2, Math.min(36, bw * 0.62));
  const y = (v) => padT + plotH - (v / top) * plotH;
  const every = Math.ceil(labels.length / 12);
  let svg = '';
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg += `<line class="${v === 0 ? 'base-line' : 'grid-line'}" x1="${padL}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text class="axis-label" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`;
  }
  labels.forEach((lab, i) => {
    const cx = padL + bw * i + bw / 2;
    let base = y(0);
    let col = `<rect class="hover-band" x="${padL + bw * i}" y="${padT}" width="${bw}" height="${plotH}"/>`;
    const visible = series.map((se, k) => ({ v: Math.max(0, se.values[i] || 0), k })).filter((x) => x.v > 0);
    visible.forEach(({ v, k }, j) => {
      const h = Math.max(0, (v / top) * plotH - (j > 0 ? gap : 0));
      const yTop = base - h - (j > 0 ? gap : 0);
      const isTop = j === visible.length - 1;
      col += `<path class="bar ${series[k].cls || ''}" d="${barPath(cx - barW / 2, yTop, barW, base - (j > 0 ? gap : 0) - yTop, isTop ? Math.min(4, barW / 2) : 0)}"/>`;
      base = yTop;
    });
    if (i % every === 0) col += `<text class="axis-label" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(lab)}</text>`;
    col += `<rect class="hit" data-i="${i}" x="${padL + bw * i}" y="${padT}" width="${bw}" height="${plotH}"/>`;
    svg += `<g class="col">${col}</g>`;
  });
  el.innerHTML = `<div class="chart"><svg viewBox="0 0 ${W} ${H}" direction="ltr" role="img">${svg}</svg><div class="chart-tip hidden"></div></div>`;
  const tip = el.querySelector('.chart-tip');
  const wrap = el.querySelector('.chart');
  el.querySelectorAll('.hit').forEach((r) => {
    r.addEventListener('mousemove', (e) => {
      const i = Number(r.dataset.i);
      tip.innerHTML = `<b>${esc(tipTitle(i))}</b>${series.map((se) => `<div>${series.length > 1 ? `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-inline-end:6px;background:var(${se.cls === 's2' ? '--series-2' : '--accent'})"></i>${esc(se.name)}: ` : ''}${fmt(se.values[i] || 0)}</div>`).join('')}`;
      tip.classList.remove('hidden');
      const b = wrap.getBoundingClientRect();
      const x = e.clientX - b.left;
      tip.style.left = Math.min(b.width - tip.offsetWidth - 4, Math.max(4, x + 12)) + 'px';
      tip.style.top = Math.max(0, e.clientY - b.top - tip.offsetHeight - 10) + 'px';
    });
    r.addEventListener('mouseleave', () => tip.classList.add('hidden'));
  });
}
function barPath(x, y, w, h, r) {
  if (h <= 0) return '';
  r = Math.min(r, h);
  const b = y + h;
  return `M${x},${b}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${b}Z`;
}
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
const compact = (v) => (v >= 1000 ? (Math.round(v / 100) / 10) + 'k' : String(Math.round(v * 10) / 10));

/* ---------- Horizontal bar list ---------- */
function hbars(rows, fmt) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows.map((r) => `<div class="hbar"><span title="${esc(r.label)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.label)}</span>
    <div class="track"><div class="fill" style="width:${(r.value / max) * 100}%"></div></div><b class="num">${fmt(r.value)}</b></div>`).join('') || `<div class="empty">${t('no_records')}</div>`;
}

function presets() {
  const d = new Date();
  const today = dayKey(d);
  const y = new Date(d); y.setDate(d.getDate() - 1);
  const w = new Date(d); w.setDate(d.getDate() - 6);
  const m1 = new Date(d.getFullYear(), d.getMonth(), 1);
  const lm1 = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const lm2 = new Date(d.getFullYear(), d.getMonth(), 0);
  return {
    today: [today, today], yesterday: [dayKey(y), dayKey(y)], week: [dayKey(w), today],
    month: [dayKey(m1), today], last_month: [dayKey(lm1), dayKey(lm2)],
  };
}

export async function render(root) {
  let [from, to] = presets().today;
  let preset = 'today';

  async function draw() {
    const r = await get(`/reports/summary?from=${from}&to=${to}`);
    const k = r.kpis;
    const multiDay = r.daily.length > 1;
    const kpi = (label, value, sub = '', cls = '') => `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
    root.innerHTML = `<div class="page-head"><h1>${t('nav.reports')}</h1><span class="spacer"></span>
        <div class="seg">${Object.keys(presets()).map((p) => `<button data-p="${p}" class="${p === preset ? 'on' : ''}">${t('range.' + p)}</button>`).join('')}</div>
        <label class="row small">${t('from')} <input type="date" data-from value="${from}" style="width:auto"></label>
        <label class="row small">${t('to')} <input type="date" data-to value="${to}" style="width:auto"></label>
        <a class="btn btn-primary" href="/api/reports/export?from=${from}&to=${to}&lang=${lang()}">${icon('download')} ${t('export_excel')}</a></div>
      ${r.low_stock.length ? `<div class="banner warn">${icon('alert')} <b>${t('low_stock')}:</b> ${r.low_stock.map((p) => `${esc(p.name)} (<span class="num">${p.stock}</span>)`).join('، ')}</div>` : ''}
      <div class="kpis">
        ${kpi(t('total_revenue'), money(k.revenue), `${k.sessions} ${t('sessions')} · ${k.sales} ${t('sales')}`)}
        ${kpi(t('playtime_revenue'), money(k.time_revenue))}
        ${kpi(t('products_revenue'), money(k.items_revenue), `${t('profit')}: ${moneyText(k.items_profit)}`)}
        ${kpi(t('expenses'), money(k.expenses), k.waste ? `${t('waste')}: ${moneyText(k.waste)}` : '')}
        ${kpi(t('net_profit'), money(k.net_profit), t('net_profit_hint'), k.net_profit < 0 ? 'neg' : 'pos')}
        ${kpi(t('collected'), money(k.collected), `${t('refunds')}: ${moneyText(k.refunds)}`)}
        ${kpi(t('discounts'), money(k.discounts))}
        ${kpi(t('outstanding_debts'), money(k.outstanding_debts), `${t('new_credit')}: ${moneyText(k.unpaid)}`)}
      </div>
      ${multiDay ? `<div class="card"><div class="card-head"><h2>${t('daily_revenue')}</h2><span class="spacer"></span>
        <div class="legend"><span><i style="background:var(--accent)"></i>${t('playtime')}</span><span><i style="background:var(--series-2)"></i>${t('products')}</span></div></div>
        <div data-daily></div>
        <details><summary class="muted small">${t('show_table')}</summary><div class="table-wrap"><table><thead><tr><th>${t('date')}</th><th class="n">${t('sessions')}</th><th class="n">${t('playtime')}</th><th class="n">${t('products')}</th><th class="n">${t('discounts')}</th><th class="n">${t('revenue')}</th><th class="n">${t('expenses')}</th><th class="n">${t('net')}</th></tr></thead>
        <tbody>${r.daily.map((d) => `<tr><td class="num">${d.date}</td><td class="n num">${d.sessions}</td><td class="n num">${d.time_revenue}</td><td class="n num">${d.items_revenue}</td><td class="n num">${d.discounts}</td><td class="n num">${d.revenue}</td><td class="n num">${d.expenses}</td><td class="n num">${d.net}</td></tr>`).join('')}</tbody></table></div></details></div>` : ''}
      <div class="grid grid-2">
        <div class="card"><div class="card-head"><h2>${t('busy_hours')}</h2><span class="muted small">${t('busy_hours_hint')}</span></div><div data-hours></div>
          <details><summary class="muted small">${t('show_table')}</summary><div class="table-wrap"><table><thead><tr><th>${t('hour')}</th><th class="n">${t('hours_played')}</th><th class="n">${t('sessions_started')}</th></tr></thead>
          <tbody>${r.hours.filter((x) => x.minutes || x.starts).map((x) => `<tr><td class="num">${pad(x.hour)}:00</td><td class="n num">${Math.round(x.minutes / 6) / 10}</td><td class="n num">${x.starts}</td></tr>`).join('') || `<tr><td colspan="3" class="empty">${t('no_records')}</td></tr>`}</tbody></table></div></details></div>
        <div class="card"><div class="card-head"><h2>${t('console_usage')}</h2></div>
          ${hbars(r.consoles.map((c) => ({ label: c.name, value: Math.round(c.minutes / 6) / 10 })), (v) => `${v} ${t('hr')}`)}
          <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>${t('console')}</th><th class="n">${t('sessions')}</th><th class="n">${t('hours_played')}</th><th class="n">${t('revenue')}</th><th class="n">${t('utilization')}</th></tr></thead>
          <tbody>${r.consoles.map((c) => `<tr><td>${esc(c.name)} <span class="muted small">${esc(c.type)} · ${esc(c.room || t('main_hall'))}</span></td><td class="n num">${c.sessions}</td><td class="n">${fmtMinutes(c.minutes)}</td><td class="n num">${c.revenue}</td><td class="n num">${c.utilization}%</td></tr>`).join('') || `<tr><td colspan="5" class="empty">${t('no_records')}</td></tr>`}</tbody></table></div></div>
        ${r.rooms.length > 1 || (r.rooms[0] && r.rooms[0].room) ? `<div class="card"><div class="card-head"><h2>🚪 ${t('rooms')}</h2></div>
          ${hbars(r.rooms.map((x) => ({ label: x.room || t('main_hall'), value: x.revenue })), (v) => moneyText(v))}
          <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>${t('room')}</th><th class="n">${t('consoles')}</th><th class="n">${t('sessions')}</th><th class="n">${t('hours_played')}</th><th class="n">${t('revenue')}</th></tr></thead>
          <tbody>${r.rooms.map((x) => `<tr><td>${esc(x.room || t('main_hall'))}</td><td class="n num">${x.consoles}</td><td class="n num">${x.sessions}</td><td class="n">${fmtMinutes(x.minutes)}</td><td class="n num">${x.revenue}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
        <div class="card"><div class="card-head"><h2>${t('top_products')}</h2></div><div class="table-wrap"><table>
          <thead><tr><th>${t('product')}</th><th class="n">${t('qty')}</th><th class="n">${t('sales')}</th><th class="n">${t('cost')}</th><th class="n">${t('profit')}</th></tr></thead>
          <tbody>${r.products.map((p) => `<tr><td>${esc(p.name)}</td><td class="n num">${p.qty}</td><td class="n num">${p.revenue}</td><td class="n num">${p.cost}</td><td class="n num"><b>${p.profit}</b></td></tr>`).join('') || `<tr><td colspan="5" class="empty">${t('no_records')}</td></tr>`}</tbody></table></div></div>
        <div class="card"><div class="card-head"><h2>${t('expenses_by_category')}</h2></div>
          ${hbars(Object.entries(r.expenses_by_category).map(([c, v]) => ({ label: t('exp.' + c), value: v })).sort((a, b) => b.value - a.value), (v) => moneyText(v))}
          <h3 style="margin:14px 0 6px">${t('by_method')}</h3>
          ${Object.entries(r.methods).map(([m, v]) => `<div class="row" style="justify-content:space-between"><span>${t('method.' + m)}</span><b>${moneyText(v)}</b></div>`).join('') || `<div class="muted">${t('no_records')}</div>`}</div>
        <div class="card"><div class="card-head"><h2>${t('by_cashier')}</h2></div><div class="table-wrap"><table>
          <thead><tr><th>${t('cashier')}</th><th class="n">${t('invoices_count')}</th><th class="n">${t('revenue')}</th><th class="n">${t('discounts')}</th><th class="n">${t('collected')}</th><th class="n">${t('refunds')}</th></tr></thead>
          <tbody>${r.cashiers.map((c) => `<tr><td>${esc(c.name)}</td><td class="n num">${c.invoices}</td><td class="n num">${c.revenue}</td><td class="n num">${c.discounts}</td><td class="n num">${c.collected}</td><td class="n num">${c.refunds}</td></tr>`).join('') || `<tr><td colspan="6" class="empty">${t('no_records')}</td></tr>`}</tbody></table></div></div>
      </div>`;

    if (multiDay) {
      columnChart(root.querySelector('[data-daily]'), {
        labels: r.daily.map((d) => d.date.slice(5)),
        series: [{ name: t('playtime'), values: r.daily.map((d) => d.time_revenue) }, { name: t('products'), values: r.daily.map((d) => d.items_revenue), cls: 's2' }],
        fmt: (v) => moneyText(v), tipTitle: (i) => r.daily[i].date,
      });
    }
    columnChart(root.querySelector('[data-hours]'), {
      labels: r.hours.map((x) => pad(x.hour)),
      series: [{ name: t('hours_played'), values: r.hours.map((x) => Math.round(x.minutes / 6) / 10) }],
      fmt: (v) => `${v} ${t('hr')}`, tipTitle: (i) => `${pad(i)}:00 – ${pad((i + 1) % 24)}:00 · ${r.hours[i].starts} ${t('sessions_started')}`,
    });

    root.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { preset = b.dataset.p; [from, to] = presets()[preset]; draw(); }));
    const custom = () => { preset = ''; from = root.querySelector('[data-from]').value || dayKey(); to = root.querySelector('[data-to]').value || from; draw(); };
    root.querySelectorAll('[data-from],[data-to]').forEach((e) => e.addEventListener('change', custom));
  }
  await draw();
}
