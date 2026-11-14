const express = require('express');
const { db, tx, money, audit } = require('../db');
const { h, bad, notFound, forbidden, requireShift, currentShift, int, num, str, range } = require('../util');
const { requirePerm, can } = require('../auth');
const billing = require('../billing');
const tg = require('../telegram');

const r = express.Router();

/* ---------- Quick sale (products without a session) ---------- */
r.post('/sales', h((req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.items) || !b.items.length) throw bad('empty_sale');
  const inv = tx(() => {
    const shift = requireShift();
    const ins = db.prepare("INSERT INTO invoices(kind, customer_id, shift_id, user_id, created_at) VALUES('sale', ?, ?, ?, ?)")
      .run(int(b.customer_id, null), shift.id, req.user.id, Date.now());
    const id = Number(ins.lastInsertRowid);
    billing.addItems(id, b.items, req.user);
    return billing.settle(id, { discount: b.discount, payments: b.payments, customer_id: int(b.customer_id, null), note: str(b.note) }, req.user, shift);
  });
  res.json(billing.invoiceDetail(inv.id));
}));

/* ---------- Invoices ---------- */
r.get('/invoices', h((req, res) => {
  const { from, to } = range(req.query);
  const where = ['i.status != \'open\'', 'COALESCE(i.closed_at, i.created_at) BETWEEN ? AND ?'];
  const args = [from, to];
  if (req.query.kind) { where.push('i.kind = ?'); args.push(req.query.kind); }
  if (req.query.customer_id) { where.push('i.customer_id = ?'); args.push(int(req.query.customer_id)); }
  if (!can(req.user, 'reports')) { where.push('i.user_id = ?'); args.push(req.user.id); }
  res.json(db.prepare(`SELECT i.*, u.name user_name, c.name customer_name, k.name console_name
    FROM invoices i LEFT JOIN users u ON u.id = i.user_id LEFT JOIN customers c ON c.id = i.customer_id
    LEFT JOIN sessions s ON s.id = i.session_id LEFT JOIN consoles k ON k.id = s.console_id
    WHERE ${where.join(' AND ')} ORDER BY i.id DESC LIMIT 1000`).all(...args));
}));

// Cashiers without "reports" see only their own invoices and the ones on the shift that is open now
// (same rule as the invoice list); everyone else sees all.
r.get('/invoices/:id', h((req, res) => {
  const inv = billing.invoiceDetail(int(req.params.id));
  if (!can(req.user, 'reports')) {
    const shift = currentShift();
    if (inv.user_id !== req.user.id && !(shift && inv.shift_id === shift.id)) throw forbidden();
  }
  res.json(inv);
}));

// Edit a paid invoice (forgotten drink, wrong quantity…). Anyone may fix an invoice from the shift that is open now;
// older invoices need the "refunds" permission. The difference is paid / given back on the current shift.
r.post('/invoices/:id/edit', h((req, res) => {
  const id = int(req.params.id);
  const b = req.body || {};
  const result = tx(() => {
    const shift = requireShift();
    const inv = billing.getInvoice(id);
    if (!can(req.user, 'refund') && inv.shift_id !== shift.id) throw forbidden('edit_old_invoice');
    return billing.editInvoice(id, { items: b.items, method: b.method, customer_id: int(b.customer_id, null), reason: str(b.reason) }, req.user, shift);
  });
  res.json(result);
}));

r.post('/invoices/:id/refund', requirePerm('refund'), h((req, res) => {
  const b = req.body || {};
  if (!str(b.reason)) throw bad('reason_required');
  tx(() => billing.refund(int(req.params.id), { reason: str(b.reason), method: b.method || 'cash', restock: b.restock !== false }, req.user, requireShift()));
  res.json(billing.invoiceDetail(int(req.params.id)));
}));

