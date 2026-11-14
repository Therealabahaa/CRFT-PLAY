const { db } = require('./db');

class HttpError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const bad = (code, extra) => new HttpError(400, code, extra);
const notFound = (code = 'not_found') => new HttpError(404, code);
const forbidden = (code = 'forbidden') => new HttpError(403, code);

// Wrap a sync/async handler so thrown errors become JSON responses.
const h = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
};

function currentShift() {
  return db.prepare('SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').get() || null;
}
function requireShift() {
  const s = currentShift();
  if (!s) throw bad('no_open_shift');
  return s;
}

const num = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const int = (v, def = null) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};
const str = (v) => (v == null ? null : String(v).trim() || null);

// Date range from query: from/to as YYYY-MM-DD (local), inclusive. Defaults to today.
function range(q) {
  const parse = (s, endOfDay) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
    if (!m) d.setHours(0, 0, 0, 0);
    if (endOfDay) d.setHours(23, 59, 59, 999);
    return d.getTime();
  };
  const from = parse(q.from, false);
  const to = parse(q.to || q.from, true);
  return { from, to: Math.max(from, to) };
}

module.exports = { HttpError, bad, notFound, forbidden, h, currentShift, requireShift, num, int, str, range };
