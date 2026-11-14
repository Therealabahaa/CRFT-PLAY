const express = require('express');
const ExcelJS = require('exceljs');
const { db, money, settings } = require('../db');
const { h, range } = require('../util');
const { requirePerm } = require('../auth');

const r = express.Router();
r.use(requirePerm('reports'));

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function buildReport(from, to) {
  const now = Date.now();
  const invoices = db.prepare(`SELECT i.*, u.name user_name FROM invoices i LEFT JOIN users u ON u.id = i.user_id
    WHERE i.status = 'closed' AND i.closed_at BETWEEN ? AND ?`).all(from, to);
  const expenses = db.prepare('SELECT * FROM expenses WHERE spent_at BETWEEN ? AND ?').all(from, to);
  const payments = db.prepare(`SELECT p.*, u.name user_name FROM payments p LEFT JOIN users u ON u.id = p.user_id WHERE p.created_at BETWEEN ? AND ?`).all(from, to);
  const waste = db.prepare("SELECT COALESCE(SUM(-qty*COALESCE(unit_cost,0)),0) s FROM stock_movements WHERE type = 'waste' AND created_at BETWEEN ? AND ?").get(from, to).s;
  // shelf counts: negative = stock missing (a loss), positive = found more than expected
  const countDiff = db.prepare("SELECT COALESCE(SUM(qty*COALESCE(unit_cost,0)),0) s FROM stock_movements WHERE type = 'count' AND created_at BETWEEN ? AND ?").get(from, to).s;
  const purchases = db.prepare("SELECT COALESCE(SUM(qty*COALESCE(unit_cost,0)),0) s FROM stock_movements WHERE type = 'purchase' AND created_at BETWEEN ? AND ?").get(from, to).s;

  // ---- KPIs
  const k = { time_revenue: 0, items_revenue: 0, items_cost: 0, discounts: 0, revenue: 0, unpaid: 0, sessions: 0, sales: 0 };
  for (const i of invoices) {
    k.time_revenue += i.time_amount;
    k.items_revenue += i.items_amount;
    k.items_cost += i.items_cost;
    k.discounts += i.discount;
    k.revenue += i.total;
    k.unpaid += i.total - i.paid;
    if (i.kind === 'session') k.sessions++; else k.sales++;
  }
  const opExpenses = expenses.filter((e) => e.category !== 'stock');
  k.expenses = opExpenses.reduce((a, e) => a + e.amount, 0);
  k.waste = waste;
  k.stock_purchases = purchases;
  k.items_profit = k.items_revenue - k.items_cost;
  k.gross_profit = k.revenue - k.items_cost;
  k.count_diff = countDiff;
  k.net_profit = k.gross_profit - k.expenses - k.waste + k.count_diff;
  k.collected = payments.reduce((a, p) => a + p.amount, 0);
  k.refunds = -payments.filter((p) => p.kind === 'refund').reduce((a, p) => a + p.amount, 0);
  k.debt_collected = payments.filter((p) => p.kind === 'debt').reduce((a, p) => a + p.amount, 0);
  k.outstanding_debts = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM customer_ledger').get().s;
  for (const key of Object.keys(k)) if (!['sessions', 'sales'].includes(key)) k[key] = money(k[key]);

  // ---- Daily
  const days = {};
  for (let t = from; t <= to; t += 86400000) days[dayKey(t)] = { date: dayKey(t), time_revenue: 0, items_revenue: 0, discounts: 0, revenue: 0, items_cost: 0, expenses: 0, net: 0, sessions: 0 };
  days[dayKey(to)] = days[dayKey(to)] || { date: dayKey(to), time_revenue: 0, items_revenue: 0, discounts: 0, revenue: 0, items_cost: 0, expenses: 0, net: 0, sessions: 0 };
  for (const i of invoices) {
    const d = days[dayKey(i.closed_at)];
    if (!d) continue;
    d.time_revenue += i.time_amount; d.items_revenue += i.items_amount; d.discounts += i.discount;
    d.revenue += i.total; d.items_cost += i.items_cost; if (i.kind === 'session') d.sessions++;
  }
  for (const e of opExpenses) { const d = days[dayKey(e.spent_at)]; if (d) d.expenses += e.amount; }
  const daily = Object.values(days).sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
    for (const key of ['time_revenue', 'items_revenue', 'discounts', 'revenue', 'items_cost', 'expenses']) d[key] = money(d[key]);
    d.net = money(d.revenue - d.items_cost - d.expenses);
    return d;
  });

  // ---- Consoles & busy hours (from played segments, clipped to the range)
  const consoles = db.prepare('SELECT c.id, c.name, c.type, r.name room FROM consoles c LEFT JOIN rooms r ON r.id = c.room_id').all();
  const cmap = Object.fromEntries(consoles.map((c) => [c.id, { ...c, sessions: 0, minutes: 0, revenue: 0 }]));
  const hours = Array.from({ length: 24 }, (_, hr) => ({ hour: hr, minutes: 0, starts: 0 }));
  const segs = db.prepare(`SELECT g.* FROM session_segments g JOIN sessions s ON s.id = g.session_id
    JOIN invoices i ON i.id = s.invoice_id WHERE i.status != 'void' AND g.start_at <= ? AND COALESCE(g.end_at, ?) >= ?`).all(to, now, from);
  for (const g of segs) {
    let a = Math.max(g.start_at, from);
    const b = Math.min(g.end_at || now, to);
    if (b <= a) continue;
    if (cmap[g.console_id]) cmap[g.console_id].minutes += (b - a) / 60000;
    while (a < b) {
      const d = new Date(a);
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
      const end = Math.min(next, b);
      hours[d.getHours()].minutes += (end - a) / 60000;
      a = end;
    }
  }
  for (const s of db.prepare(`SELECT s.console_id, s.started_at, i.time_amount FROM sessions s JOIN invoices i ON i.id = s.invoice_id
    WHERE i.status = 'closed' AND i.closed_at BETWEEN ? AND ?`).all(from, to)) {
    if (cmap[s.console_id]) { cmap[s.console_id].sessions++; cmap[s.console_id].revenue += s.time_amount; }
    hours[new Date(s.started_at).getHours()].starts++;
  }
  const spanMinutes = (Math.min(to, now) - from) / 60000;
  const consoleRows = Object.values(cmap).filter((c) => c.sessions || c.minutes)
    .map((c) => ({ ...c, minutes: Math.round(c.minutes), revenue: money(c.revenue), utilization: spanMinutes > 0 ? Math.min(100, Math.round((c.minutes / spanMinutes) * 1000) / 10) : 0 }))
    .sort((a, b) => b.minutes - a.minutes);
  for (const hr of hours) hr.minutes = Math.round(hr.minutes);
  // per room (consoles not in a room count as the main hall)
  const roomMap = {};
  for (const c of consoleRows) {
    const k = c.room || '';
    const x = (roomMap[k] = roomMap[k] || { room: c.room || null, consoles: 0, sessions: 0, minutes: 0, revenue: 0 });
    x.consoles++; x.sessions += c.sessions; x.minutes += c.minutes; x.revenue = money(x.revenue + c.revenue);
  }
  const roomRows = Object.values(roomMap).sort((a, b) => b.revenue - a.revenue);

  // ---- Products
  const products = db.prepare(`SELECT it.product_id, it.name, SUM(it.qty) qty, SUM(it.qty*it.price) revenue, SUM(it.qty*it.cost) cost
    FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id WHERE i.status = 'closed' AND i.closed_at BETWEEN ? AND ?
    GROUP BY it.product_id, it.name ORDER BY revenue DESC`).all(from, to)
    .map((p) => ({ ...p, revenue: money(p.revenue), cost: money(p.cost), profit: money(p.revenue - p.cost) }));

  // ---- Cashiers
  const cashiers = {};
  const cashier = (id, name) => (cashiers[id] = cashiers[id] || { user_id: id, name: name || '-', invoices: 0, revenue: 0, discounts: 0, collected: 0, refunds: 0 });
  for (const i of invoices) { const c = cashier(i.user_id, i.user_name); c.invoices++; c.revenue += i.total; c.discounts += i.discount; }
  for (const p of payments) { const c = cashier(p.user_id, p.user_name); if (p.kind === 'refund') c.refunds -= p.amount; else c.collected += p.amount; }
  const cashierRows = Object.values(cashiers).map((c) => ({ ...c, revenue: money(c.revenue), discounts: money(c.discounts), collected: money(c.collected), refunds: money(c.refunds) }));

  // ---- Expenses by category & payment methods
  const expCats = {};
  for (const e of expenses) expCats[e.category] = money((expCats[e.category] || 0) + e.amount);
  const methods = {};
  for (const p of payments) methods[p.method] = money((methods[p.method] || 0) + p.amount);

  return { from, to, kpis: k, daily, hours, consoles: consoleRows, rooms: roomRows, products, cashiers: cashierRows, expenses_by_category: expCats, methods, invoices, expenses, payments };
}