/* ---------- Shifts ---------- */
function shiftSummary(shift) {
  const pays = db.prepare(`SELECT kind, method, COUNT(*) n, COALESCE(SUM(amount),0) total FROM payments WHERE shift_id = ? GROUP BY kind, method`).all(shift.id);
  const drawerOut = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE shift_id = ? AND from_drawer = 1').get(shift.id).s;
  const byMethod = {};
  let cashIn = 0;
  for (const p of pays) {
    byMethod[p.method] = money((byMethod[p.method] || 0) + p.total);
    if (p.method === 'cash') cashIn += p.total;
  }
  const inv = db.prepare(`SELECT kind, COUNT(*) n, COALESCE(SUM(time_amount),0) time_amount, COALESCE(SUM(items_amount),0) items_amount,
    COALESCE(SUM(discount),0) discount, COALESCE(SUM(total),0) total, COALESCE(SUM(paid),0) paid
    FROM invoices WHERE shift_id = ? AND status = 'closed' GROUP BY kind`).all(shift.id);
  const refunds = db.prepare("SELECT COALESCE(SUM(-amount),0) s, COUNT(*) n FROM payments WHERE shift_id = ? AND kind = 'refund'").get(shift.id);
  const cashRefunds = db.prepare("SELECT COALESCE(SUM(-amount),0) s FROM payments WHERE shift_id = ? AND kind = 'refund' AND method = 'cash'").get(shift.id).s;
  const debtPaid = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE shift_id = ? AND kind = 'debt'").get(shift.id).s;
  const sessions = inv.find((x) => x.kind === 'session') || { n: 0, total: 0, time_amount: 0, items_amount: 0, discount: 0, paid: 0 };
  const sales = inv.find((x) => x.kind === 'sale') || { n: 0, total: 0, items_amount: 0, discount: 0, paid: 0 };
  const revenue = money(sessions.total + sales.total);
  const collected = money(Object.values(byMethod).reduce((a, b) => a + b, 0));
  // cash put in / taken out of the drawer that isn't a sale (change added, owner took money…)
  const moves = db.prepare('SELECT m.*, u.name user_name FROM cash_moves m LEFT JOIN users u ON u.id = m.user_id WHERE shift_id = ? ORDER BY m.id').all(shift.id);
  const movesIn = moves.filter((m) => m.amount > 0).reduce((a, m) => a + m.amount, 0);
  const movesOut = moves.filter((m) => m.amount < 0).reduce((a, m) => a - m.amount, 0);
  const expected = money(shift.opening_cash + cashIn - drawerOut + movesIn - movesOut);
  const card = money(byMethod.card || 0);
  const online = money(billing.ONLINE.reduce((a, m) => a + (byMethod[m] || 0), 0));
  const end = shift.closed_at || Date.now();
  const top = db.prepare(`SELECT it.name, SUM(it.qty) qty, SUM(it.qty*it.price) amount FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
    WHERE i.shift_id = ? AND i.status = 'closed' GROUP BY it.name ORDER BY qty DESC LIMIT 8`).all(shift.id);
  const waste = db.prepare(`SELECT p.name, -m.qty qty, m.note, m.created_at FROM stock_movements m JOIN products p ON p.id = m.product_id
    WHERE m.type = 'waste' AND m.created_at BETWEEN ? AND ? ORDER BY m.id`).all(shift.opened_at, end);
  const user = db.prepare('SELECT name FROM users WHERE id = ?').get(shift.user_id);
  const closer = shift.closed_by ? db.prepare('SELECT name FROM users WHERE id = ?').get(shift.closed_by) : null;
  return {
    hours: Math.round(((end - shift.opened_at) / 3600000) * 10) / 10,
    moves,
    moves_in: money(movesIn),
    moves_out: money(movesOut),
    top,
    waste,
    card_total: card,
    online_total: online,
    ...shift,
    user_name: user?.name,
    closed_by_name: closer?.name,
    sessions_count: sessions.n,
    sales_count: sales.n,
    time_revenue: money(sessions.time_amount),
    items_revenue: money(sessions.items_amount + sales.items_amount),
    discounts: money(sessions.discount + sales.discount),
    revenue,
    collected,
    by_method: byMethod,
    unpaid: money(revenue - sessions.paid - sales.paid),
    debt_collected: money(debtPaid),
    refunds: money(refunds.s),
    refunds_count: refunds.n,
    drawer_expenses: money(drawerOut),
    cash_in: money(cashIn),
    cash_received: money(cashIn + cashRefunds),
    cash_refunds: money(cashRefunds),
    expected_cash: shift.closed_at ? shift.expected_cash : expected,
    expected_card: shift.closed_at && shift.expected_card != null ? shift.expected_card : card,
    expected_online: shift.closed_at && shift.expected_online != null ? shift.expected_online : online,
  };
}

