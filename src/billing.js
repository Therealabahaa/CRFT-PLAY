const { db, money, audit, settings } = require('./db');
const { bad, notFound, forbidden } = require('./util');
const { can } = require('./auth');
const tg = require('./telegram');

// cash · card (Visa / card machine) · online (InstaPay / Vodafone Cash / wallets). wallet & instapay are kept for older records.
const METHODS = ['cash', 'card', 'online', 'wallet', 'instapay'];
const ONLINE = ['online', 'wallet', 'instapay'];

// The owner decides how big a discount cashiers may give (Settings → General → Discounts).
// Admins and staff with the "unlimited discount" permission have no limit.
function discountLimit(user) {
  if (can(user, 'discount')) return { unlimited: true, pct: 100, egp: null };
  const s = settings();
  const pct = Math.min(100, Math.max(0, Number(s.max_discount_pct) || 0));
  const egp = s.max_discount_egp === '' || s.max_discount_egp == null ? null : Math.max(0, Number(s.max_discount_egp) || 0);
  return { unlimited: false, pct, egp };
}
function checkDiscount(user, discount, gross) {
  if (!(discount > 0)) return;
  const lim = discountLimit(user);
  if (lim.unlimited) return;
  const pct = gross > 0 ? (discount / gross) * 100 : 100;
  if (pct > lim.pct + 0.01 || (lim.egp !== null && discount > lim.egp + 0.001)) {
    throw bad('discount_over_limit', { max_pct: lim.pct, max_egp: lim.egp });
  }
}

function getInvoice(id) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) throw notFound('invoice_not_found');
  return inv;
}

function recalcItems(invoiceId) {
  const r = db.prepare('SELECT COALESCE(SUM(qty*price),0) amount, COALESCE(SUM(qty*cost),0) cost FROM invoice_items WHERE invoice_id = ?').get(invoiceId);
  db.prepare('UPDATE invoices SET items_amount = ?, items_cost = ? WHERE id = ?').run(money(r.amount), money(r.cost), invoiceId);
}

// Add products to an open invoice and deduct stock. items: [{product_id, qty}]
function addItems(invoiceId, items, user) {
  const inv = getInvoice(invoiceId);
  if (inv.status !== 'open') throw bad('invoice_closed');
  const now = Date.now();
  for (const it of items || []) {
    const qty = Number(it.qty);
    if (!(qty > 0)) throw bad('invalid_qty');
    const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(it.product_id);
    if (!p) throw notFound('product_not_found');
    if (p.stock < qty) throw bad('insufficient_stock', { product: p.name, stock: p.stock });
    db.prepare('INSERT INTO invoice_items(invoice_id, product_id, name, qty, price, cost, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(invoiceId, p.id, p.name, qty, p.sell_price, p.cost_price, now);
    db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, p.id);
    db.prepare("INSERT INTO stock_movements(product_id, type, qty, unit_cost, invoice_id, user_id, created_at) VALUES(?, 'sale', ?, ?, ?, ?, ?)")
      .run(p.id, -qty, p.cost_price, invoiceId, user.id, now);
    const left = p.stock - qty;
    if (left <= p.low_stock && p.stock > p.low_stock) tg.notify('low_stock', `⚠️ ${p.name} — قرب يخلص: باقي ${left}`, { minGapMs: 3600000, key: 'low' + p.id });
    if (left <= 0 && p.stock > 0) tg.notify('low_stock', `🚫 ${p.name} — خلص من المخزون`, { minGapMs: 3600000, key: 'out' + p.id });
  }
  recalcItems(invoiceId);
}

function removeItem(invoiceId, itemId, user) {
  const inv = getInvoice(invoiceId);
  if (inv.status !== 'open') throw bad('invoice_closed');
  const it = db.prepare('SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ?').get(itemId, invoiceId);
  if (!it) throw notFound('item_not_found');
  db.prepare('DELETE FROM invoice_items WHERE id = ?').run(itemId);
  if (it.product_id) {
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(it.qty, it.product_id);
    db.prepare("INSERT INTO stock_movements(product_id, type, qty, unit_cost, invoice_id, note, user_id, created_at) VALUES(?, 'return', ?, ?, ?, 'removed from order', ?, ?)")
      .run(it.product_id, it.qty, it.cost, invoiceId, user.id, Date.now());
  }
  recalcItems(invoiceId);
  audit(user.id, 'item.remove', { invoice: invoiceId, item: it.name, qty: it.qty });
}

