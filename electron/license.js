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

function verify(id, key) {
  const sig = keyBytes(key);
  if (sig.length !== 64) return false;
  const msg = Buffer.from('crft-license-v1|' + APP + '|' + String(id).trim().toUpperCase());
  try { return crypto.verify(null, msg, PUBLIC_KEY, sig); } catch { return false; }
}

module.exports = { machineId, verify };
