// 📦 Bundles: Starter / Pro / Max (the same rules as crft Café's server.js).
//
// The crft account's bundle travels inside its signed token (electron/license.js), so editing a file can't change it.
// An activation key sold before bundles, a token from before them, or a copy run from source gets everything (max).
// Nothing is ever deleted: what a bundle doesn't include is only locked — shown with 🔒 in the app — and opens again
// after an upgrade.
//   Pro adds: customers, reservations, expenses, stock (inventory & movements) and reports.
//   Max adds: the online menu on crft.live and the Telegram bot.
const fs = require('fs');
const os = require('os');
const path = require('path');

const RANK = { starter: 1, pro: 2, max: 3 };
const NAME = { starter: 'Starter', pro: 'Pro', max: 'Max' };
const LIC_FILE = () => path.join(process.env.LOCALAPPDATA || os.homedir(), 'PlayStation Cyber', 'license.key'); // where electron/main.js saves it

let seen = { at: 0, plan: 'max' };
function currentPlan() {
  if (Date.now() - seen.at < 30000) return seen.plan; // read again every 30 s: an upgrade shows within a minute of renewing
  let plan = 'max';
  try {
    const lic = require('../electron/license.js');
    const st = lic.status(lic.machineId(), fs.readFileSync(LIC_FILE(), 'utf8'));
    if (st.ok && RANK[st.plan]) plan = st.plan;
  } catch { /* no licence file (a copy run from source): everything */ }
  // tests (PSM_PLAN) can only LOWER the bundle — setting it on a PC never unlocks anything
  if (RANK[process.env.PSM_PLAN] && RANK[process.env.PSM_PLAN] < RANK[plan]) plan = process.env.PSM_PLAN;
  seen = { at: Date.now(), plan };
  return plan;
}
const allows = (need) => RANK[currentPlan()] >= RANK[need];

// the API routes (under /api) each bundle adds; the screens that use only these are locked the same way in public/js
const ROUTES = [
  ['pro', /^\/(customers|reservations|expenses|inventory|stock-movements|reports)(\/|$)/],
  ['max', /^\/(online-menu|telegram)(\/|$)/],
];
// Express middleware: refuse what this bundle doesn't include (403 { error: 'plan', need })
function gate(req, res, next) {
  const need = ROUTES.find(([n, re]) => re.test(req.path) && !allows(n))?.[0];
  if (!need) return next();
  res.status(403).json({ error: 'plan', need, message: `This is in the ${NAME[need]} bundle of crft Play. Ask crft to upgrade — your data is kept.` });
}

module.exports = { currentPlan, allows, gate, NAME };
