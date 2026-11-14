const express = require('express');
const { db, tx, money, audit, settings, setSettings } = require('../db');
const { h, bad, notFound, forbidden, int, num, str, range, HttpError } = require('../util');
const { requirePerm, PERMS, hashPassword, verifyPassword, isDefaultPassword, publicUser, createToken } = require('../auth');
const backup = require('../backup');
const tg = require('../telegram');

const pub = express.Router();   // no auth
const r = express.Router();     // authenticated

/* ---------- Login (staff picker + password, same flow as Kur / Iki) ---------- */
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;
const failures = new Map(); // user_id -> { count, until }

function logLogin(userId, userName, action, success, reason = null) {
  db.prepare('INSERT INTO login_log(user_id, user_name, action, success, reason, created_at) VALUES(?,?,?,?,?,?)')
    .run(userId ?? null, userName || null, action, success ? 1 : 0, reason, Date.now());
  // keep the log bounded
  db.prepare('DELETE FROM login_log WHERE id <= (SELECT MAX(id) FROM login_log) - 5000').run();
}

// Everything the sign-in screen needs: who can sign in and whose shift is open.
pub.get('/login-info', h((req, res) => {
  const shift = db.prepare(`SELECT s.id, s.opened_at, u.name owner_name FROM shifts s JOIN users u ON u.id = s.user_id
    WHERE s.closed_at IS NULL ORDER BY s.id DESC LIMIT 1`).get() || null;
  const admin = db.prepare("SELECT password_hash FROM users WHERE username = 'admin' AND active = 1").get();
  res.json({
    shop_name: settings().shop_name,
    language: settings().language,
    staff: db.prepare("SELECT id, name, role FROM users WHERE active = 1 ORDER BY role = 'admin' DESC, name").all(),
    open_shift: shift,
    default_admin: !!(admin && isDefaultPassword(admin.password_hash)),
  });
}));

pub.post('/login', h((req, res) => {
  const b = req.body || {};
  // Sign in by picking a name (user_id); username is still accepted for scripts/tests.
  const u = b.user_id
    ? db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(int(b.user_id))
    : db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(b.username || '').trim().toLowerCase());
  const key = u ? u.id : `name:${b.username || b.user_id}`;
  const f = failures.get(key);
  if (f && f.count >= MAX_FAILS && Date.now() < f.until) {
    logLogin(u?.id, u?.name || b.username, 'login', false, 'locked');
    throw new HttpError(429, 'too_many_attempts', { wait: Math.ceil((f.until - Date.now()) / 1000) });
  }
  if (!u || !verifyPassword(b.password || '', u.password_hash)) {
    const count = (f && Date.now() < f.until ? f.count : 0) + 1;
    failures.set(key, { count, until: Date.now() + LOCK_MS });
    logLogin(u?.id, u?.name || b.username, 'login', false, 'wrong_password');
    throw bad(u ? 'wrong_password_login' : 'invalid_login', { left: Math.max(0, MAX_FAILS - count) });
  }
  failures.delete(key);
  const token = createToken(u.id);
  const shift = db.prepare('SELECT id FROM shifts WHERE closed_at IS NULL').get();
  logLogin(u.id, u.name, 'login', true, shift ? `shift #${shift.id}` : null);
  res.setHeader('Set-Cookie', `psm_token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${14 * 24 * 3600}`);
  res.json({ token, user: publicUser(u), default_password: isDefaultPassword(u.password_hash), needs_shift: !shift && u.role !== 'admin' });
}));

r.post('/logout', h((req, res) => {
  db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(req.token);
  logLogin(req.user.id, req.user.name, 'logout', true);
  res.setHeader('Set-Cookie', 'psm_token=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
}));

r.get('/login-log', requirePerm('manage'), h((req, res) => {
  res.json(db.prepare('SELECT * FROM login_log ORDER BY id DESC LIMIT 300').all());
}));

r.get('/me', h((req, res) => {
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const st = settings();
  res.json({ user: req.user, default_password: isDefaultPassword(u.password_hash), shop_name: st.shop_name, currency: st.currency,
    discount_limit: require('../billing').discountLimit(req.user) });
}));

r.post('/me/password', h((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(req.body.current || '', u.password_hash)) throw bad('wrong_password');
  if (String(req.body.password || '').length < 4) throw bad('password_too_short');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), u.id);
  audit(u.id, 'password.change', null);
  res.json({ ok: true });
}));

