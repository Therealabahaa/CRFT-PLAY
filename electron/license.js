'use strict';
// Offline, machine-locked licence. A key is a short code (XXXX-XXXX-XXXX-XXXX) derived from this PC's machine ID and a secret; see keygen/make-key.js.
const crypto = require('crypto');
const cp = require('child_process');
const os = require('os');

const SECRET = '09cf7ef6e393b2ef04afb35146550567a2dfc9dd4ae4051f276a44a541b90871';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I so keys can be read out and typed without mistakes

function machineId() {
  let raw = '';
  try {
    const out = cp.execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true }).toString();
    raw = (out.match(/MachineGuid\s+REG_SZ\s+(\S+)/) || [])[1] || '';
  } catch { /* fall back below */ }
  if (!raw) raw = os.hostname();
  const h = crypto.createHash('sha256').update('play|' + raw).digest('hex').slice(0, 16).toUpperCase();
  return h.match(/.{4}/g).join('-');
}

function makeKey(id) {
  const d = crypto.createHmac('sha256', SECRET).update(String(id).trim().toUpperCase()).digest();
  let s = ''; for (let i = 0; i < 16; i++) s += ALPHABET[d[i] % 32];
  return s.match(/.{4}/g).join('-');
}

const clean = (k) => String(k || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
const MASTER = 'mb70402009'; // works on any PC (not machine-locked) - keep it for your own installs
const verify = (id, key) => String(key || '').trim().toLowerCase() === MASTER || (clean(key).length === 16 && clean(key) === clean(makeKey(id)));

module.exports = { machineId, makeKey, verify };
