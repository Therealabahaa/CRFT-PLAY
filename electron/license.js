'use strict';
// Offline, machine-locked licence. The app shows this PC's machine ID; the key is crft's
// Ed25519 signature of "crft-license-v1|play|<machine ID>", made by the seller's tool or the
// crft.live website. This file holds only the PUBLIC key: it can check a key but not make one.
const crypto = require('crypto');
const cp = require('child_process');
const os = require('os');

const APP = 'play'; // a key for another crft app does not open this one
const PUBLIC_KEY = crypto.createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from('1dw3KczF3zNr2ydKi0X/V6GOCRihtcsnj9wf37xKTDs=', 'base64')]),
  format: 'der', type: 'spki',
});
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function machineId() {
  let raw = '';
  try {
    const out = cp.execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true }).toString();
    raw = (out.match(/MachineGuid\s+REG_SZ\s+(\S+)/) || [])[1] || '';
  } catch { /* fall back below */ }
  if (!raw) raw = os.hostname();
  // 'play|' is part of every machine ID already handed out; changing it gives every PC a new ID.
  const h = crypto.createHash('sha256').update('play|' + raw).digest('hex').slice(0, 16).toUpperCase();
  return h.match(/.{4}/g).join('-');
}

// The key as typed or pasted (any case, spaces, dashes) back to the 64 signature bytes.
function keyBytes(key) {
  const s = String(key || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  const out = []; let bits = 0, value = 0;
  for (const c of s) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function verifyKey(id, key) {
  const sig = keyBytes(key);
  if (sig.length !== 64) return false;
  const msg = Buffer.from('crft-license-v1|' + APP + '|' + String(id).trim().toUpperCase());
  try { return crypto.verify(null, msg, PUBLIC_KEY, sig); } catch { return false; }
}

// ---- a crft account (account.js): a SUBSCRIPTION TOKEN instead of an activation key ----
// "crft-sub-v1|<app>|<machine>|<account>|<ends_on>|<check_by>", base64url, a dot, then crft's Ed25519
// signature of it with the SUBSCRIPTION key (a different key from the activation keys'; public half here).
const SUB_KEY = crypto.createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from('1LsQnh16qFIzce1/8VJlwq9gqW4uCNK9EupJc9XCLRM=', 'base64')]),
  format: 'der', type: 'spki',
});
const today = () => new Date().toLocaleDateString('sv'); // this PC's date, YYYY-MM-DD
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const dayGap = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

function readToken(token) {
  const [p, sig] = String(token || '').trim().split('.');
  if (!p || !sig) return null;
  const payload = unb64url(p).toString('utf8'), bytes = unb64url(sig);
  if (bytes.length !== 64) return null;
  try { if (!crypto.verify(null, Buffer.from(payload), SUB_KEY, bytes)) return null; } catch { return null; }
  const [v, app, machine, account, endsOn, checkBy] = payload.split('|');
  return v === 'crft-sub-v1' ? { app, machine, account: Number(account), endsOn, checkBy } : null;
}

/* Whether what is saved opens the app, and why not:
   { ok, kind: 'key' | 'account', reason: 'ended' | 'check' | 'invalid', endsOn, checkBy, daysLeft }
   'ended' = the subscription's end date passed; 'check' = not renewed online for over a week. */
function status(id, saved) {
  const text = String(saved || '').trim();
  if (!text.includes('.')) return { ok: verifyKey(id, text), kind: 'key' };
  const t = readToken(text);
  if (!t || t.app !== APP || t.machine !== String(id).trim().toUpperCase()) return { ok: false, kind: 'account', reason: 'invalid' };
  const d = today();
  if (d > t.endsOn) return { ok: false, kind: 'account', reason: 'ended', endsOn: t.endsOn };
  if (d > t.checkBy) return { ok: false, kind: 'account', reason: 'check', endsOn: t.endsOn, checkBy: t.checkBy };
  return { ok: true, kind: 'account', endsOn: t.endsOn, checkBy: t.checkBy, daysLeft: dayGap(d, t.endsOn) };
}
const verify = (id, key) => status(id, key).ok;

module.exports = { machineId, verify, status, readToken, APP };