/* ---------- Rooms (Room 1, Room 2, VIP… each with its own hourly price) ---------- */
r.get('/rooms', h((req, res) => res.json(db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM consoles c WHERE c.room_id = r.id AND c.deleted = 0) consoles
  FROM rooms r WHERE r.deleted = 0 ORDER BY r.id`).all())));

r.post('/rooms', requirePerm('manage'), h((req, res) => {
  const b = req.body || {};
  const name = str(b.name);
  if (!name) throw bad('name_required');
  const vals = [name, money(b.rate_single), money(b.rate_multi), str(b.notes)];
  let id = int(b.id, null);
  if (id) {
    const old = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!old) throw notFound();
    db.prepare('UPDATE rooms SET name=?, rate_single=?, rate_multi=?, notes=? WHERE id = ?').run(...vals, id);
    audit(req.user.id, 'room.update', { room: name, rate_single: [old.rate_single, vals[1]], rate_multi: [old.rate_multi, vals[2]] });
  } else {
    id = Number(db.prepare('INSERT INTO rooms(name, rate_single, rate_multi, notes) VALUES(?,?,?,?)').run(...vals).lastInsertRowid);
    audit(req.user.id, 'room.create', { room: name, rate_single: vals[1], rate_multi: vals[2] });
  }
  res.json(db.prepare('SELECT * FROM rooms WHERE id = ?').get(id));
}));

// Deleting a room keeps its consoles: they move back to the main hall (their own price).
r.delete('/rooms/:id', requirePerm('manage'), h((req, res) => {
  const id = int(req.params.id);
  tx(() => {
    db.prepare('UPDATE consoles SET room_id = NULL WHERE room_id = ?').run(id);
    db.prepare('UPDATE packages SET room_id = NULL WHERE room_id = ?').run(id);
    db.prepare('UPDATE rooms SET deleted = 1 WHERE id = ?').run(id);
  });
  audit(req.user.id, 'room.delete', { id });
  res.json({ ok: true });
}));

/* ---------- Consoles ---------- */
r.get('/consoles', h((req, res) => res.json(db.prepare(`SELECT c.*, r.name room_name FROM consoles c LEFT JOIN rooms r ON r.id = c.room_id AND r.deleted = 0
  WHERE c.deleted = 0 ORDER BY c.id`).all())));

r.post('/consoles', requirePerm('manage'), h((req, res) => {
  const b = req.body || {};
  const name = str(b.name);
  if (!name) throw bad('name_required');
  const roomId = int(b.room_id, null) || null;
  if (roomId && !db.prepare('SELECT id FROM rooms WHERE id = ? AND deleted = 0').get(roomId)) throw notFound('room_not_found');
  // a room has one fixed hourly price: rate_multi always equals rate_single
  const vals = [name, b.type || 'PS5', roomId, str(b.screen), money(b.rate_single), money(b.rate_single), int(b.controllers, 2),
    b.status === 'maintenance' ? 'maintenance' : 'active', str(b.notes)];
  let id = int(b.id, null);
  if (id) {
    const old = db.prepare('SELECT * FROM consoles WHERE id = ?').get(id);
    if (!old) throw notFound();
    db.prepare('UPDATE consoles SET name=?, type=?, room_id=?, screen=?, rate_single=?, rate_multi=?, controllers=?, status=?, notes=? WHERE id = ?').run(...vals, id);
    audit(req.user.id, 'console.update', { console: name, rate_single: [old.rate_single, vals[4]], rate_multi: [old.rate_multi, vals[5]], status: vals[7] });
  } else {
    id = Number(db.prepare('INSERT INTO consoles(name, type, room_id, screen, rate_single, rate_multi, controllers, status, notes) VALUES(?,?,?,?,?,?,?,?,?)').run(...vals).lastInsertRowid);
    audit(req.user.id, 'console.create', { console: name });
  }
  res.json(db.prepare('SELECT * FROM consoles WHERE id = ?').get(id));
}));

r.delete('/consoles/:id', requirePerm('manage'), h((req, res) => {
  const id = int(req.params.id);
  if (db.prepare("SELECT id FROM sessions WHERE console_id = ? AND status != 'ended'").get(id)) throw bad('console_busy');
  db.prepare('UPDATE consoles SET deleted = 1 WHERE id = ?').run(id);
  audit(req.user.id, 'console.delete', { id });
  res.json({ ok: true });
}));

/* ---------- Packages ---------- */
r.get('/packages', h((req, res) => res.json(db.prepare(`SELECT p.*, r.name room_name FROM packages p LEFT JOIN rooms r ON r.id = p.room_id
  ORDER BY p.active DESC, p.minutes`).all())));

r.post('/packages', requirePerm('manage'), h((req, res) => {
  const b = req.body || {};
  const name = str(b.name);
  const minutes = int(b.minutes, 0);
  if (!name || !(minutes > 0)) throw bad('name_required');
  const vals = [name, str(b.console_type), int(b.room_id, null) || null, minutes, money(b.price), b.active === false ? 0 : 1];
  let id = int(b.id, null);
  if (id) db.prepare('UPDATE packages SET name=?, console_type=?, room_id=?, minutes=?, price=?, active=? WHERE id = ?').run(...vals, id);
  else id = Number(db.prepare('INSERT INTO packages(name, console_type, room_id, minutes, price, active) VALUES(?,?,?,?,?,?)').run(...vals).lastInsertRowid);
  audit(req.user.id, 'package.save', { name, minutes, price: vals[4] });
  res.json(db.prepare('SELECT * FROM packages WHERE id = ?').get(id));
}));

/* ---------- Users ---------- */
r.get('/users', requirePerm('manage'), h((req, res) => res.json(db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser))));

r.post('/users', requirePerm('manage'), h((req, res) => {
  const b = req.body || {};
  const name = str(b.name);
  if (!name) throw bad('name_required');
  // Staff sign in by picking their name, so a username is optional (kept for scripts) — make one up when missing.
  let username = String(b.username || '').trim().toLowerCase();
  if (!username) {
    const existing = int(b.id, null) && db.prepare('SELECT username FROM users WHERE id = ?').get(int(b.id));
    username = existing ? existing.username : `staff${Date.now().toString(36)}`;
  }
  const role = b.role === 'admin' ? 'admin' : 'cashier';
  if (role === 'admin' && req.user.role !== 'admin') throw bad('only_admin_can_create_admin');
  const perms = JSON.stringify((b.perms || []).filter((p) => PERMS.includes(p)));
  let id = int(b.id, null);
  tx(() => {
    if (id) {
      const old = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!old) throw notFound();
      // only an owner (admin) may touch an owner's account: role, password or switching it off
      if (old.role === 'admin' && req.user.role !== 'admin') throw forbidden('only_admin_can_edit_admin');
      if (old.role === 'admin' && (role !== 'admin' || b.active === false)) {
        const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND active = 1").get().c;
        if (admins <= 1) throw bad('last_admin');
      }
      db.prepare('UPDATE users SET username=?, name=?, role=?, perms=?, active=? WHERE id = ?').run(username, name, role, perms, b.active === false ? 0 : 1, id);
      if (b.password) {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), id);
        db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(id);
      }
      if (b.active === false) db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(id);
    } else {
      if (String(b.password || '').length < 4) throw bad('password_too_short');
      if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) throw bad('username_taken');
      id = Number(db.prepare('INSERT INTO users(username, name, password_hash, role, perms, active, created_at) VALUES(?,?,?,?,?,?,?)')
        .run(username, name, hashPassword(b.password), role, perms, 1, Date.now()).lastInsertRowid);
    }
    audit(req.user.id, 'user.save', { username, role, perms: JSON.parse(perms), active: b.active !== false });
  });
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
}));

/* ---------- Settings ---------- */
r.get('/settings', h((req, res) => res.json(settings())));
r.put('/settings', requirePerm('manage'), h((req, res) => {
  const logo = (req.body || {}).receipt_logo;   // '' removes it; otherwise the black-and-white picture the Settings page made
  if (logo !== undefined && logo !== '' && !(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(logo)) && String(logo).length <= 400000)) throw bad('logo_invalid');
  setSettings(req.body || {});
  audit(req.user.id, 'settings.update', logo ? { ...req.body, receipt_logo: '(new picture)' } : req.body);   // not the picture itself in the log
  res.json(settings());
}));

/* ---------- Backups ---------- */
r.get('/backups', requirePerm('manage'), h((req, res) => res.json({ dir: backup.backupDir(), files: backup.list() })));
r.post('/backups', requirePerm('manage'), h((req, res) => {
  const name = backup.run('manual');
  audit(req.user.id, 'backup.create', { name });
  res.json({ name });
}));
r.get('/backups/:name', requirePerm('manage'), h((req, res) => {
  const p = backup.filePath(req.params.name);
  if (!p) throw notFound();
  res.download(p);
}));

/* ---------- Telegram (owner alerts + bot) ---------- */
r.get('/telegram', requirePerm('manage'), h((req, res) => res.json(tg.publicConfig())));
r.put('/telegram', requirePerm('manage'), h((req, res) => {
  const b = req.body || {};
  tg.saveConfig({ token: b.token, chat: b.chat, important: b.important, low_stock: b.low_stock, shift_report: b.shift_report, commands: b.commands });
  audit(req.user.id, 'telegram.update', { chat: b.chat, token_changed: !!b.token });
  res.json(tg.publicConfig());
}));
r.post('/telegram/find-chat', requirePerm('manage'), h(async (req, res) => {
  try { res.json(await tg.findChat(req.body.token)); } catch (e) { throw bad('tg_' + String(e.message || e).replace(/\W+/g, '_').slice(0, 60)); }
}));
r.post('/telegram/test', requirePerm('manage'), h(async (req, res) => {
  let r2;
  try { r2 = await tg.test(); } catch (e) { throw bad('tg_' + String(e.message || e)); }
  res.json(r2);
}));

/* ---------- Audit log ---------- */
r.get('/audit', requirePerm('manage'), h((req, res) => {
  const { from, to } = range(req.query);
  const args = [from, to];
  let extra = '';
  if (req.query.user_id) { extra = ' AND a.user_id = ?'; args.push(int(req.query.user_id)); }
  res.json(db.prepare(`SELECT a.*, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.created_at BETWEEN ? AND ? ${extra} ORDER BY a.id DESC LIMIT 2000`).all(...args));
}));

module.exports = { pub, router: r };
