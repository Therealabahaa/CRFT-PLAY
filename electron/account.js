'use strict';
// Signing in with a crft account (the same file in crft Café, Play and Store).
//
// crft makes the account at crft.live/admin and gives it this system until an end date. The owner
// signs in once on the activation screen; crft.live answers with a SUBSCRIPTION TOKEN signed by crft
// (checked in license.js, which holds only the public key). The token is saved where an activation
// key would be. It works until the subscription's end date, and must be renewed by its "check by"
// date, a week ahead, which keepFresh() does by itself whenever the PC is online. The password is
// never saved on the PC.
const https = require('https');
const fs = require('fs');

function post(path, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request({ host: 'crft.live', path, method: 'POST', timeout: 20000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'User-Agent': 'crft-app' } }, (res) => {
      let s = ''; res.setEncoding('utf8');
      res.on('data', (d) => { s += d; });
      res.on('end', () => { let j = {}; try { j = JSON.parse(s); } catch { /* not JSON */ } resolve({ status: res.statusCode, ...j }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, ok: false,
      error: 'No internet connection, or crft.live could not be reached. Connect the PC to the internet and try again.',
      error_ar: 'مفيش إنترنت، أو crft.live مش متاح. وصّل الجهاز بالإنترنت وجرّب تاني.' }));
    req.write(data);
    req.end();
  });
}

// This app's version, sent with every sign-in and renewal: crft.live refuses versions older than the
// newest required release (an "update required" answer, with the download link).
function appVersion() {
  try { const { app } = require('electron'); if (app && typeof app.getVersion === 'function') return app.getVersion(); } catch { /* not in Electron */ }
  for (const p of ['./package.json', '../package.json']) { try { return require(p).version; } catch { /* next */ } }
  return '';
}

const activate = (app, machine, username, password, label) => post('/api/app/activate', { app, machine, username, password, label, version: appVersion() });
const refresh = (app, machine, token) => post('/api/app/refresh', { app, machine, token, version: appVersion() });
const isToken = (text) => String(text || '').trim().includes('.');

/* keepFresh({ app, machineId(), file, log, onUpdateRequired(answer) }): while the app runs, renews the saved
   token 30 seconds after start and then every 6 hours, if the saved licence is a token (an activation key
   needs nothing). A refusal (account switched off, PC removed, subscription ended, or this version too old)
   leaves the token as it is: it then runs out by itself, and the activation screen says why. "Too old" also
   calls onUpdateRequired, so the update is offered right away. */
function keepFresh({ app, machineId, file, log = () => {}, onUpdateRequired = () => {} }) {
  async function once() {
    let saved = '';
    try { saved = fs.readFileSync(file, 'utf8').trim(); } catch { return; }
    if (!isToken(saved)) return;
    const r = await refresh(app, machineId(), saved);
    if (r.ok && r.token) fs.writeFileSync(file, r.token);
    else if (r.status) { log('crft account: ' + (r.error || r.status)); if (r.update_required) onUpdateRequired(r); }
  }
  setTimeout(once, 30 * 1000).unref?.();
  setInterval(once, 6 * 60 * 60 * 1000).unref?.();
  return { once };
}

module.exports = { activate, refresh, keepFresh, isToken };
