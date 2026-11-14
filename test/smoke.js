// End-to-end smoke test against a throwaway database: node test/smoke.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psm-test-'));
process.env.PSM_DATA_DIR = dir;
process.env.PSM_NO_BACKUP = '1';
process.env.PSM_NO_TG = '1';
process.env.PORT = '0';

const { start: startServer } = require('../server');
const { db } = require('../src/db');

let base;
let server;
let token;
async function api(method, url, body, expectStatus = 200) {
  const res = await fetch(base + '/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.arrayBuffer();
  assert.strictEqual(res.status, expectStatus, `${method} ${url} -> ${res.status} ${JSON.stringify(isJson ? data : '')}`);
  return data;
}
// Shift a session's segments into the past so it has played time.
function rewind(sessionId, minutes) {
  db.prepare('UPDATE session_segments SET start_at = start_at - ?, end_at = CASE WHEN end_at IS NULL THEN NULL ELSE end_at - ? END WHERE session_id = ?')
    .run(minutes * 60000, minutes * 60000, sessionId);
  db.prepare('UPDATE sessions SET started_at = started_at - ? WHERE id = ?').run(minutes * 60000, sessionId);
}

async function main() {
  ({ server } = await startServer(0));
  base = `http://127.0.0.1:${server.address().port}`;

  await api('POST', '/login', { username: 'admin', password: 'wrong' }, 400);
  const login = await api('POST', '/login', { username: 'admin', password: 'admin' });
  token = login.token;
  assert.ok(login.default_password);

  const floor = await api('GET', '/floor');
  assert.strictEqual(floor.consoles.length, 6);
  const ps5 = floor.consoles.find((c) => c.name === 'PS5 - 1');
  const ps4 = floor.consoles.find((c) => c.name === 'PS4 - 1');
  const products = await api('GET', '/products');
  const pepsi = products.find((p) => p.name === 'بيبسي');

  // Payments need an open shift.
  await api('POST', '/sales', { items: [{ product_id: pepsi.id, qty: 1 }], payments: [{ method: 'cash', amount: 20 }] }, 400);
  await api('POST', '/shifts/open', { opening_cash: 500 });
  await api('POST', '/shifts/open', { opening_cash: 500 }, 400);

  // Session: 60 min single on PS5 (40/h) then 30 min multi (55/h) on PS4 (35/h multi).
  let s = await api('POST', '/sessions', { console_id: ps5.id, players: 2, customer_name: 'Ahmed' });
  await api('POST', '/sessions', { console_id: ps5.id }, 400); // busy
  rewind(s.id, 60);
  await api('POST', '/sessions/' + s.id + '/pause');
  await api('POST', '/sessions/' + s.id + '/resume');
  s = await api('POST', '/sessions/' + s.id + '/players', { players: 4 });
  s = await api('POST', '/sessions/' + s.id + '/move', { console_id: ps4.id });
  assert.strictEqual(s.console_id, ps4.id);
  // 30 minutes on PS4 multi
  db.prepare('UPDATE session_segments SET start_at = start_at - ? WHERE session_id = ? AND end_at IS NULL').run(30 * 60000, s.id);
  s = await api('POST', '/sessions/' + s.id + '/items', { product_id: pepsi.id, qty: 2 });
  assert.strictEqual(s.items_amount, 40);
  assert.ok(Math.abs(s.time_amount - (40 + 12.5)) <= 1, 'time amount ' + s.time_amount); // 1 h at 40 + 30 min at 25 (one fixed price per room), rounded up

  const cust = await api('POST', '/customers', { name: 'Ahmed', phone: '01000000000' });
  // Unpaid remainder without a customer is rejected.
  await api('POST', '/sessions/' + s.id + '/checkout', { payments: [{ method: 'cash', amount: 50 }] }, 400);
  const inv = await api('POST', '/sessions/' + s.id + '/checkout', {
    discount: 3, customer_id: cust.id, payments: [{ method: 'cash', amount: 50 }, { method: 'wallet', amount: 30 }],
  });
  const total = inv.time_amount + 40 - 3;
  assert.strictEqual(inv.total, total);
  assert.strictEqual(inv.paid, 80);
  let c = await api('GET', '/customers/' + cust.id);
  assert.strictEqual(c.balance, total - 80);

  // Quick sale + refund.
  const sale = await api('POST', '/sales', { items: [{ product_id: pepsi.id, qty: 1 }], payments: [{ method: 'cash', amount: 20 }] });
  await api('POST', '/sales', { items: [{ product_id: pepsi.id, qty: 999 }], payments: [] }, 400);
  await api('POST', '/invoices/' + sale.id + '/refund', { reason: 'wrong item' });
  let p = (await api('GET', '/products')).find((x) => x.id === pepsi.id);
  assert.strictEqual(p.stock, 24 - 2);

  // Debt payment.
  await api('POST', '/customers/' + cust.id + '/pay', { amount: 1000, method: 'cash' }, 400);
  await api('POST', '/customers/' + cust.id + '/pay', { amount: c.balance, method: 'cash' });
  c = await api('GET', '/customers/' + cust.id);
  assert.strictEqual(c.balance, 0);

  // Inventory: purchase with weighted cost, waste, count.
  p = await api('POST', '/products/' + pepsi.id + '/purchase', { qty: 22, unit_cost: 15, supplier: 'Pepsi Co', from_drawer: true });
  assert.strictEqual(p.stock, 44);
  assert.strictEqual(p.cost_price, 14);
  p = await api('POST', '/products/' + pepsi.id + '/waste', { qty: 2, note: 'broken' });
  p = await api('POST', '/products/' + pepsi.id + '/count', { stock: 41 });
  assert.strictEqual(p.stock, 41);

  // Expenses.
  await api('POST', '/expenses', { category: 'electricity', amount: 300 });
  await api('POST', '/expenses', { category: 'maintenance', amount: 50, from_drawer: true, note: 'controller stick' });

  // Package session with overtime: 120 min for 70, played 130 min single on PS5 (40/h) -> 70 + 10/60*40 = 76.67 -> 77
  const pkg = floor.packages.find((x) => x.minutes === 120);
  let s2 = await api('POST', '/sessions', { console_id: ps5.id, package_id: pkg.id });
  rewind(s2.id, 130);
  s2 = await api('GET', '/sessions/' + s2.id);
  assert.strictEqual(s2.time_amount, 77);
  await api('POST', '/sessions/' + s2.id + '/checkout', { payments: [{ method: 'card', amount: 77 }] });

  // Cancel a mistaken session.
  const s3 = await api('POST', '/sessions', { console_id: ps5.id });
  await api('POST', '/sessions/' + s3.id + '/cancel', { reason: 'wrong console' });

  // Reservations with conflict detection.
  const start = Date.now() + 3600000;
  await api('POST', '/reservations', { console_id: ps5.id, customer_name: 'Omar', start_at: start, minutes: 120 });
  await api('POST', '/reservations', { console_id: ps5.id, customer_name: 'Ali', start_at: start + 3600000, minutes: 60 }, 400);

  // Shift close: expected = 500 opening + 50 cash + 20 sale - 20 refund + debt cash - 330 stock - 50 maintenance
  const cur = await api('GET', '/shifts/current');
  const expected = 500 + 50 + 20 - 20 + (total - 80) - 330 - 50;
  assert.strictEqual(cur.expected_cash, expected);
  const closed = await api('POST', '/shifts/close', { counted_cash: expected - 5 });
  assert.strictEqual(closed.difference, -5);

  // Reports & export.
  const rep = await api('GET', '/reports/summary');
  assert.strictEqual(rep.kpis.sessions, 2);
  assert.strictEqual(rep.kpis.expenses, 350);
  assert.ok(rep.consoles.length >= 2);
  const xlsx = await api('GET', '/reports/export');
  assert.ok(xlsx.byteLength > 5000);

  // Users & permissions.
  await api('POST', '/users', { username: 'mona', name: 'Mona', password: '1234', role: 'cashier', perms: [] });
  const admTok = token;
  token = (await api('POST', '/login', { username: 'mona', password: '1234' })).token;
  await api('GET', '/reports/summary', null, 403);
  await api('POST', '/consoles', { name: 'x' }, 403);
  await api('POST', '/shifts/open', { opening_cash: 0 });
  const s4 = await api('POST', '/sessions', { console_id: ps5.id });
  // Discount limits: the owner allows cashiers 20% / 10 EGP per bill.
  const lim = (await api('GET', '/me')).discount_limit;
  assert.ok(!lim.unlimited && lim.pct === 20);
  await api('POST', '/sessions/' + s4.id + '/discount', { pct: 50 }, 400);
  const s4d = await api('POST', '/sessions/' + s4.id + '/discount', { pct: 10 });
  assert.strictEqual(s4d.discount_pct, 10);
  await api('POST', '/sessions/' + s4.id + '/checkout', { discount: 5, payments: [] }, 400); // 5 EGP is way over 20% of a ~0 bill
  const billing = require('../src/billing');
  const cashierUser = { role: 'cashier', perms: [] };
  billing.checkDiscount(cashierUser, 20, 100); // 20% ok
  assert.throws(() => billing.checkDiscount(cashierUser, 21, 100), /discount_over_limit/);
  billing.checkDiscount({ role: 'cashier', perms: ['discount'] }, 90, 100); // unlimited permission
  token = admTok;
  await api('PUT', '/settings', { max_discount_egp: '10' });
  assert.throws(() => billing.checkDiscount(cashierUser, 15, 100), /discount_over_limit/); // 15% but over 10 EGP

  // Rooms: a name + ONE fixed price per hour — 4 players pay the same as 1.
  const room = await api('POST', '/consoles', { name: 'Room 2', rate_single: 100, rate_multi: 999 });
  assert.strictEqual(room.rate_multi, 100); // there is no separate multi price
  const s5 = await api('POST', '/sessions', { console_id: room.id, players: 4 });
  rewind(s5.id, 60);
  const roomCharge = (await api('GET', '/sessions/' + s5.id)).time_amount;
  assert.ok(roomCharge >= 100 && roomCharge <= 101, 'room price ' + roomCharge); // 1 h at 100/h (+ rounding up)
  await api('POST', '/sessions/' + s5.id + '/cancel', { reason: 'test' });

  // Inventory (Kur style): receive several products, count the whole shelf, fix a typing mistake.
  const water = products.find((x) => x.name === 'مياه');
  const rcv = await api('POST', '/inventory/receive', { supplier: 'Nestle', lines: [{ product_id: water.id, qty: 24, total_cost: 168 }, { product_id: pepsi.id, qty: 6, total_cost: 90 }] });
  assert.strictEqual(rcv.total, 258);
  let prods = await api('GET', '/products?all=1');
  assert.strictEqual(prods.find((x) => x.id === water.id).stock, 48);
  assert.strictEqual(prods.find((x) => x.id === water.id).cost_price, 6); // (24×5 + 24×7) / 48
  const cnt = await api('POST', '/inventory/count', { reason: 'counting', lines: [{ product_id: water.id, counted: 45 }, { product_id: pepsi.id, counted: '' }] });
  assert.strictEqual(cnt.lines.length, 1);
  assert.strictEqual(cnt.lines[0].difference, -3);
  await api('POST', '/products/' + water.id + '/count', { stock: 50, mode: 'entry' });
  prods = await api('GET', '/products?all=1');
  assert.strictEqual(prods.find((x) => x.id === water.id).stock, 50);
  assert.ok(prods.find((x) => x.id === water.id).last_count);
  const rep2 = await api('GET', '/reports/summary');
  assert.strictEqual(rep2.kpis.count_diff, -32); // 1 Pepsi × 14 counted earlier + 3 bottles × 6 EGP missing
  const moves = await api('GET', `/stock-movements?recent=1&product_id=${water.id}&limit=5`);
  assert.ok(moves.length >= 3 && moves.some((m) => m.type === 'correction'));

  // Login lockout: 5 wrong passwords -> locked for a minute, and it's all in the sign-in log.
  token = null;
  for (let i = 0; i < 5; i++) await api('POST', '/login', { username: 'mona', password: 'nope' }, 400);
  await api('POST', '/login', { username: 'mona', password: '1234' }, 429);
  const info = await api('GET', '/login-info');
  assert.ok(info.staff.some((s) => s.name === 'Mona'));
  assert.strictEqual(info.open_shift.owner_name, 'Mona');
  token = admTok;
  const log = await api('GET', '/login-log');
  assert.ok(log.filter((l) => !l.success).length >= 6);

  // Shift end (Kur style): cash in/out moves, and cash + card (Visa) + online counted separately.
  await api('POST', '/shifts/close', { counted_cash: '' }); // Mona's shift from above (the owner may close it; nothing counted)
  await api('POST', '/shifts/open', { opening_cash: 100 });
  let sh = await api('POST', '/shifts/move', { type: 'in', amount: 50, reason: 'change' });
  sh = await api('POST', '/shifts/move', { type: 'out', amount: 30, reason: 'owner took' });
  assert.strictEqual(sh.expected_cash, 120);
  const s6 = await api('POST', '/sessions', { console_id: floor.consoles.find((c) => c.name === 'PS5 - 3').id });
  await api('POST', '/sessions/' + s6.id + '/items', { product_id: pepsi.id, qty: 3 }); // 60
  const s6full = await api('GET', '/sessions/' + s6.id);
  const cashPart = s6full.total - 50; // 3 Pepsi (60) + a few seconds of playtime, minus card 30 and online 20
  await api('POST', '/sessions/' + s6.id + '/checkout', { at: s6full.priced_at, payments: [{ method: 'card', amount: 30 }, { method: 'online', amount: 20 }, { method: 'cash', amount: cashPart }] });
  sh = await api('GET', '/shifts/current');
  assert.strictEqual(sh.expected_card, 30);
  assert.strictEqual(sh.expected_online, 20);
  assert.strictEqual(sh.expected_cash, 120 + cashPart);
  const shc = await api('POST', '/shifts/close', { counted_cash: 115 + cashPart, counted_card: 30, counted_online: '' });
  assert.strictEqual(shc.difference, -5);
  assert.strictEqual(shc.card_difference, 0);
  assert.strictEqual(shc.online_difference, null); // left empty = not counted
  assert.ok(shc.moves.length === 2 && shc.top.length >= 1);

  // Telegram: token is saved but never sent to the page; the bot answers questions in Arabic.
  await api('PUT', '/telegram', { token: '123456:SECRET-TOKEN', chat: '-100555', important: true, low_stock: false });
  const tgc = await api('GET', '/telegram');
  assert.ok(tgc.token_set && tgc.chat === '-100555' && tgc.low_stock === false && !('token' in tgc));
  const st = await api('GET', '/settings');
  assert.ok(!JSON.stringify(st).includes('SECRET-TOKEN'), 'token leaked through /settings');
  const tg = require('../src/telegram');
  assert.ok(tg.answer('الأجهزة').includes('PS5 - 1'));
  assert.ok(tg.answer('تقرير').includes('الإيراد'));
  assert.ok(tg.answer('تقرير اسبوع').includes('آخر 7 أيام'));
  const shiftAns = tg.answer('وردية');
  assert.ok(shiftAns.includes('وردية') && shiftAns.includes('الفيزا'), shiftAns);
  assert.ok(tg.answer('مخزون').includes('بيبسي'));
  assert.ok(tg.answer('ديون').length > 5);
  assert.ok(tg.answer('/start').includes('الغرف'));
  assert.ok(tg.answer('الغرف').includes('PS5 - 1'));
  // Staff without a username (Kur style: name + role + password).
  const staff = await api('POST', '/users', { name: 'Karim', password: '5555', role: 'cashier', perms: ['discount'] });
  assert.ok(staff.username && staff.perms.includes('discount'));
  const edited = await api('POST', '/users', { id: staff.id, name: 'Karim A', role: 'cashier', perms: [] });
  assert.strictEqual(edited.name, 'Karim A');
  assert.strictEqual(edited.username, staff.username);

  // ---- regression tests for the code-review fixes ----
  const { tx, onCommit, money } = require('../src/db');
  // alerts queued in a transaction that rolls back are never sent
  let fired = 0;
  try { tx(() => { onCommit(() => fired++); throw new Error('boom'); }); } catch { /* expected */ }
  tx(() => { onCommit(() => fired++); });
  assert.strictEqual(fired, 1);

  await api('POST', '/shifts/open', { opening_cash: 0 });
  const roomA = (await api('GET', '/floor')).consoles.find((c) => !c.session && c.status === 'active');
  // the bill changed after the payment window opened -> refuse instead of making a silent debt
  let sx = await api('POST', '/sessions', { console_id: roomA.id });
  const shown = await api('GET', '/sessions/' + sx.id);
  await api('POST', '/sessions/' + sx.id + '/items', { product_id: water.id, qty: 1 }); // another device adds water
  const pc = await api('POST', '/sessions/' + sx.id + '/checkout', { at: shown.priced_at, expected_gross: shown.total, payments: [{ method: 'cash', amount: shown.total }] }, 400);
  assert.strictEqual(pc.error, 'price_changed');
  // split payment refunded the same way it was paid (card back to card, cash back to cash)
  const now2 = await api('GET', '/sessions/' + sx.id);
  const half = Math.round(now2.total / 2);
  const splitInv = await api('POST', '/sessions/' + sx.id + '/checkout', { at: now2.priced_at, expected_gross: now2.total, payments: [{ method: 'card', amount: half }, { method: 'cash', amount: now2.total - half }] });
  const shBefore = await api('GET', '/shifts/current');
  await api('POST', '/invoices/' + splitInv.id + '/refund', { reason: 'test' });
  const shAfter = await api('GET', '/shifts/current');
  assert.strictEqual(shAfter.expected_card, money(shBefore.expected_card - half));
  assert.strictEqual(shAfter.expected_cash, money(shBefore.expected_cash - (now2.total - half)));
  // refunding a credit bill the customer already partly paid: no negative balance, the paid part goes back in cash
  const cust2 = await api('POST', '/customers', { name: 'Credit test' });
  const creditSale = await api('POST', '/sales', { items: [{ product_id: water.id, qty: 10 }], payments: [], customer_id: cust2.id }); // 100 on credit
  await api('POST', '/customers/' + cust2.id + '/pay', { amount: 60, method: 'cash' });
  const cashBeforeRefund = (await api('GET', '/shifts/current')).expected_cash;
  await api('POST', '/invoices/' + creditSale.id + '/refund', { reason: 'test' });
  assert.strictEqual((await api('GET', '/customers/' + cust2.id)).balance, 0);
  assert.strictEqual((await api('GET', '/shifts/current')).expected_cash, money(cashBeforeRefund - 60));
  // a discount approved on the session by the owner can be checked out by a limited cashier
  sx = await api('POST', '/sessions', { console_id: roomA.id });
  rewind(sx.id, 60);
  await api('POST', '/sessions/' + sx.id + '/discount', { pct: 100 }); // owner: free
  await api('POST', '/users', { username: 'lim', name: 'Limited', password: '1111', role: 'cashier', perms: [] });
  token = (await api('POST', '/login', { username: 'lim', password: '1111' })).token;
  const sxFull = await api('GET', '/sessions/' + sx.id);
  const freeInv = await api('POST', '/sessions/' + sx.id + '/checkout', { at: sxFull.priced_at, expected_gross: sxFull.total, discount: sxFull.time_amount, payments: [] });
  assert.strictEqual(freeInv.total, 0);
  // a cashier can't open other cashiers' invoices from other shifts, nor edit an owner account
  await api('GET', '/invoices/1', null, 403);
  const ownerId = (await api('GET', '/login-info')).staff.find((x) => x.role === 'admin').id;
  token = admTok;
  const manager = await api('POST', '/users', { username: 'mgr', name: 'Manager', password: '2222', role: 'cashier', perms: ['manage'] });
  token = (await api('POST', '/login', { username: 'mgr', password: '2222' })).token;
  await api('POST', '/users', { id: ownerId, name: 'Owner', role: 'cashier', password: 'hacked' }, 403);
  token = admTok;
  void manager;

  // ---- edit a paid invoice: a forgotten drink is added, paid by Visa; then one is taken off and given back in cash ----
  const pepsiNow = (await api('GET', '/products')).find((x) => x.id === pepsi.id);
  const waterNow = (await api('GET', '/products')).find((x) => x.id === water.id);
  const sale1 = await api('POST', '/sales', { items: [{ product_id: pepsi.id, qty: 1 }], payments: [{ method: 'cash', amount: pepsiNow.sell_price }] });
  const cardBefore = (await api('GET', '/shifts/current')).expected_card;
  await api('POST', '/invoices/' + sale1.id + '/edit', { items: [{ product_id: pepsi.id, qty: 1 }], method: 'card', reason: 'x' }, 400); // nothing changed
  await api('POST', '/invoices/' + sale1.id + '/edit', { items: [{ product_id: pepsi.id, qty: 2 }], method: 'card' }, 400); // reason required
  const ed1 = await api('POST', '/invoices/' + sale1.id + '/edit', { items: [{ product_id: pepsi.id, qty: 2 }, { product_id: water.id, qty: 1 }], method: 'card', reason: 'forgot to ring up' });
  assert.strictEqual(ed1.difference, money(pepsiNow.sell_price + waterNow.sell_price));
  assert.strictEqual(ed1.invoice.total, money(pepsiNow.sell_price * 2 + waterNow.sell_price));
  assert.strictEqual(ed1.invoice.paid, ed1.invoice.total);
  assert.strictEqual(ed1.invoice.edit_count, 1);
  assert.strictEqual((await api('GET', '/shifts/current')).expected_card, money(cardBefore + ed1.difference));
  let prodsNow = await api('GET', '/products');
  assert.strictEqual(prodsNow.find((x) => x.id === pepsi.id).stock, pepsiNow.stock - 2);
  assert.strictEqual(prodsNow.find((x) => x.id === water.id).stock, waterNow.stock - 1);
  const cashBeforeEdit = (await api('GET', '/shifts/current')).expected_cash;
  const ed2 = await api('POST', '/invoices/' + sale1.id + '/edit', { items: [{ product_id: pepsi.id, qty: 2 }], method: 'cash', reason: 'water was a mistake' });
  assert.strictEqual(ed2.difference, -waterNow.sell_price);
  assert.strictEqual((await api('GET', '/shifts/current')).expected_cash, money(cashBeforeEdit - waterNow.sell_price));
  prodsNow = await api('GET', '/products');
  assert.strictEqual(prodsNow.find((x) => x.id === water.id).stock, waterNow.stock); // back on the shelf
  // more to pay, put on a customer's account
  const ed3 = await api('POST', '/invoices/' + sale1.id + '/edit', { items: [{ product_id: pepsi.id, qty: 3 }], method: 'credit', customer_id: cust2.id, reason: 'one more' });
  assert.strictEqual((await api('GET', '/customers/' + cust2.id)).balance, ed3.difference);

  // Backup.
  const b = await api('POST', '/backups');
  assert.ok(b.name.endsWith('.db'));
  const audit = await api('GET', '/audit');
  assert.ok(audit.length > 10);

  console.log('All smoke tests passed ✔');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => {
    if (server) server.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
