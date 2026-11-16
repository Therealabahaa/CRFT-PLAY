'use strict';
// Automatic updates (the same file in crft Café, Play and Store).
//
// When the shop PC has internet, this checks https://downloads.crft.live/updates/<app>.json.
// The file says which version is newest, where its installer is and its SHA-256, and it is
// signed with crft's private key; this app holds only the public key. So an update is only
// ever installed if crft really published it, and only if the downloaded file is exactly
// the one crft signed. No internet: nothing happens, the app works as always.
//
// The owner is asked first ("Update now" / "Later"). Updating runs the installer silently,
// which keeps the data folder (see build/installer.nsh), and opens the app again.
//
// REQUIRED updates: the file also says min_version, the oldest version still allowed to run,
// signed separately (sig2). When this version is older, there is no "Later": mustUpdate()
// shows "Update required" and the update installs. crft.live also refuses to renew the crft
// account of a version that old, so nothing keeps working without the update.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const cp = require('child_process');

const PUBLIC_KEY = crypto.createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from('1dw3KczF3zNr2ydKi0X/V6GOCRihtcsnj9wf37xKTDs=', 'base64')]),
  format: 'der', type: 'spki',
});
const BASE = 'https://downloads.crft.live/';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32bytes(text) {
  const s = String(text || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  const out = []; let bits = 0, value = 0;
  for (const c of s) { value = (value << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}

// 1.10.0 is newer than 1.9.3
function isNewer(candidate, current) {
  const a = String(candidate).split('.').map(Number), b = String(current).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x > y; }
  return false;
}

function verifyManifest(m, app) {
  if (!m || m.app !== app || !/^\d+\.\d+\.\d+$/.test(m.version || '') || !/^[0-9a-f]{64}$/.test(m.sha256 || '')) return false;
  if (typeof m.url !== 'string' || !m.url.startsWith(BASE) || /[\s"'&|<>^%]/.test(m.url)) return false;
  const msg = Buffer.from(`crft-update-v1|${m.app}|${m.version}|${m.url}|${m.sha256}`);
  try { return crypto.verify(null, msg, PUBLIC_KEY, b32bytes(m.sig)); } catch { return false; }
}

// The oldest version still allowed to run, only if crft signed it (sig2) — else '' (nothing required)
function minVersion(m) {
  const min = String(m && m.min_version || '');
  if (!/^\d+\.\d+\.\d+$/.test(min) || isNewer(min, m.version)) return ''; // never above what is published
  const msg = Buffer.from(`crft-update-v2|${m.app}|${m.version}|${m.url}|${m.sha256}|${min}`);
  try { return crypto.verify(null, msg, PUBLIC_KEY, b32bytes(m.sig2)) ? min : ''; } catch { return ''; }
}

function get(url, onResponse) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'crft-updater' }, timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      onResponse(res, resolve, reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

async function latest(app) {
  const text = await get(`${BASE}updates/${app}.json`, (res, resolve, reject) => {
    let s = ''; res.setEncoding('utf8');
    res.on('data', (d) => { s += d; if (s.length > 20000) res.destroy(new Error('too big')); });
    res.on('end', () => resolve(s)); res.on('error', reject);
  });
  const m = JSON.parse(text);
  return verifyManifest(m, app) ? m : null;
}

async function download(m) {
  const dir = path.join(os.tmpdir(), 'crft-update');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(new URL(m.url).pathname));
  if (fs.existsSync(file) && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === m.sha256) return file; // already downloaded earlier
  const part = file + '.part';
  await get(m.url, (res, resolve, reject) => {
    const hash = crypto.createHash('sha256'), out = fs.createWriteStream(part);
    res.on('data', (d) => hash.update(d));
    res.pipe(out);
    out.on('finish', () => (hash.digest('hex') === m.sha256 ? resolve() : reject(new Error('The download did not match crft\'s signature.'))));
    res.on('error', reject); out.on('error', reject);
  });
  fs.renameSync(part, file);
  return file;
}

// Runs the installer once this app has closed, then opens the app again.
function install(installer, exe) {
  const script = path.join(path.dirname(installer), 'crft-update.cmd');
  fs.writeFileSync(script, [
    '@echo off',
    'timeout /t 4 /nobreak >nul',
    `"${installer}" /S`,
    `start "" "${exe}"`,
    '',
  ].join('\r\n'));
  cp.spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/* start({ app: 'cafe', name: 'crft Café', version, exe, ask(m) -> Promise<boolean>, mustUpdate(m) -> Promise, quit(), log })
   Checks 15 seconds after start, then every hour. `ask` offers an update ("Update now" / "Later");
   `mustUpdate` says a required one is installing (no "Later"). check() also runs at once when crft.live
   answers a renewal with "update required". */
function start({ app, name, version, exe, ask, mustUpdate, quit, log = () => {} }) {
  let busy = false, offered = '', retry = null;
  async function check() {
    if (busy) return; busy = true;
    let required = false;
    try {
      const m = await latest(app);
      if (!m || !isNewer(m.version, version)) return;
      required = isNewer(minVersion(m) || '0.0.0', version); // this version is older than the oldest allowed
      if (!required && offered === m.version) return; // an optional update is offered once per version per run
      const file = await download(m);
      offered = m.version;
      if (required && mustUpdate) await mustUpdate(m);
      else if (!(await ask(m))) return;
      log(`Updating ${name} to ${m.version}${required ? ' (required)' : ''}`); install(file, exe); quit();
    } catch (e) {
      log('Update check: ' + (e && e.message || e)); // offline, or the server is down: try again later
      if (required) { clearTimeout(retry); retry = setTimeout(check, 5 * 60 * 1000); retry.unref?.(); } // a required one: soon
    } finally { busy = false; }
  }
  setTimeout(check, 15 * 1000).unref?.();
  setInterval(check, 60 * 60 * 1000).unref?.(); // a required update reaches every open copy within the hour
  return { check };
}

module.exports = { start, isNewer, verifyManifest, minVersion };
