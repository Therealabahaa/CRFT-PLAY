const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.PSM_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'cyber.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'cashier',          -- admin | cashier
  perms TEXT NOT NULL DEFAULT '[]',              -- JSON array of extra permissions for cashiers
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS consoles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'PS5',              -- PS4 | PS5 | other
  room TEXT NOT NULL DEFAULT 'regular',          -- regular | vip
  screen TEXT,
  rate_single REAL NOT NULL DEFAULT 0,           -- EGP / hour, up to 2 controllers
  rate_multi REAL NOT NULL DEFAULT 0,            -- EGP / hour, 3+ controllers
  controllers INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'active',         -- active | maintenance
  notes TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  console_type TEXT,                             -- null = any
  room TEXT,                                     -- null = any
  minutes INTEGER NOT NULL,
  price REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  opened_at INTEGER NOT NULL,
  opening_cash REAL NOT NULL DEFAULT 0,
  closed_at INTEGER,
  closed_by INTEGER REFERENCES users(id),
  expected_cash REAL,
  counted_cash REAL,
  difference REAL,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  console_id INTEGER NOT NULL REFERENCES consoles(id),
  invoice_id INTEGER,
  customer_id INTEGER REFERENCES customers(id),
  customer_name TEXT,
  package_id INTEGER REFERENCES packages(id),
  package_minutes INTEGER,
  package_price REAL,
  planned_minutes INTEGER,                       -- countdown alert (optional)
  players INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'active',         -- active | paused | ended
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  minutes REAL,
  time_amount REAL,
  opened_by INTEGER REFERENCES users(id),
  closed_by INTEGER REFERENCES users(id),
  notes TEXT
);
CREATE TABLE IF NOT EXISTS session_segments (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  console_id INTEGER NOT NULL REFERENCES consoles(id),
  players INTEGER NOT NULL,
  rate REAL NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                            -- session | sale
  session_id INTEGER REFERENCES sessions(id),
  customer_id INTEGER REFERENCES customers(id),
  shift_id INTEGER REFERENCES shifts(id),
  user_id INTEGER REFERENCES users(id),
  time_amount REAL NOT NULL DEFAULT 0,
  items_amount REAL NOT NULL DEFAULT 0,
  items_cost REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  paid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',           -- open | closed | void
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  void_reason TEXT
);
CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  product_id INTEGER REFERENCES products(id),
  name TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER REFERENCES invoices(id),
  customer_id INTEGER REFERENCES customers(id),
  shift_id INTEGER REFERENCES shifts(id),
  user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL,                            -- invoice | debt | refund
  method TEXT NOT NULL DEFAULT 'cash',           -- cash | card | wallet | instapay
  amount REAL NOT NULL,                          -- negative for refunds
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS customer_ledger (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount REAL NOT NULL,                          -- + debt added, - debt paid
  invoice_id INTEGER REFERENCES invoices(id),
  payment_id INTEGER REFERENCES payments(id),
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  cost_price REAL NOT NULL DEFAULT 0,
  sell_price REAL NOT NULL DEFAULT 0,
  stock REAL NOT NULL DEFAULT 0,
  low_stock REAL NOT NULL DEFAULT 5,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  type TEXT NOT NULL,                            -- purchase | sale | waste | adjust | return
  qty REAL NOT NULL,                             -- signed
  unit_cost REAL,
  supplier TEXT,
  note TEXT,
  invoice_id INTEGER,
  user_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,                        -- rent | electricity | internet | maintenance | controllers | salaries | supplies | other
  amount REAL NOT NULL,
  note TEXT,
  spent_at INTEGER NOT NULL,
  from_drawer INTEGER NOT NULL DEFAULT 0,        -- paid from the cash drawer during a shift
  shift_id INTEGER REFERENCES shifts(id),
  user_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY,
  console_id INTEGER NOT NULL REFERENCES consoles(id),
  customer_id INTEGER REFERENCES customers(id),
  customer_name TEXT NOT NULL,
  phone TEXT,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked',         -- booked | arrived | cancelled | no_show
  notes TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,                          -- login | logout
  success INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tg_log (
  id INTEGER PRIMARY KEY,
  kind TEXT,
  text TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_segments_session ON session_segments(session_id);
CREATE INDEX IF NOT EXISTS idx_invoices_closed ON invoices(closed_at);
CREATE INDEX IF NOT EXISTS idx_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_shift ON payments(shift_id);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_customer ON customer_ledger(customer_id);
CREATE INDEX IF NOT EXISTS idx_moves_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_expenses_spent ON expenses(spent_at);
CREATE INDEX IF NOT EXISTS idx_res_start ON reservations(start_at);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  rate_single REAL NOT NULL DEFAULT 0,           -- EGP / hour for the room (0 = use each console's own price)
  rate_multi REAL NOT NULL DEFAULT 0,
  notes TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);
`);

// ---- small migrations for databases created by older versions ----
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('consoles', 'room_id', 'INTEGER REFERENCES rooms(id)');
addColumn('packages', 'room_id', 'INTEGER');
addColumn('sessions', 'discount_pct', 'REAL NOT NULL DEFAULT 0'); // % off the playtime charge, set while playing
addColumn('invoices', 'edited_at', 'INTEGER');       // last time items were changed after payment
addColumn('invoices', 'edit_count', 'INTEGER NOT NULL DEFAULT 0');
// Rooms are the unit you rent, with ONE fixed hourly price (no consoles, no single/multi):
// a console that sat inside a priced room becomes that room (its name + price); the old room groups go away.
if (!db.prepare("SELECT value FROM settings WHERE key = 'rooms_simple'").get()) {
  const rooms = db.prepare('SELECT * FROM rooms WHERE deleted = 0').all();
  for (const r of rooms) {
    const inside = db.prepare('SELECT * FROM consoles WHERE room_id = ? AND deleted = 0').all(r.id);
    for (const c of inside) {
      const price = r.rate_single > 0 ? r.rate_single : c.rate_single;
      db.prepare('UPDATE consoles SET name = ?, rate_single = ?, rate_multi = ?, room_id = NULL WHERE id = ?')
        .run(inside.length === 1 ? r.name : `${r.name} — ${c.name}`, price, price, c.id);
    }
    db.prepare('UPDATE rooms SET deleted = 1 WHERE id = ?').run(r.id);
  }
  db.prepare('UPDATE consoles SET rate_multi = rate_single, room_id = NULL').run();
  db.prepare('UPDATE packages SET room_id = NULL, console_type = NULL').run();
  db.prepare("INSERT INTO settings(key, value) VALUES('rooms_simple', '1')").run();
}
// End of shift (Kur style): card machine and online payments are counted too, not only the cash drawer
for (const c of ['expected_card', 'expected_online', 'counted_card', 'counted_online', 'card_difference', 'online_difference']) addColumn('shifts', c, 'REAL');
db.exec(`CREATE TABLE IF NOT EXISTS cash_moves (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  amount REAL NOT NULL,                          -- + cash put in (e.g. change), − cash taken out (e.g. the owner took money)
  reason TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
)`);

const DEFAULT_SETTINGS = {
  shop_name: 'My lounge',   // a shop that ran as PlayStation Cyber already has its own name saved; this is only for a brand-new one
  receipt_logo: '',         // the shop's logo at the top of every slip (Settings → Printing): a black-and-white PNG data: URL, '' = none
  language: 'ar',           // default UI language for devices that haven't chosen one
  currency: 'EGP',
  round_to: '1',            // round the time charge up to this many EGP
  min_minutes: '0',         // minimum charged minutes per session
  grace_minutes: '0',       // first N minutes free (e.g. switching controllers)
  backup_every_hours: '6',
  backup_keep: '30',
  backup_dir: '',
  receipt_footer: '',
  receipt_header: '',       // address / phone printed under the shop name
  auto_print: '1',          // print the receipt automatically after every payment
  printer: '',              // '' = Windows default, '__ask' = show the print window, else a printer name
  paper: '80',              // 80 | 58 mm
  print_mode: 'direct',     // direct (ESC/POS picture, no driver problems) | driver
  open_drawer_on_cash: '0', // kick the cash drawer when a cash payment is taken
  max_discount_pct: '20',   // biggest discount (% of the bill) a cashier can give without the "unlimited discount" permission
  max_discount_egp: '',     // …and in EGP per bill ('' = no money limit)
};
// Settings that must never reach the page (e.g. the Telegram bot token). Read them with secret().
const SECRET_PREFIX = 'tg_';

const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const putSetting = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  if (!getSetting.get(k)) putSetting.run(k, v);
}

function settings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) if (!r.key.startsWith(SECRET_PREFIX)) out[r.key] = r.value;
  return out;
}
function secret(key, fallback = null) {
  const r = getSetting.get(SECRET_PREFIX + key);
  return r ? r.value : fallback;
}
function setSecret(key, value) {
  putSetting.run(SECRET_PREFIX + key, String(value ?? ''));
}
function setSettings(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (k in DEFAULT_SETTINGS) putSetting.run(k, String(v ?? ''));
  }
}

// Run fn inside a transaction; rolls back if it throws.
// Side effects that must only happen if the data was really saved (Telegram alerts…) go through onCommit().
let inTx = false;
let afterCommit = [];
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  inTx = true;
  afterCommit = [];
  try {
    const result = fn();
    db.exec('COMMIT');
    inTx = false;
    const todo = afterCommit;
    afterCommit = [];
    for (const f of todo) { try { f(); } catch { /* a side effect must never break the request */ } }
    return result;
  } catch (err) {
    inTx = false;
    afterCommit = []; // rolled back: forget the side effects too
    db.exec('ROLLBACK');
    throw err;
  }
}
function onCommit(fn) {
  if (inTx) afterCommit.push(fn);
  else { try { fn(); } catch { /* ignore */ } }
}

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

function audit(userId, action, details) {
  db.prepare('INSERT INTO audit_log(user_id, action, details, created_at) VALUES(?, ?, ?, ?)')
    .run(userId ?? null, action, details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)), Date.now());
}

module.exports = { db, DB_PATH, DATA_DIR, settings, setSettings, secret, setSecret, tx, onCommit, money, audit };
