const express = require('express');
const { db, tx, money, audit } = require('../db');
const { h, bad, notFound, requireShift, currentShift, int, num, str, range } = require('../util');
const { requirePerm } = require('../auth');
const tg = require('../telegram');

const r = express.Router();

/* ---------- Products & stock ---------- */
r.get('/products', h((req, res) => {
  const all = req.query.all === '1';
  const since = Date.now() - 14 * 86400000;
  // sold_14d: how many sold in the last 14 days (for "lasts about"); last_count: when the shelf was last counted
  res.json(db.prepare(`SELECT p.*,
      (SELECT COALESCE(SUM(-qty),0) FROM stock_movements m WHERE m.product_id = p.id AND m.type IN ('sale','return') AND m.created_at >= ?) sold_14d,
      (SELECT MAX(created_at) FROM stock_movements m WHERE m.product_id = p.id AND m.type = 'count') last_count
    FROM products p ${all ? '' : 'WHERE active = 1'} ORDER BY category, name`).all(since));
}));

/* ---------- Inventory jobs (Kur style) ---------- */
// Receive a delivery: several products at once, with the TOTAL paid for each line; the unit cost is worked out
// and the product's cost becomes the weighted average of old and new stock.
r.post('/inventory/receive', requirePerm('inventory'), h((req, res) => {
  const b = req.body || {};
  const lines = (b.lines || []).filter((l) => int(l.product_id) && num(l.qty) > 0);
  if (!lines.length) throw bad('empty_delivery');
  const result = tx(() => {
    const now = Date.now();
    let total = 0;
    const out = [];
    for (const l of lines) {
      const p = db.prepare('SELECT * FROM products WHERE id = ?').get(int(l.product_id));
      if (!p) throw notFound('product_not_found');
      const qty = num(l.qty);
      const lineTotal = money(l.total_cost);
      if (lineTotal < 0) throw bad('invalid_amount');
      const unit = lineTotal > 0 ? lineTotal / qty : p.cost_price;
      const base = Math.max(0, p.stock);
      const avg = money((base * p.cost_price + qty * unit) / (base + qty));
      db.prepare('UPDATE products SET stock = stock + ?, cost_price = ? WHERE id = ?').run(qty, avg, p.id);
      db.prepare("INSERT INTO stock_movements(product_id, type, qty, unit_cost, supplier, note, user_id, created_at) VALUES(?, 'purchase', ?,?,?,?,?,?)")
        .run(p.id, qty, money(unit), str(b.supplier), str(b.note), req.user.id, now);
      total += lineTotal;
      out.push({ name: p.name, qty, unit_cost: money(unit), new_cost: avg, stock: p.stock + qty });
    }
    total = money(total);
    if (b.from_drawer && total > 0) {
      const shift = requireShift();
      db.prepare("INSERT INTO expenses(category, amount, note, spent_at, from_drawer, shift_id, user_id, created_at) VALUES('stock', ?, ?, ?, 1, ?, ?, ?)")
        .run(total, `${out.map((x) => `${x.name} × ${x.qty}`).join('، ')}${str(b.supplier) ? ' — ' + str(b.supplier) : ''}`, now, shift.id, req.user.id, now);
    }
    audit(req.user.id, 'stock.receive', { supplier: b.supplier, total, lines: out.map((x) => `${x.name} × ${x.qty}`) });
    tg.notify('important', `📥 استلام بضاعة${str(b.supplier) ? ` من ${str(b.supplier)}` : ''} — ${tg.egp(total)}${b.from_drawer ? ' (من الدرج)' : ''}\n${out.map((x) => `  • ${x.name} × ${x.qty}`).join('\n')}\nبواسطة ${req.user.name}`);
    return { total, lines: out };
  });
  res.json(result);
}));

