'use strict';
// Seller-only. Usage: node keygen/make-key.js XXXX-XXXX-XXXX-XXXX   (the machine ID the buyer sends you). NEVER ship this folder.
const { makeKey } = require('../electron/license.js');
const id = (process.argv[2] || '').trim().toUpperCase();
if (!/^([0-9A-F]{4}-){3}[0-9A-F]{4}$/.test(id)) { console.error('Give the machine ID, e.g. node keygen/make-key.js 1A2B-3C4D-5E6F-7A8B'); process.exit(1); }
console.log(makeKey(id));
