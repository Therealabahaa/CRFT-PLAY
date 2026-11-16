// Bundles (src/plan.js): a Starter or Pro crft Play refuses what its bundle doesn't include — on the server, so no screen
// can get round it — and keeps everything already saved. PSM_PLAN lowers the bundle for this test only (it can never
// raise one: a copy with no licence, like this one, is Max).   node test/plans.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : '  → ' + extra}`); };

async function withServer(plan, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psm-plan-'));
  const env = { ...process.env, PSM_DATA_DIR: dir, PSM_NO_BACKUP: '1', PSM_NO_TG: '1', LOCALAPPDATA: dir, PSM_PLAN: plan };
  const child = spawn(process.execPath, ['-e', "require('./server').start(0).then(({ server }) => console.log('PORT=' + server.address().port))"], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = ''; const t = setTimeout(() => reject(new Error('the server did not start')), 20000);
      child.stdout.on('data', (d) => { out += d; const m = out.match(/PORT=(\d+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
      child.on('exit', (c) => reject(new Error('the server stopped: ' + c)));
    });
    let token = '';
    const call = async (method, url, body) => {
      const r = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };
    token = (await call('POST', '/login', { username: 'admin', password: 'admin' })).data.token;
    await fn(call);
  } finally { child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use */ } }
}

const PRO = ['/customers', '/reservations', '/expenses', '/stock-movements', '/reports/summary'];

(async () => {
  console.log('\nStarter');
  await withServer('starter', async (call) => {
    check('the app is told it is on Starter', (await call('GET', '/me')).data.plan === 'starter');
    for (const p of PRO) {
      const r = await call('GET', p);
      check(`${p} is refused (Pro)`, r.status === 403 && r.data.error === 'plan' && r.data.need === 'pro', `${r.status} ${JSON.stringify(r.data)}`);
    }
    const om = await call('GET', '/online-menu');
    check('the online menu is refused (Max)', om.status === 403 && om.data.need === 'max', JSON.stringify(om.data));
    const floor = await call('GET', '/floor');
    check('the floor (timed sessions) works', floor.status === 200 && floor.data.consoles.length > 0, floor.status);
    const products = (await call('GET', '/products')).data;
    check('products (what the till sells) load', Array.isArray(products) && products.length > 0);
    await call('POST', '/shifts/open', { opening_cash: 100 });
    const pepsi = products.find((p) => p.name === 'بيبسي') || products[0];
    const sale = await call('POST', '/sales', { items: [{ product_id: pepsi.id, qty: 1 }], payments: [{ method: 'cash', amount: 20 }] });
    check('…and it sells', sale.status === 200, `${sale.status} ${JSON.stringify(sale.data).slice(0, 160)}`);
    const s = await call('POST', '/sessions', { console_id: floor.data.consoles[0].id, players: 1 });
    check('…and starts a timed session', s.status === 200, `${s.status} ${JSON.stringify(s.data).slice(0, 160)}`);
  });

  console.log('\nPro');
  await withServer('pro', async (call) => {
    check('the app is told it is on Pro', (await call('GET', '/me')).data.plan === 'pro');
    for (const p of PRO) { const r = await call('GET', p); check(`${p} opens`, r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 120)}`); }
    const om = await call('GET', '/online-menu');
    check('the online menu is still refused (Max)', om.status === 403 && om.data.need === 'max', JSON.stringify(om.data));
  });

  console.log('\nA copy with no crft account (an old activation key, or run from source)');
  await withServer('', async (call) => {
    check('…has everything (Max)', (await call('GET', '/me')).data.plan === 'max');
    check('…the online menu opens', (await call('GET', '/online-menu')).status === 200);
  });

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
