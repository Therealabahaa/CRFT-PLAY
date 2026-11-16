'use strict';
// Keys are now made with the shared seller tool, which signs them with crft's private key:
//   node "d:/crft work/CRFT/tools/license/crft-license.mjs" sign play <machine-id>
console.error('Use: node "d:/crft work/CRFT/tools/license/crft-license.mjs" sign play ' + (process.argv[2] || '<machine-id>'));
process.exit(1);
