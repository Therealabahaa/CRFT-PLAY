const crypto = require('crypto');
const { db } = require('./db');

// Extra permissions a cashier can be granted. Admins have all of them.
const PERMS = ['discount', 'refund', 'inventory', 'expenses', 'reports', 'manage'];
const TOKEN_TTL = 1000 * 60 * 60 * 24 * 14;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

// "Is this still the factory password 'admin'?" — scrypt is slow and blocks the server,
// so the answer is remembered per password hash (a new hash = a changed password = checked again once).
const defaultCache = new Map();
function isDefaultPassword(hash) {
  if (!hash) return false;
  if (!defaultCache.has(hash)) {
    if (defaultCache.size > 200) defaultCache.clear();
    defaultCache.set(hash, verifyPassword('admin', hash));
  }
  return defaultCache.get(hash);
}

function publicUser(u) {
  let perms = [];
  try { perms = JSON.parse(u.perms || '[]'); } catch { perms = []; }
  if (u.role === 'admin') perms = PERMS.slice();
  return { id: u.id, username: u.username, name: u.name, role: u.role, perms, active: !!u.active };
}

function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (count === 0) {
    db.prepare('INSERT INTO users(username, name, password_hash, role, perms, created_at) VALUES(?,?,?,?,?,?)')
      .run('admin', 'Owner', hashPassword('admin'), 'admin', '[]', Date.now());
  }
}

function createToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO auth_tokens(token, user_id, created_at) VALUES(?,?,?)').run(token, userId, Date.now());
  db.prepare('DELETE FROM auth_tokens WHERE created_at < ?').run(Date.now() - TOKEN_TTL);
  return token;
}

function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)psm_token=([a-f0-9]+)/);
  return m ? m[1] : null;
}

function requireAuth(req, res, next) {
  const token = readToken(req);
  if (token) {
    const row = db.prepare(`SELECT u.* FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token = ? AND t.created_at > ? AND u.active = 1`).get(token, Date.now() - TOKEN_TTL);
    if (row) {
      req.user = publicUser(row);
      req.token = token;
      return next();
    }
  }
  res.status(401).json({ error: 'unauthorized' });
}

function can(user, perm) {
  return user && (user.role === 'admin' || user.perms.includes(perm));
}

function requirePerm(perm) {
  return (req, res, next) => (can(req.user, perm) ? next() : res.status(403).json({ error: 'forbidden' }));
}

module.exports = { PERMS, hashPassword, verifyPassword, isDefaultPassword, publicUser, seedAdmin, createToken, requireAuth, requirePerm, can };