// Count the shelf: type the real quantity of each product (empty = skipped). Every difference is recorded so it can be traced.
r.post('/inventory/count', requirePerm('inventory'), h((req, res) => {
  const b = req.body || {};
  const lines = (b.lines || []).filter((l) => int(l.product_id) && l.counted !== '' && l.counted != null && num(l.counted, -1) >= 0);
  if (!lines.length) throw bad('empty_count');
  const result = tx(() => {
    const now = Date.now();
    const note = [str(b.reason), str(b.note)].filter(Boolean).join(' — ') || null;
    return lines.map((l) => {
      const p = db.prepare('SELECT * FROM products WHERE id = ?').get(int(l.product_id));
      if (!p) throw notFound('product_not_found');
      const counted = num(l.counted);
      const diff = Math.round((counted - p.stock) * 1000) / 1000;
      // a 0-difference line is still recorded: it shows when the shelf was last counted
      db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(counted, p.id);
      db.prepare("INSERT INTO stock_movements(product_id, type, qty, unit_cost, note, user_id, created_at) VALUES(?, 'count', ?,?,?,?,?)")
        .run(p.id, diff, p.cost_price, note, req.user.id, now);
      return { product_id: p.id, name: p.name, system: p.stock, counted, difference: diff, value: money(diff * p.cost_price) };
    });
  });
  const missing = result.filter((x) => x.difference < 0);
  audit(req.user.id, 'stock.count_all', { counted: result.length, different: result.filter((x) => x.difference).length });
  if (missing.length) {
    tg.notify('important', `🔢 جرد المخزن — ${result.length} منتج، ${missing.length} ناقص (${tg.egp(-missing.reduce((s, x) => s + x.value, 0))})\n${missing.map((x) => `  • ${x.name}: ${x.difference}`).join('\n')}\nبواسطة ${req.user.name}`);
  }
  res.json({ lines: result });
}));

r.post('/products/rename-category', requirePerm('inventory'), h((req, res) => {
  const from = String(req.body.from ?? '');
  const to = str(req.body.to);
  db.prepare("UPDATE products SET category = ? WHERE COALESCE(category, '') = ?").run(to, from);
  audit(req.user.id, 'product.category', { from, to });
  res.json({ ok: true });
}));

function productFields(b) {
  const name = str(b.name);
  if (!name) throw bad('name_required');
  return [name, str(b.category), money(b.cost_price), money(b.sell_price), num(b.low_stock, 5), b.active === false || b.active === 0 ? 0 : 1];
}

r.post('/products', requirePerm('inventory'), h((req, res) => {
  const id = tx(() => {
    const ins = db.prepare('INSERT INTO products(name, category, cost_price, sell_price, low_stock, active, stock) VALUES(?,?,?,?,?,?,0)').run(...productFields(req.body));
    const pid = Number(ins.lastInsertRowid);
    const opening = num(req.body.stock, 0);
    if (opening > 0) {
      db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(opening, pid);
      db.prepare("INSERT INTO stock_movements(product_id, type, qty, unit_cost, note, user_id, created_at) VALUES(?, 'adjust', ?, ?, 'opening stock', ?, ?)")
        .run(pid, opening, money(req.body.cost_price), req.user.id, Date.now());
    }
    audit(req.user.id, 'product.create', { product: req.body.name });
    return pid;
  });
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
}));

r.put('/products/:id', requirePerm('inventory'), h((req, res) => {
  const id = int(req.params.id);
  const old = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!old) throw notFound();
  db.prepare('UPDATE products SET name = ?, category = ?, cost_price = ?, sell_price = ?, low_stock = ?, active = ? WHERE id = ?').run(...productFields(req.body), id);
  if (old.sell_price !== money(req.body.sell_price) || old.cost_price !== money(req.body.cost_price)) {
    audit(req.user.id, 'product.price', { product: old.name, sell: [old.sell_price, money(req.body.sell_price)], cost: [old.cost_price, money(req.body.cost_price)] });
  }
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
}));

// Purchase from supplier. Cost price becomes the weighted average of old stock and new stock.
r.post('/products/:id/purchase', requirePerm('inventory'), h((req, res) => {
  const id = int(req.params.id);
  const qty = num(req.body.qty);
  const unitCost = money(req.body.unit_cost);
  if (!(qty > 0) || unitCost < 0) throw bad('invalid_qty');
  tx(() => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!p) throw notFound();
    const base = Math.max(0, p.stock);
    const avg = base + qty > 0 ? money((base * p.cost_price + qty * unitCost) / (base + qty)) : unitCost;
    const now = Date.now();
    db.prepare('UPDATE products SET stock = stock + ?, cost_price = ? WHERE id = ?').run(qty, avg, id);
    db.prepare("INSERT INTO stock_movements(product_id, type, qty, unit_cost, supplier, note, user_id, created_at) VALUES(?, 'purchase', ?,?,?,?,?,?)")
      .run(id, qty, unitCost, str(req.body.supplier), str(req.body.note), req.user.id, now);
    if (req.body.from_drawer) {
      const shift = requireShift();
      db.prepare("INSERT INTO expenses(category, amount, note, spent_at, from_drawer, shift_id, user_id, created_at) VALUES('stock', ?, ?, ?, 1, ?, ?, ?)")
        .run(money(qty * unitCost), `${p.name} × ${qty}${req.body.supplier ? ' — ' + req.body.supplier : ''}`, now, shift.id, req.user.id, now);
    }
    audit(req.user.id, 'stock.purchase', { product: p.name, qty, unit_cost: unitCost, supplier: req.body.supplier });
  });
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
}));

