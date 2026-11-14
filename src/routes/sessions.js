const express = require('express');
const { db, tx, money, audit, settings } = require('../db');
const { h, bad, notFound, requireShift, currentShift, int, num, str } = require('../util');
const { requirePerm } = require('../auth');
const billing = require('../billing');
const tg = require('../telegram');
const Pricing = require('../../public/js/pricing');

const r = express.Router();

// Each room has ONE fixed price per hour — it doesn't matter how many people play.
function effectiveRates(c) {
  return { single: c.rate_single, multi: c.rate_single, room: null };
}
const rateFor = (consoleRow) => effectiveRates(consoleRow).single;

function loadSession(id) {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!s) throw notFound('session_not_found');
  s.segments = db.prepare('SELECT * FROM session_segments WHERE session_id = ? ORDER BY id').all(id);
  return s;
}
function liveSession(id) {
  const s = loadSession(id);
  if (s.status === 'ended') throw bad('session_ended');
  return s;
}
function closeOpenSegment(sessionId, at) {
  db.prepare('UPDATE session_segments SET end_at = ? WHERE session_id = ? AND end_at IS NULL').run(at, sessionId);
}
function openSegment(sessionId, consoleId, players, rate, at) {
  db.prepare('INSERT INTO session_segments(session_id, console_id, players, rate, start_at) VALUES(?,?,?,?,?)')
    .run(sessionId, consoleId, players, rate, at);
}
function occupied(consoleId) {
  return db.prepare("SELECT id FROM sessions WHERE console_id = ? AND status != 'ended'").get(consoleId);
}
function usableConsole(id) {
  const c = db.prepare('SELECT * FROM consoles WHERE id = ? AND deleted = 0').get(id);
  if (!c) throw notFound('console_not_found');
  if (c.status !== 'active') throw bad('console_in_maintenance');
  if (occupied(c.id)) throw bad('console_busy');
  return c;
}
function withPrice(s, now = Date.now()) {
  const p = Pricing.compute(s, settings(), now);
  const inv = s.invoice_id ? db.prepare('SELECT items_amount FROM invoices WHERE id = ?').get(s.invoice_id) : null;
  s.minutes = p.minutes;
  s.time_amount = p.amount;
  s.overtime = p.overtime;
  s.items_amount = inv ? inv.items_amount : 0;
  s.discount_amount = money((p.amount * (s.discount_pct || 0)) / 100);
  s.total = money(p.amount + s.items_amount);
  s.priced_at = now;
  return s;
}