/**
 * Close an invoice: apply discount, record payments, and put any unpaid remainder
 * on the customer's debt account.
 * opts: { discount, payments: [{method, amount}], customer_id, note }
 */
function settle(invoiceId, opts, user, shift) {
  const inv = getInvoice(invoiceId);
  if (inv.status !== 'open') throw bad('invoice_closed');
  const discount = money(opts.discount);
  if (discount < 0) throw bad('invalid_discount');

  const gross = money(inv.time_amount + inv.items_amount);
  if (discount > gross) throw bad('invalid_discount');
  // only the part above a discount already approved on the session is held to this cashier's limit
  checkDiscount(user, Math.max(0, discount - money(opts.preapproved || 0)), gross);
  const total = money(gross - discount);

  const payments = (opts.payments || [])
    .map((p) => ({ method: p.method, amount: money(p.amount) }))
    .filter((p) => p.amount > 0);
  for (const p of payments) if (!METHODS.includes(p.method)) throw bad('invalid_method');
  const paid = money(payments.reduce((s, p) => s + p.amount, 0));
  if (paid > total + 0.001) throw bad('overpaid');

  const remaining = money(total - paid);
  const customerId = opts.customer_id || inv.customer_id || null;
  if (remaining > 0 && !customerId) throw bad('debt_needs_customer');
  if (customerId && !db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) throw notFound('customer_not_found');

  const now = Date.now();
  for (const p of payments) {
    db.prepare("INSERT INTO payments(invoice_id, customer_id, shift_id, user_id, kind, method, amount, note, created_at) VALUES(?,?,?,?, 'invoice', ?,?,?,?)")
      .run(invoiceId, customerId, shift.id, user.id, p.method, p.amount, opts.note || null, now);
  }
  if (remaining > 0) {
    db.prepare('INSERT INTO customer_ledger(customer_id, amount, invoice_id, note, user_id, created_at) VALUES(?,?,?,?,?,?)')
      .run(customerId, remaining, invoiceId, 'unpaid invoice', user.id, now);
  }
  db.prepare("UPDATE invoices SET discount = ?, total = ?, paid = ?, customer_id = ?, shift_id = ?, user_id = ?, status = 'closed', closed_at = ? WHERE id = ?")
    .run(discount, total, paid, customerId, shift.id, user.id, now, invoiceId);
  if (discount > 0) audit(user.id, 'invoice.discount', { invoice: invoiceId, discount });
  if (remaining > 0) {
    audit(user.id, 'invoice.debt', { invoice: invoiceId, customer: customerId, amount: remaining });
    const cname = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId)?.name;
    tg.notify('important', `💳 آجل: ${cname} — ${tg.egp(remaining)} (فاتورة #${invoiceId}) — بواسطة ${user.name}`);
  }
  if (discount > 0) tg.notify('important', `🏷 خصم ${tg.egp(discount)} على فاتورة #${invoiceId} (${tg.egp(gross)}) — بواسطة ${user.name}`);
  return getInvoice(invoiceId);
}

/**
 * Refund (void) a closed invoice: pays back what was collected, cancels any debt it created,
 * and optionally puts the products back in stock.
 */