// Damaged / expired / wasted products.
// Any cashier can record waste (spilled, expired…) — it is in the history with their name and goes to the owner on Telegram.
r.post('/products/:id/waste', h((req, res) => {
  const id = int(req.params.id);
  const qty = num(req.body.qty);
  if (!(qty > 0)) throw bad('invalid_qty');
  tx(() => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!p) throw notFound();
    if (qty > p.stock) throw bad('insufficient_stock', { product: p.name, stock: p.stock });
    db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, id);
    db.prepare("INSERT INTO stock_movements(product_id, type, qty, unit_cost, note, user_id, created_at) VALUES(?, 'waste', ?,?,?,?,?)")
      .run(id, -qty, p.cost_price, [str(req.body.reason), str(req.body.note)].filter(Boolean).join(' — ') || null, req.user.id, Date.now());
    audit(req.user.id, 'stock.waste', { product: p.name, qty, note: req.body.note });
    tg.notify('important', `🗑 هالك: ${p.name} × ${qty} (${tg.egp(qty * p.cost_price)})${str(req.body.note) ? ` — ${str(req.body.note)}` : ''} — بواسطة ${req.user.name}`);
  });
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
}));

// Fix the amount of one product. mode 'count' = I counted the shelf (a difference is a real loss/gain);
// mode 'entry' = it was typed wrong (set as if typed right from the start — not a loss or gain, but still in the history).
r.post('/products/:id/count', requirePerm('inventory'), h((req, res) => {
  const id = int(req.params.id);
  const actual = num(req.body.stock, NaN);
  const mode = req.body.mode === 'entry' ? 'entry' : 'count';
  if (!(actual >= 0)) throw bad('invalid_qty');
  if (mode === 'entry' && req.user.role !== 'admin') throw bad('only_admin');
  tx(() => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!p) throw notFound();
    const diff = Math.round((actual - p.stock) * 1000) / 1000;
    if (diff === 0 && mode === 'entry') return;
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(actual, id);
    db.prepare('INSERT INTO stock_movements(product_id, type, qty, unit_cost, note, user_id, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, mode === 'entry' ? 'correction' : 'count', diff, p.cost_price, [str(req.body.reason), str(req.body.note)].filter(Boolean).join(' — ') || null, req.user.id, Date.now());
    audit(req.user.id, 'stock.count', { product: p.name, from: p.stock, to: actual, mode });
  });
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
}));

r.get('/stock-movements', h((req, res) => {
  const { from, to } = req.query.recent ? { from: 0, to: Date.now() + 86400000 } : range(req.query);
  const args = [from, to];
  let extra = '';
  if (req.query.types) { const ts = String(req.query.types).split(',').filter(Boolean); extra += ` AND m.type IN (${ts.map(() => '?').join(',')})`; args.push(...ts); }
  if (req.query.product_id) { extra += ' AND m.product_id = ?'; args.push(int(req.query.product_id)); }
  if (req.query.type) { extra += ' AND m.type = ?'; args.push(req.query.type); }
  res.json(db.prepare(`SELECT m.*, p.name product_name, u.name user_name FROM stock_movements m
    JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
    WHERE m.created_at BETWEEN ? AND ? ${extra} ORDER BY m.id DESC LIMIT ${Math.min(2000, int(req.query.limit, 2000))}`).all(...args));
}));

/* ---------- Expenses ---------- */
const EXPENSE_CATS = ['rent', 'electricity', 'internet', 'maintenance', 'controllers', 'salaries', 'stock', 'other'];

r.get('/expenses', requirePerm('expenses'), h((req, res) => {
  const { from, to } = range(req.query);
  res.json(db.prepare(`SELECT e.*, u.name user_name FROM expenses e LEFT JOIN users u ON u.id = e.user_id
    WHERE spent_at BETWEEN ? AND ? ORDER BY spent_at DESC`).all(from, to));
}));