// Floor overview: every console with its live session and upcoming reservation.
r.get('/floor', h((req, res) => {
  const now = Date.now();
  const consoles = db.prepare('SELECT * FROM consoles WHERE deleted = 0 ORDER BY id').all();
  const live = db.prepare("SELECT * FROM sessions WHERE status != 'ended'").all();
  const byConsole = {};
  for (const s of live) {
    s.segments = db.prepare('SELECT * FROM session_segments WHERE session_id = ? ORDER BY id').all(s.id);
    s.items = db.prepare('SELECT id, name, qty, price FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(s.invoice_id);
    s.items_amount = money(s.items.reduce((a, i) => a + i.qty * i.price, 0));
    s.customer = s.customer_id ? db.prepare('SELECT id, name, phone FROM customers WHERE id = ?').get(s.customer_id) : null;
    byConsole[s.console_id] = s;
  }
  const upcoming = db.prepare("SELECT * FROM reservations WHERE status = 'booked' AND end_at > ? AND start_at < ? ORDER BY start_at")
    .all(now, now + 1000 * 60 * 60 * 3);
  for (const c of consoles) {
    c.session = byConsole[c.id] || null;
    c.reservation = upcoming.find((x) => x.console_id === c.id) || null;
    const r = effectiveRates(c);
    c.price_single = r.single;
    c.price_multi = r.multi;
    c.room_name = r.room ? r.room.name : null;
  }
  const st = settings();
  res.json({
    now,
    consoles,
    rooms: [],
    discount_limit: billing.discountLimit(req.user),
    shift: currentShift(),
    pricing: { round_to: st.round_to, min_minutes: st.min_minutes, grace_minutes: st.grace_minutes },
    packages: db.prepare('SELECT * FROM packages WHERE active = 1 ORDER BY minutes').all(),
  });
}));

r.post('/sessions', h((req, res) => {
  const b = req.body || {};
  const id = tx(() => {
    const c = usableConsole(b.console_id);
    const players = Math.max(1, int(b.players, 2));
    const now = Date.now();
    let pkg = null;
    if (b.package_id) {
      pkg = db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(b.package_id);
      if (!pkg) throw notFound('package_not_found');
      if (pkg.console_type && pkg.console_type !== c.type) throw bad('package_wrong_console');
      if (pkg.room_id && pkg.room_id !== c.room_id) throw bad('package_wrong_console');
    }
    const planned = pkg ? pkg.minutes : int(b.planned_minutes, null);
    const customerId = int(b.customer_id, null);
    const inv = db.prepare("INSERT INTO invoices(kind, customer_id, user_id, created_at) VALUES('session', ?, ?, ?)").run(customerId, req.user.id, now);
    const invoiceId = Number(inv.lastInsertRowid);
    const sres = db.prepare(`INSERT INTO sessions(console_id, invoice_id, customer_id, customer_name, package_id, package_minutes, package_price,
      planned_minutes, players, status, started_at, opened_by, notes) VALUES(?,?,?,?,?,?,?,?,?, 'active', ?,?,?)`)
      .run(c.id, invoiceId, customerId, str(b.customer_name), pkg?.id ?? null, pkg?.minutes ?? null, pkg?.price ?? null,
        planned && planned > 0 ? planned : null, players, now, req.user.id, str(b.notes));
    const sid = Number(sres.lastInsertRowid);
    db.prepare('UPDATE invoices SET session_id = ? WHERE id = ?').run(sid, invoiceId);
    openSegment(sid, c.id, players, rateFor(c, players), now);
    if (b.reservation_id) {
      db.prepare("UPDATE reservations SET status = 'arrived' WHERE id = ? AND status = 'booked'").run(b.reservation_id);
    }
    audit(req.user.id, 'session.start', { session: sid, console: c.name, players, package: pkg?.name });
    return sid;
  });
  res.json(withPrice(loadSession(id)));
}));

r.get('/sessions/:id', h((req, res) => {
  const s = withPrice(loadSession(req.params.id));
  s.invoice = billing.invoiceDetail(s.invoice_id);
  res.json(s);
}));

r.post('/sessions/:id/pause', h((req, res) => {
  tx(() => {
    const s = liveSession(req.params.id);
    if (s.status !== 'active') throw bad('session_not_active');
    closeOpenSegment(s.id, Date.now());
    db.prepare("UPDATE sessions SET status = 'paused' WHERE id = ?").run(s.id);
    audit(req.user.id, 'session.pause', { session: s.id });
  });
  res.json(withPrice(loadSession(req.params.id)));
}));

r.post('/sessions/:id/resume', h((req, res) => {
  tx(() => {
    const s = liveSession(req.params.id);
    if (s.status !== 'paused') throw bad('session_not_paused');
    const c = db.prepare('SELECT * FROM consoles WHERE id = ?').get(s.console_id);
    openSegment(s.id, c.id, s.players, rateFor(c, s.players), Date.now());
    db.prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(s.id);
    audit(req.user.id, 'session.resume', { session: s.id });
  });
  res.json(withPrice(loadSession(req.params.id)));
}));

// Change number of players (single <-> multi rate) without restarting the session.
r.post('/sessions/:id/players', h((req, res) => {
  tx(() => {
    const s = liveSession(req.params.id);
    const players = Math.max(1, int(req.body.players, 2));
    if (players === s.players) return;
    const c = db.prepare('SELECT * FROM consoles WHERE id = ?').get(s.console_id);
    if (s.status === 'active') {
      const now = Date.now();
      closeOpenSegment(s.id, now);
      openSegment(s.id, c.id, players, rateFor(c, players), now);
    }
    db.prepare('UPDATE sessions SET players = ? WHERE id = ?').run(players, s.id);
    audit(req.user.id, 'session.players', { session: s.id, from: s.players, to: players });
  });
  res.json(withPrice(loadSession(req.params.id)));
}));

// Move the session to another console (e.g. a controller broke). Time so far keeps its old rate.
r.post('/sessions/:id/move', h((req, res) => {
  tx(() => {
    const s = liveSession(req.params.id);
    const target = usableConsole(req.body.console_id);
    if (s.status === 'active') {
      const now = Date.now();
      closeOpenSegment(s.id, now);
      openSegment(s.id, target.id, s.players, rateFor(target, s.players), now);
    }
    const from = db.prepare('SELECT name FROM consoles WHERE id = ?').get(s.console_id).name;
    db.prepare('UPDATE sessions SET console_id = ? WHERE id = ?').run(target.id, s.id);
    audit(req.user.id, 'session.move', { session: s.id, from, to: target.name });
  });
  res.json(withPrice(loadSession(req.params.id)));
}));

// Discount on a running session: % off the playtime charge (drinks are never discounted). Cashiers are held to the owner's limit.
r.post('/sessions/:id/discount', h((req, res) => {
  const pct = Math.round(num(req.body.pct, 0) * 100) / 100;
  if (!(pct >= 0 && pct <= 100)) throw bad('invalid_discount');
  tx(() => {
    const s = liveSession(req.params.id);
    const lim = billing.discountLimit(req.user);
    if (!lim.unlimited && pct > lim.pct) throw bad('discount_over_limit', { max_pct: lim.pct, max_egp: lim.egp });
    // the money limit (EGP per bill) applies too, on the playtime so far
    if (!lim.unlimited && lim.egp != null) {
      const sofar = Pricing.compute(s, settings(), Date.now()).amount;
      if ((sofar * pct) / 100 > lim.egp + 0.001) throw bad('discount_over_limit', { max_pct: lim.pct, max_egp: lim.egp });
    }
    db.prepare('UPDATE sessions SET discount_pct = ? WHERE id = ?').run(pct, s.id);
    audit(req.user.id, 'session.discount', { session: s.id, from: s.discount_pct, to: pct });
  });
  res.json(withPrice(loadSession(req.params.id)));
}));

r.post('/sessions/:id/update', h((req, res) => {
  const b = req.body || {};
  tx(() => {
    const s = liveSession(req.params.id);
    db.prepare('UPDATE sessions SET customer_id = ?, customer_name = ?, planned_minutes = ?, notes = ? WHERE id = ?')
      .run(int(b.customer_id, null), str(b.customer_name), int(b.planned_minutes, null) || null, str(b.notes), s.id);
    db.prepare('UPDATE invoices SET customer_id = ? WHERE id = ?').run(int(b.customer_id, null), s.invoice_id);
  });
  res.json(withPrice(loadSession(req.params.id)));
}));

r.post('/sessions/:id/items', h((req, res) => {
  tx(() => {
    const s = liveSession(req.params.id);
    billing.addItems(s.invoice_id, req.body.items || [{ product_id: req.body.product_id, qty: req.body.qty || 1 }], req.user);
  });
  res.json(withPrice(loadSession(req.params.id)));
}));

r.delete('/sessions/:id/items/:itemId', h((req, res) => {
  tx(() => {
    const s = liveSession(req.params.id);
    billing.removeItem(s.invoice_id, int(req.params.itemId), req.user);
  });
  res.json(withPrice(loadSession(req.params.id)));
}));

// End the session and take payment.
r.post('/sessions/:id/checkout', h((req, res) => {
  const b = req.body || {};
  const invoice = tx(() => {
    const shift = requireShift();
    const s = liveSession(req.params.id);
    // End time = when the cashier opened the payment dialog (priced_at), so the bill
    // shown to the customer is exactly what gets charged. Ignored if stale.
    let now = Date.now();
    const at = int(b.at, 0);
    const lastStart = Math.max(...s.segments.map((g) => g.start_at));
    if (at && at <= now && now - at < 15 * 60000 && at >= lastStart) now = at;
    closeOpenSegment(s.id, now);
    const fresh = loadSession(s.id);
    const price = Pricing.compute(fresh, settings(), now);
    db.prepare("UPDATE sessions SET status = 'ended', ended_at = ?, minutes = ?, time_amount = ?, closed_by = ? WHERE id = ?")
      .run(now, price.minutes, price.amount, req.user.id, s.id);
    db.prepare('UPDATE invoices SET time_amount = ? WHERE id = ?').run(price.amount, s.invoice_id);
    // The bill must be exactly what the cashier showed the customer. If it changed since the payment
    // window opened (window left open too long, or an item added from another device), stop and say so —
    // never turn the difference into a silent customer debt.
    const itemsNow = db.prepare('SELECT items_amount FROM invoices WHERE id = ?').get(s.invoice_id).items_amount;
    const gross = money(price.amount + itemsNow);
    if (b.expected_gross != null && Math.abs(num(b.expected_gross) - gross) > 0.009) throw bad('price_changed', { total: gross });
    // a discount set on the session (approved within someone's limit when it was set) is honoured at checkout
    const preapproved = money((price.amount * (fresh.discount_pct || 0)) / 100);
    const inv = billing.settle(s.invoice_id, { discount: b.discount, preapproved, payments: b.payments, customer_id: int(b.customer_id, null) || s.customer_id, note: str(b.note) }, req.user, shift);
    audit(req.user.id, 'session.end', { session: s.id, minutes: Math.round(price.minutes), total: inv.total, paid: inv.paid });
    return inv;
  });
  res.json(billing.invoiceDetail(invoice.id));
}));

// Cancel a session started by mistake: nothing is charged and products go back to stock.
r.post('/sessions/:id/cancel', requirePerm('refund'), h((req, res) => {
  tx(() => {
    const s = liveSession(req.params.id);
    const now = Date.now();
    closeOpenSegment(s.id, now);
    for (const it of db.prepare('SELECT id FROM invoice_items WHERE invoice_id = ?').all(s.invoice_id)) {
      billing.removeItem(s.invoice_id, it.id, req.user);
    }
    db.prepare("UPDATE sessions SET status = 'ended', ended_at = ?, minutes = 0, time_amount = 0, closed_by = ? WHERE id = ?").run(now, req.user.id, s.id);
    db.prepare("UPDATE invoices SET status = 'void', void_reason = ?, closed_at = ? WHERE id = ?").run(str(req.body.reason) || 'cancelled', now, s.invoice_id);
    audit(req.user.id, 'session.cancel', { session: s.id, reason: req.body.reason });
    const cname = db.prepare('SELECT name FROM consoles WHERE id = ?').get(s.console_id)?.name;
    const played = Math.round(s.segments.reduce((a, g) => a + ((g.end_at || now) - g.start_at), 0) / 60000);
    tg.notify('important', `❌ إلغاء جلسة بدون حساب — ${cname} (${played} د)\nالسبب: ${str(req.body.reason) || '-'} — بواسطة ${req.user.name}`);
  });
  res.json({ ok: true });
}));

r.get('/sessions', h((req, res) => {
  const limit = Math.min(500, int(req.query.limit, 100));
  res.json(db.prepare(`SELECT s.*, c.name console_name, i.total, i.paid, i.status invoice_status FROM sessions s
    JOIN consoles c ON c.id = s.console_id LEFT JOIN invoices i ON i.id = s.invoice_id
    WHERE s.status = 'ended' ORDER BY s.ended_at DESC LIMIT ?`).all(limit));
}));

module.exports = r;