function refund(invoiceId, { reason, method = 'cash', restock = true }, user, shift) {
  const inv = getInvoice(invoiceId);
  if (inv.status !== 'closed') throw bad('invoice_not_closed');
  void method; // money goes back the way it came in (see below); kept for older callers
  const now = Date.now();
  const payBack = db.prepare("INSERT INTO payments(invoice_id, customer_id, shift_id, user_id, kind, method, amount, note, created_at) VALUES(?,?,?,?, 'refund', ?,?,?,?)");
  // 1) give back each payment the way it was paid (split card + cash → card back on card, cash back in cash),
  //    so the shift's cash drawer, card machine and online totals stay right
  const paidBy = db.prepare("SELECT method, SUM(amount) amount FROM payments WHERE invoice_id = ? AND kind = 'invoice' GROUP BY method").all(invoiceId);
  for (const p of paidBy) if (p.amount > 0.001) payBack.run(invoiceId, inv.customer_id, shift.id, user.id, p.method, -money(p.amount), reason || null, now);
  // 2) the part of the bill that went on credit: cancel only what is still owed; whatever the customer
  //    already paid back towards it is returned to them in cash (never leaves a negative balance)
  const debt = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM customer_ledger WHERE invoice_id = ? AND amount > 0').get(invoiceId).s;
  if (debt > 0.001 && inv.customer_id) {
    const balance = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM customer_ledger WHERE customer_id = ?').get(inv.customer_id).s;
    const cancel = money(Math.max(0, Math.min(debt, balance)));
    const alreadyPaid = money(debt - cancel);
    if (cancel > 0) {
      db.prepare('INSERT INTO customer_ledger(customer_id, amount, invoice_id, note, user_id, created_at) VALUES(?,?,?,?,?,?)')
        .run(inv.customer_id, -cancel, invoiceId, 'invoice refunded', user.id, now);
    }
    if (alreadyPaid > 0) payBack.run(invoiceId, inv.customer_id, shift.id, user.id, 'cash', -alreadyPaid, `${reason || ''} (debt already paid)`.trim(), now);
  }
  if (restock) {
    for (const it of db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? AND product_id IS NOT NULL').all(invoiceId)) {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(it.qty, it.product_id);
      db.prepare("INSERT INTO stock_movements(product_id, type, qty, unit_cost, invoice_id, note, user_id, created_at) VALUES(?, 'return', ?, ?, ?, 'refund', ?, ?)")
        .run(it.product_id, it.qty, it.cost, invoiceId, user.id, now);
    }
  }
  db.prepare("UPDATE invoices SET status = 'void', void_reason = ? WHERE id = ?").run(reason || null, invoiceId);
  audit(user.id, 'invoice.refund', { invoice: invoiceId, paid_back: inv.paid, reason, restock });
  tg.notify('important', `↩️ استرجاع فاتورة #${invoiceId} — ${tg.egp(inv.paid)}\nالسبب: ${reason || '-'} — بواسطة ${user.name}`);
  return getInvoice(invoiceId);
}

/**
 * Edit a paid invoice — e.g. the customer had a drink nobody rang up.
 * items: the full list wanted, [{product_id, qty}]. Lines already on the bill keep the price they were sold at;
 * added pieces are charged today's price. Stock follows the change.
 * The difference is settled now: more to pay → `method` (cash / card / online, or 'credit' on the customer's account);
 * less to pay → first taken off what the customer still owes for this bill, the rest given back by `method`.
 */
