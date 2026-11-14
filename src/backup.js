const fs = require('fs');
const path = require('path');
const { db, DATA_DIR, settings } = require('./db');

function backupDir() {
  const dir = settings().backup_dir || path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function list() {
  const dir = backupDir();
  return fs.readdirSync(dir)
    .filter((f) => /^cyber-.*\.db$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, created_at: st.mtimeMs };
    })
    .sort((a, b) => b.created_at - a.created_at);
}

// VACUUM INTO writes a consistent copy of the live database without stopping the app.
function run(reason = 'auto') {
  const dir = backupDir();
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const file = path.join(dir, `cyber-${stamp}-${reason}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const keep = Math.max(1, parseInt(settings().backup_keep, 10) || 30);
  for (const old of list().slice(keep)) {
    try { fs.unlinkSync(path.join(dir, old.name)); } catch { /* ignore */ }
  }
  return path.basename(file);
}

function filePath(name) {
  if (!/^cyber-[\w-]+\.db$/.test(name)) return null;
  const p = path.join(backupDir(), name);
  return fs.existsSync(p) ? p : null;
}

function startScheduler() {
  const tick = () => {
    try {
      const hours = parseFloat(settings().backup_every_hours) || 0;
      if (hours <= 0) return;
      const last = list()[0];
      if (!last || Date.now() - last.created_at >= hours * 3600 * 1000) {
        const name = run('auto');
        console.log(`[backup] ${name}`);
      }
    } catch (err) {
      console.error('[backup] failed:', err.message);
      require('./telegram').notify('important', `⚠️ النسخة الاحتياطية فشلت: ${err.message}`, { minGapMs: 6 * 3600000, key: 'backup' });
    }
  };
  tick();
  return setInterval(tick, 10 * 60 * 1000);
}

module.exports = { run, list, filePath, startScheduler, backupDir };
