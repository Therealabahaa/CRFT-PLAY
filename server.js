const path = require('path');
const os = require('os');
const express = require('express');
const { db } = require('./src/db');
const { seedAdmin, requireAuth } = require('./src/auth');
const { HttpError } = require('./src/util');
const backup = require('./src/backup');

seedAdmin();
seedSamples();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

const admin = require('./src/routes/admin');
app.use('/api', admin.pub);
app.use('/api', requireAuth);
app.use('/api', admin.router);
app.use('/api', require('./src/routes/sessions'));
app.use('/api', require('./src/routes/cashier'));
app.use('/api', require('./src/routes/ops').router);
app.use('/api', require('./src/routes/reports'));
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, ...(err.extra || {}) });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
  console.error(err);
  res.status(500).json({ error: 'server_error', message: err.message });
});

function seedSamples() {
  if (db.prepare('SELECT COUNT(*) c FROM consoles').get().c > 0) return;
  // sample rooms — each is just a name and a fixed price per hour (edit them in Settings → Rooms & prices)
  const c = db.prepare('INSERT INTO consoles(name, type, rate_single, rate_multi) VALUES(?,?,?,?)');
  [['PS5 - 1', 'PS5', 40], ['PS5 - 2', 'PS5', 40], ['PS5 - 3', 'PS5', 40], ['PS4 - 1', 'PS4', 25], ['PS4 - 2', 'PS4', 25], ['VIP', 'PS5', 70]]
    .forEach(([name, type, price]) => c.run(name, type, price, price));
  const p = db.prepare('INSERT INTO packages(name, minutes, price) VALUES(?,?,?)');
  p.run('ساعتين', 120, 70);
  p.run('3 ساعات', 180, 100);
  const pr = db.prepare('INSERT INTO products(name, category, cost_price, sell_price, stock, low_stock) VALUES(?,?,?,?,?,?)');
  [['بيبسي', 'مشروبات', 13, 20, 24, 6], ['مياه', 'مشروبات', 5, 10, 24, 6], ['ريد بول', 'مشروبات', 45, 60, 12, 4],
    ['شاي', 'مشروبات ساخنة', 3, 10, 100, 10], ['قهوة', 'مشروبات ساخنة', 8, 20, 50, 10], ['شيبسي', 'سناكس', 8, 12, 30, 8]].forEach((r) => pr.run(...r));
}

function lanAddresses(port) {
  const out = [];
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs || []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) out.push(`http://${i.address}:${port}`);
    }
  }
  return out;
}

// Start listening. Falls back to a free port if the preferred one is taken.
function start(port = parseInt(process.env.PORT, 10) || 3000) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0');
    server.once('listening', () => {
      const actual = server.address().port;
      if (!process.env.PSM_NO_BACKUP) backup.startScheduler();
      if (!process.env.PSM_NO_BACKUP) require('./src/telegram').start();
      resolve({ server, port: actual, lan: lanAddresses(actual) });
    });
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && port !== 0) start(0).then(resolve, reject);
      else reject(err);
    });
  });
}

if (require.main === module) {
  start().then(({ port, lan }) => {
    console.log('\n  crft Play is running');
    console.log(`  On this PC:      http://localhost:${port}`);
    for (const u of lan) console.log(`  On the network:  ${u}`);
    console.log('');
  });
}

module.exports = { app, start, db };