function editInvoice(invoiceId, { items, method = 'cash', customer_id, reason }, user, shift) {
  const inv = getInvoice(invoiceId);
  if (inv.status !== 'closed') throw bad('invoice_not_closed');
  if (!reason || !String(reason).trim()) throw bad('reason_required');
  const now = Date.now();
  const before = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoiceId);

  // wanted quantity per product
  const want = new Map();
  for (const it of items || []) {
    const pid = Number(it.product_id);
    const qty = Math.round(Number(it.qty) * 1000) / 1000;
    if (!pid || !(qty >= 0)) throw bad('invalid_qty');
    want.set(pid, (want.get(pid) || 0) + qty);
  }
  const have = new Map();
  for (const it of before) if (it.product_id) have.set(it.product_id, (have.get(it.product_id) || 0) + it.qty);
  const changes = [];
  for (const pid of new Set([...want.keys(), ...have.keys()])) {
    const delta = Math.round(((want.get(pid) || 0) - (have.get(pid) || 0)) * 1000) / 1000;
    if (!delta) continue;
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(pid);
    if (!p) throw notFound('product_not_found');
    if (delta > 0) { // add pieces at today's price
      if (p.stock < delta) throw bad('insufficient_stock', { product: p.name, stock: p.stock });
      db.prepare('INSERT INTO invoice_items(invoice_id, product_id, name, qty, price, cost, created_at) VALUES(?,?,?,?,?,?,?)').run(invoiceId, pid, p.name, delta, p.sell_price, p.cost_price, now);
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(delta, pid);
      db.prepare("INSERT INTO stock_movements(product_id, type, qty, unit_cost, invoice_id, note, user_id, created_at) VALUES(?, 'sale', ?, ?, ?, 'invoice edited', ?, ?)").run(pid, -delta, p.cost_price, invoiceId, user.id, now);
    } else { // take pieces off, newest lines first, and put them back on the shelf
      let left = -delta;
      for (const row of before.filter((x) => x.product_id === pid).reverse()) {
        if (left <= 0) break;
        const take = Math.min(left, row.qty);
        if (take >= row.qty) db.prepare('DELETE FROM invoice_items WHERE id = ?').run(row.id);
        else db.prepare('UPDATE invoice_items SET qty = qty - ? WHERE id = ?').run(take, row.id);
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(take, pid);
        db.prepare("INSERT INTO stock_movements(product_id, type, qty, unit_cost, invoice_id, note, user_id, created_at) VALUES(?, 'return', ?, ?, ?, 'invoice edited', ?, ?)").run(pid, take, row.cost, invoiceId, user.id, now);
        left -= take;
      }
    }
    changes.push(`${delta > 0 ? '+' : ''}${delta} ${p.name}`);
  }
  if (!changes.length) throw bad('nothing_changed');
  recalcItems(invoiceId);

  const fresh = getInvoice(invoiceId);
  const gross = money(fresh.time_amount + fresh.items_amount);
  const discount = Math.min(fresh.discount, gross);
  const total = money(gross - discount);
  const diff = money(total - inv.total);
  const customerId = customer_id || inv.customer_id || null;
  let paid = inv.paid;
  const pay = db.prepare('INSERT INTO payments(invoice_id, customer_id, shift_id, user_id, kind, method, amount, note, created_at) VALUES(?,?,?,?,?,?,?,?,?)');
  const ledger = db.prepare('INSERT INTO customer_ledger(customer_id, amount, invoice_id, note, user_id, created_at) VALUES(?,?,?,?,?,?)');
  if (diff > 0) {
    if (method === 'credit') {
      if (!customerId) throw bad('debt_needs_customer');
      ledger.run(customerId, diff, invoiceId, 'invoice edited', user.id, now);
    } else {
      if (!METHODS.includes(method)) throw bad('invalid_method');
      pay.run(invoiceId, customerId, shift.id, user.id, 'invoice', method, diff, `edit: ${reason}`, now);
      paid = money(paid + diff);
    }
  } else if (diff < 0) {
    let back = -diff;
    // first cancel what is still owed on this bill (never below what the customer actually owes)
    const owedHere = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM customer_ledger WHERE invoice_id = ?').get(invoiceId).s;
    if (owedHere > 0.001 && inv.customer_id) {
      const balance = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM customer_ledger WHERE customer_id = ?').get(inv.customer_id).s;
      const cancel = money(Math.min(back, owedHere, Math.max(0, balance)));
      if (cancel > 0) { ledger.run(inv.customer_id, -cancel, invoiceId, 'invoice edited', user.id, now); back = money(back - cancel); }
    }
    if (back > 0) {
      const m = method === 'credit' || !METHODS.includes(method) ? 'cash' : method;
      pay.run(invoiceId, customerId, shift.id, user.id, 'refund', m, -back, `edit: ${reason}`, now);
      paid = money(paid - back);
    }
  }
  db.prepare("UPDATE invoices SET discount = ?, total = ?, paid = ?, customer_id = COALESCE(?, customer_id), edited_at = ?, edit_count = COALESCE(edit_count, 0) + 1 WHERE id = ?")
    .run(discount, total, paid, customerId, now, invoiceId);
  audit(user.id, 'invoice.edit', { invoice: invoiceId, changes, before: inv.total, after: total, difference: diff, method: diff ? method : null, reason });
  tg.notify('important', `✏️ تعديل فاتورة #${invoiceId}: ${changes.join('، ')}\n${tg.egp(inv.total)} ← ${tg.egp(total)} (${diff > 0 ? '+' : ''}${tg.egp(diff)}${diff ? ` — ${{ credit: 'آجل', cash: 'كاش', card: 'فيزا', online: 'أونلاين' }[method] || method}` : ''})\nالسبب: ${reason} — بواسطة ${user.name}`);
  return { invoice: invoiceDetail(invoiceId), difference: diff, changes };
}

function invoiceDetail(id) {
  const inv = getInvoice(id);
  inv.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(id);
  inv.payments = db.prepare('SELECT p.*, u.name user_name FROM payments p LEFT JOIN users u ON u.id = p.user_id WHERE invoice_id = ? ORDER BY p.id').all(id);
  inv.customer = inv.customer_id ? db.prepare('SELECT id, name, phone FROM customers WHERE id = ?').get(inv.customer_id) : null;
  inv.user_name = inv.user_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(inv.user_id)?.name : null;
  if (inv.session_id) {
    inv.session = db.prepare('SELECT s.*, c.name console_name, c.type console_type FROM sessions s JOIN consoles c ON c.id = s.console_id WHERE s.id = ?').get(inv.session_id);
    inv.session.segments = db.prepare('SELECT g.*, c.name console_name FROM session_segments g JOIN consoles c ON c.id = g.console_id WHERE session_id = ? ORDER BY g.id').all(inv.session_id);
  }
  return inv;
}

module.exports = { METHODS, ONLINE, discountLimit, checkDiscount, addItems, removeItem, settle, refund, editInvoice, invoiceDetail, getInvoice };