r.post('/expenses', requirePerm('expenses'), h((req, res) => {
  const b = req.body || {};
  const amount = money(b.amount);
  if (!(amount > 0)) throw bad('invalid_amount');
  if (!EXPENSE_CATS.includes(b.category)) throw bad('invalid_category');
  const id = tx(() => {
    const shift = b.from_drawer ? requireShift() : currentShift();
    let spent = Date.now();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b.date || '');
    if (m && !b.from_drawer) spent = new Date(+m[1], +m[2] - 1, +m[3], 12).getTime();
    const ins = db.prepare('INSERT INTO expenses(category, amount, note, spent_at, from_drawer, shift_id, user_id, created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(b.category, amount, str(b.note), spent, b.from_drawer ? 1 : 0, b.from_drawer ? shift.id : null, req.user.id, Date.now());
    audit(req.user.id, 'expense.add', { category: b.category, amount, from_drawer: !!b.from_drawer });
    const CAT_AR = { rent: 'إيجار', electricity: 'كهرباء', internet: 'إنترنت', maintenance: 'صيانة', controllers: 'دراعات', salaries: 'مرتبات', other: 'أخرى' };
    tg.notify('important', `🧾 مصروف: ${CAT_AR[b.category] || b.category} — ${tg.egp(amount)}${b.from_drawer ? ' (من الدرج)' : ''}${str(b.note) ? `\n${str(b.note)}` : ''} — بواسطة ${req.user.name}`);
    return Number(ins.lastInsertRowid);
  });
  res.json(db.prepare('SELECT * FROM expenses WHERE id = ?').get(id));
}));

r.delete('/expenses/:id', requirePerm('manage'), h((req, res) => {
  const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(int(req.params.id));
  if (!e) throw notFound();
  if (e.shift_id) {
    const s = db.prepare('SELECT closed_at FROM shifts WHERE id = ?').get(e.shift_id);
    if (s && s.closed_at) throw bad('shift_closed');
  }
  db.prepare('DELETE FROM expenses WHERE id = ?').run(e.id);
  audit(req.user.id, 'expense.delete', e);
  res.json({ ok: true });
}));

/* ---------- Reservations ---------- */
r.get('/reservations', h((req, res) => {
  const { from, to } = range(req.query);
  res.json(db.prepare(`SELECT r.*, c.name console_name, c.type console_type FROM reservations r JOIN consoles c ON c.id = r.console_id
    WHERE r.start_at BETWEEN ? AND ? ORDER BY r.start_at`).all(from, to));
}));

r.post('/reservations', h((req, res) => {
  const b = req.body || {};
  const name = str(b.customer_name);
  if (!name) throw bad('name_required');
  const start = int(b.start_at);
  const minutes = int(b.minutes, 60);
  if (!start || !(minutes > 0)) throw bad('invalid_time');
  const end = start + minutes * 60000;
  const c = db.prepare('SELECT * FROM consoles WHERE id = ? AND deleted = 0').get(int(b.console_id));
  if (!c) throw notFound('console_not_found');
  const clash = db.prepare("SELECT * FROM reservations WHERE console_id = ? AND status = 'booked' AND start_at < ? AND end_at > ? AND id != ?")
    .get(c.id, end, start, int(b.id, 0));
  if (clash) throw bad('reservation_conflict', { name: clash.customer_name, start_at: clash.start_at });
  let id = int(b.id, null);
  if (id) {
    db.prepare('UPDATE reservations SET console_id = ?, customer_name = ?, phone = ?, start_at = ?, end_at = ?, notes = ? WHERE id = ?')
      .run(c.id, name, str(b.phone), start, end, str(b.notes), id);
  } else {
    id = Number(db.prepare('INSERT INTO reservations(console_id, customer_id, customer_name, phone, start_at, end_at, notes, user_id, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(c.id, int(b.customer_id, null), name, str(b.phone), start, end, str(b.notes), req.user.id, Date.now()).lastInsertRowid);
  }
  audit(req.user.id, 'reservation.save', { id, console: c.name, name, start });
  res.json(db.prepare('SELECT * FROM reservations WHERE id = ?').get(id));
}));

r.post('/reservations/:id/status', h((req, res) => {
  const st = req.body.status;
  if (!['booked', 'arrived', 'cancelled', 'no_show'].includes(st)) throw bad('invalid_status');
  db.prepare('UPDATE reservations SET status = ? WHERE id = ?').run(st, int(req.params.id));
  audit(req.user.id, 'reservation.status', { id: int(req.params.id), status: st });
  res.json({ ok: true });
}));

module.exports = { router: r, EXPENSE_CATS };