// Cash in / out of the drawer during the shift (Kur): + change added, − money taken out (not an expense).
r.post('/shifts/move', h((req, res) => {
  const b = req.body || {};
  const amount = money(b.amount);
  if (!(amount > 0)) throw bad('invalid_amount');
  const reason = str(b.reason);
  if (!reason) throw bad('reason_required');
  const signed = b.type === 'in' ? amount : -amount;
  const shift = tx(() => {
    const s = requireShift();
    db.prepare('INSERT INTO cash_moves(shift_id, amount, reason, user_id, created_at) VALUES(?,?,?,?,?)').run(s.id, signed, reason, req.user.id, Date.now());
    audit(req.user.id, 'shift.cash_move', { shift: s.id, amount: signed, reason });
    return s;
  });
  tg.notify('important', `${signed > 0 ? '➕ إضافة للدرج' : '➖ سحب من الدرج'}: ${tg.egp(amount)} — ${reason} — بواسطة ${req.user.name}`);
  res.json(shiftSummary(db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id)));
}));

r.get('/shifts/current', h((req, res) => {
  const s = currentShift();
  res.json(s ? shiftSummary(s) : null);
}));

r.post('/shifts/open', h((req, res) => {
  const opening = money(req.body.opening_cash);
  if (opening < 0) throw bad('invalid_amount');
  const s = tx(() => {
    if (currentShift()) throw bad('shift_already_open');
    const ins = db.prepare('INSERT INTO shifts(user_id, opened_at, opening_cash, notes) VALUES(?,?,?,?)').run(req.user.id, Date.now(), opening, str(req.body.notes));
    audit(req.user.id, 'shift.open', { shift: Number(ins.lastInsertRowid), opening_cash: opening });
    tg.notify('important', `▶️ بدأت الوردية #${Number(ins.lastInsertRowid)} — ${req.user.name}\nرصيد الدرج: ${tg.egp(opening)}`);
    return db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(ins.lastInsertRowid));
  });
  res.json(shiftSummary(s));
}));

// End the shift (Kur): count the cash drawer, the card machine's total and the online payments received.
// A box left empty means "not counted" (no difference is recorded for it).
r.post('/shifts/close', h((req, res) => {
  const b = req.body || {};
  const read = (v) => {
    if (v === '' || v == null) return null;
    const n = money(v);
    if (!(n >= 0)) throw bad('invalid_amount');
    return n;
  };
  const counted = read(b.counted_cash);
  const countedCard = read(b.counted_card);
  const countedOnline = read(b.counted_online);
  const id = tx(() => {
    const s = currentShift();
    if (!s) throw bad('no_open_shift');
    if (s.user_id !== req.user.id && req.user.role !== 'admin') throw forbidden('not_your_shift');
    const sum = shiftSummary(s);
    const diff = counted == null ? null : money(counted - sum.expected_cash);
    const cardDiff = countedCard == null ? null : money(countedCard - sum.expected_card);
    const onlineDiff = countedOnline == null ? null : money(countedOnline - sum.expected_online);
    db.prepare(`UPDATE shifts SET closed_at = ?, closed_by = ?, expected_cash = ?, counted_cash = ?, difference = ?,
        expected_card = ?, counted_card = ?, card_difference = ?, expected_online = ?, counted_online = ?, online_difference = ?, notes = COALESCE(?, notes) WHERE id = ?`)
      .run(Date.now(), req.user.id, sum.expected_cash, counted, diff, sum.expected_card, countedCard, cardDiff, sum.expected_online, countedOnline, onlineDiff, str(b.notes), s.id);
    audit(req.user.id, 'shift.close', { shift: s.id, expected: sum.expected_cash, counted, difference: diff, card_difference: cardDiff, online_difference: onlineDiff });
    return s.id;
  });
  const closed = shiftSummary(db.prepare('SELECT * FROM shifts WHERE id = ?').get(id));
  tg.notifyShiftClosed(closed);
  res.json(closed);
}));