r.get('/reports/summary', h((req, res) => {
  const { from, to } = range(req.query);
  const rep = buildReport(from, to);
  delete rep.invoices; delete rep.payments; delete rep.expenses;
  rep.low_stock = db.prepare('SELECT * FROM products WHERE active = 1 AND stock <= low_stock ORDER BY stock').all();
  res.json(rep);
}));

r.get('/reports/export', h(async (req, res) => {
  const { from, to } = range(req.query);
  const rep = buildReport(from, to);
  const ar = req.query.lang !== 'en';
  const L = (a, e) => (ar ? a : e);
  const wb = new ExcelJS.Workbook();
  wb.creator = settings().shop_name;
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('en-GB') : '');

  const sheet = (name, columns, rows) => {
    const ws = wb.addWorksheet(name, { views: [{ rightToLeft: ar, state: 'frozen', ySplit: 1 }] });
    ws.columns = columns.map(([key, header, width]) => ({ key, header, width: width || 16 }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE1E0D9' } };
    rows.forEach((row) => ws.addRow(row));
    return ws;
  };

  const k = rep.kpis;
  sheet(L('الملخص', 'Summary'), [['label', L('البند', 'Item'), 34], ['value', L('القيمة', 'Value'), 18]], [
    { label: L('من', 'From'), value: dayKey(from) }, { label: L('إلى', 'To'), value: dayKey(to) },
    { label: L('إيراد الوقت (بلايستيشن)', 'PlayStation time revenue'), value: k.time_revenue },
    { label: L('إيراد المنتجات', 'Product revenue'), value: k.items_revenue },
    { label: L('الخصومات', 'Discounts'), value: k.discounts },
    { label: L('إجمالي الإيراد', 'Total revenue'), value: k.revenue },
    { label: L('تكلفة المنتجات المباعة', 'Cost of products sold'), value: k.items_cost },
    { label: L('ربح المنتجات', 'Product profit'), value: k.items_profit },
    { label: L('المصروفات', 'Expenses'), value: k.expenses },
    { label: L('الهالك', 'Waste'), value: k.waste },
    { label: L('فروق الجرد (+ زيادة / − عجز)', 'Stock count differences (+ found / − missing)'), value: k.count_diff },
    { label: L('صافي الربح', 'Net profit'), value: k.net_profit },
    { label: L('المحصّل', 'Collected'), value: k.collected },
    { label: L('المرتجعات', 'Refunds'), value: k.refunds },
    { label: L('آجل غير مدفوع', 'Unpaid (on credit)'), value: k.unpaid },
    { label: L('إجمالي ديون العملاء الحالية', 'Outstanding customer debts'), value: k.outstanding_debts },
    { label: L('مشتريات البضاعة', 'Stock purchases'), value: k.stock_purchases },
    { label: L('عدد الجلسات', 'Sessions'), value: k.sessions },
    { label: L('عدد المبيعات', 'Quick sales'), value: k.sales },
  ]);
  sheet(L('يومي', 'Daily'), [['date', L('التاريخ', 'Date'), 14], ['sessions', L('جلسات', 'Sessions')], ['time_revenue', L('إيراد الوقت', 'Time revenue')],
    ['items_revenue', L('إيراد المنتجات', 'Products')], ['discounts', L('خصومات', 'Discounts')], ['revenue', L('الإيراد', 'Revenue')],
    ['items_cost', L('تكلفة المنتجات', 'Product cost')], ['expenses', L('مصروفات', 'Expenses')], ['net', L('الصافي', 'Net')]], rep.daily);
  sheet(L('الأجهزة', 'Consoles'), [['name', L('الجهاز', 'Console'), 20], ['type', L('النوع', 'Type')], ['room', L('الغرفة', 'Room')], ['sessions', L('جلسات', 'Sessions')],
    ['hours', L('ساعات اللعب', 'Hours played')], ['revenue', L('الإيراد', 'Revenue')], ['utilization', L('نسبة الإشغال %', 'Utilization %')]],
    rep.consoles.map((c) => ({ ...c, room: c.room || L('الصالة', 'Main hall'), hours: Math.round((c.minutes / 60) * 10) / 10 })));
  sheet(L('الغرف', 'Rooms'), [['room', L('الغرفة', 'Room'), 20], ['consoles', L('الأجهزة', 'Consoles')], ['sessions', L('جلسات', 'Sessions')], ['hours', L('ساعات اللعب', 'Hours played')], ['revenue', L('الإيراد', 'Revenue')]],
    rep.rooms.map((x) => ({ ...x, room: x.room || L('الصالة', 'Main hall'), hours: Math.round((x.minutes / 60) * 10) / 10 })));
  sheet(L('ساعات الذروة', 'Busy hours'), [['hour', L('الساعة', 'Hour')], ['hours', L('ساعات اللعب', 'Hours played')], ['starts', L('جلسات بدأت', 'Sessions started')]],
    rep.hours.map((x) => ({ hour: `${pad(x.hour)}:00`, hours: Math.round((x.minutes / 60) * 10) / 10, starts: x.starts })));
  sheet(L('المنتجات', 'Products'), [['name', L('المنتج', 'Product'), 24], ['qty', L('الكمية', 'Qty')], ['revenue', L('المبيعات', 'Revenue')], ['cost', L('التكلفة', 'Cost')], ['profit', L('الربح', 'Profit')]], rep.products);
  sheet(L('الكاشير', 'Cashiers'), [['name', L('الموظف', 'Employee'), 20], ['invoices', L('فواتير', 'Invoices')], ['revenue', L('الإيراد', 'Revenue')], ['discounts', L('خصومات', 'Discounts')], ['collected', L('المحصّل', 'Collected')], ['refunds', L('مرتجعات', 'Refunds')]], rep.cashiers);
  sheet(L('المصروفات', 'Expenses'), [['date', L('التاريخ', 'Date'), 20], ['category', L('البند', 'Category')], ['amount', L('المبلغ', 'Amount')], ['from_drawer', L('من الدرج', 'From drawer')], ['note', L('ملاحظة', 'Note'), 30]],
    rep.expenses.map((e) => ({ ...e, date: fmtTime(e.spent_at), from_drawer: e.from_drawer ? '✓' : '' })));
  sheet(L('الفواتير', 'Invoices'), [['id', '#', 8], ['kind', L('النوع', 'Kind')], ['closed', L('الوقت', 'Time'), 20], ['user_name', L('الكاشير', 'Cashier')], ['time_amount', L('الوقت', 'Time')],
    ['items_amount', L('منتجات', 'Products')], ['discount', L('خصم', 'Discount')], ['total', L('الإجمالي', 'Total')], ['paid', L('المدفوع', 'Paid')]],
    rep.invoices.map((i) => ({ ...i, closed: fmtTime(i.closed_at) })));
  sheet(L('المدفوعات', 'Payments'), [['id', '#', 8], ['created', L('الوقت', 'Time'), 20], ['kind', L('النوع', 'Kind')], ['method', L('الطريقة', 'Method')], ['amount', L('المبلغ', 'Amount')], ['user_name', L('الكاشير', 'Cashier')], ['invoice_id', L('فاتورة', 'Invoice')]],
    rep.payments.map((p) => ({ ...p, created: fmtTime(p.created_at) })));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="report-${dayKey(from)}_${dayKey(to)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

module.exports = r;
module.exports.buildReport = buildReport;