r.get('/shifts', h((req, res) => {
  const { from, to } = range(req.query);
  const mine = !can(req.user, 'reports');
  const rows = db.prepare(`SELECT * FROM shifts WHERE opened_at BETWEEN ? AND ? ${mine ? 'AND user_id = ?' : ''} ORDER BY id DESC`)
    .all(...(mine ? [from, to, req.user.id] : [from, to]));
  res.json(rows.map(shiftSummary));
}));

r.get('/shifts/:id', h((req, res) => {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(int(req.params.id));
  if (!s) throw notFound();
  if (!can(req.user, 'reports') && s.user_id !== req.user.id) throw forbidden();
  res.json(shiftSummary(s));
}));

/* ---------- Customers & debts ---------- */
const balanceSql = '(SELECT COALESCE(SUM(amount),0) FROM customer_ledger l WHERE l.customer_id = c.id)';

r.get('/customers', h((req, res) => {
  const q = `%${str(req.query.q) || ''}%`;
  const debtOnly = req.query.debt === '1';
  res.json(db.prepare(`SELECT c.*, ${balanceSql} balance FROM customers c
    WHERE (c.name LIKE ? OR COALESCE(c.phone,'') LIKE ?) ${debtOnly ? `AND ${balanceSql} > 0.001` : ''}
    ORDER BY c.name LIMIT 500`).all(q, q));
}));

r.post('/customers', h((req, res) => {
  const name = str(req.body.name);
  if (!name) throw bad('name_required');
  const ins = db.prepare('INSERT INTO customers(name, phone, notes, created_at) VALUES(?,?,?,?)').run(name, str(req.body.phone), str(req.body.notes), Date.now());
  res.json(db.prepare(`SELECT c.*, ${balanceSql} balance FROM customers c WHERE id = ?`).get(Number(ins.lastInsertRowid)));
}));

r.put('/customers/:id', h((req, res) => {
  const name = str(req.body.name);
  if (!name) throw bad('name_required');
  db.prepare('UPDATE customers SET name = ?, phone = ?, notes = ? WHERE id = ?').run(name, str(req.body.phone), str(req.body.notes), int(req.params.id));
  res.json({ ok: true });
}));

r.get('/customers/:id', h((req, res) => {
  const id = int(req.params.id);
  const c = db.prepare(`SELECT c.*, ${balanceSql} balance FROM customers c WHERE id = ?`).get(id);
  if (!c) throw notFound();
  c.ledger = db.prepare('SELECT l.*, u.name user_name FROM customer_ledger l LEFT JOIN users u ON u.id = l.user_id WHERE customer_id = ? ORDER BY l.id DESC').all(id);
  c.invoices = db.prepare("SELECT * FROM invoices WHERE customer_id = ? AND status != 'open' ORDER BY id DESC LIMIT 200").all(id);
  res.json(c);
}));

// Customer pays (part of) their debt.
r.post('/customers/:id/pay', h((req, res) => {
  const id = int(req.params.id);
  const amount = money(req.body.amount);
  if (!(amount > 0)) throw bad('invalid_amount');
  const method = req.body.method || 'cash';
  if (!billing.METHODS.includes(method)) throw bad('invalid_method');
  tx(() => {
    const shift = requireShift();
    const bal = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM customer_ledger WHERE customer_id = ?').get(id).s;
    if (amount > money(bal) + 0.001) throw bad('more_than_debt');
    const now = Date.now();
    const p = db.prepare("INSERT INTO payments(customer_id, shift_id, user_id, kind, method, amount, note, created_at) VALUES(?,?,?, 'debt', ?,?,?,?)")
      .run(id, shift.id, req.user.id, method, amount, str(req.body.note), now);
    db.prepare('INSERT INTO customer_ledger(customer_id, amount, payment_id, note, user_id, created_at) VALUES(?,?,?,?,?,?)')
      .run(id, -amount, Number(p.lastInsertRowid), str(req.body.note) || 'debt payment', req.user.id, now);
    audit(req.user.id, 'debt.pay', { customer: id, amount, method });
    const cname = db.prepare('SELECT name FROM customers WHERE id = ?').get(id)?.name;
    tg.notify('important', `💵 سداد دين: ${cname} دفع ${tg.egp(amount)} — باقي عليه ${tg.egp(bal - amount)}`);
  });
  res.json({ ok: true });
}));

module.exports = r;
module.exports.shiftSummary = shiftSummary;
