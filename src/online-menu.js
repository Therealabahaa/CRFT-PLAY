'use strict';
// The online menu on crft.live/m/<name> (the same file in crft Café, Play and Store).
//
// Every 2 minutes, while it is switched on, the app builds its menu and, if anything changed
// (a price, an item sold out, a new item), sends it to crft.live. No internet: it tries again
// next time; the till never waits for it. Each send carries this PC's activation key, which
// crft.live checks with crft's public key, so only this PC can change or remove its menu.
// Only what customers see is sent: names, descriptions, prices, options, sold out.
const crypto = require('crypto');
const https = require('https');

const HOST = 'crft.live';

function call(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({ host: HOST, path, method, timeout: 20000,
      headers: { 'User-Agent': 'crft-app', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, (res) => {
      let s = ''; res.setEncoding('utf8');
      res.on('data', (d) => { s += d; });
      res.on('end', () => { let j = {}; try { j = JSON.parse(s); } catch { /* not JSON */ } resolve({ status: res.statusCode, ...j }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, ok: false, error: 'No internet connection, or crft.live could not be reached. It tries again by itself.' }));
    if (data) req.write(data);
    req.end();
  });
}

const cleanSlug = (s) => String(s || '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/* onlineMenu({ app, machineId(), key(), config() -> { on, slug }, menu() -> menu, log })
   menu: { name, lang: 'ar' | 'en', note, sections: [{ title, items: [{ name, description, price, soldOut, options: [{ name, price }] }] }] } */
module.exports = function onlineMenu({ app, machineId, key, config, menu, log = () => {} }) {
  const state = { ok: false, at: null, error: '', url: '', busy: false, sentHash: '', sentAt: 0, removed: true };

  function credentials() {
    let k = '';
    try { k = String(key() || '').trim(); } catch { /* no key file */ }
    return k ? { app, machine: machineId(), key: k } : null;
  }

  async function sync(force = false) {
    if (state.busy) return state; state.busy = true;
    try {
      const c = config(), slug = cleanSlug(c.slug);
      const cred = credentials();
      if (!c.on || !slug) {
        if (!state.removed && cred) { // switched off: take the page down
          const r = await call('POST', '/api/menu/unpublish', cred);
          if (r.ok) { state.removed = true; state.ok = false; state.url = ''; state.sentHash = ''; }
        }
        state.error = '';
        return state;
      }
      if (!cred) { state.ok = false; state.error = 'This copy is not activated, so the menu cannot go online.'; return state; }
      const m = menu();
      if (!m.sections.some((s) => s.items.length)) { state.ok = false; state.error = 'Your menu has no items yet. Add some, and it goes online by itself.'; return state; }
      const hash = crypto.createHash('sha256').update(JSON.stringify({ slug, m })).digest('hex');
      if (!force && hash === state.sentHash && Date.now() - state.sentAt < 12 * 60 * 60 * 1000) return state; // nothing changed
      const r = await call('POST', '/api/menu/publish', { ...cred, slug, menu: m });
      if (r.ok) Object.assign(state, { ok: true, at: new Date().toISOString(), error: '', url: r.url, sentHash: hash, sentAt: Date.now(), removed: false });
      else { state.ok = false; state.error = r.error || `crft.live answered ${r.status}.`; if (r.status && r.status < 500) state.sentHash = hash; } // a refusal (name taken…) is not retried until something changes
      if (!r.ok) log('Online menu: ' + state.error);
      return state;
    } catch (e) {
      state.ok = false; state.error = String(e && e.message || e); log('Online menu: ' + state.error); return state;
    } finally { state.busy = false; }
  }

  async function available(slug) {
    const s = cleanSlug(slug);
    if (!s) return { available: false, error: 'Type a name first.' };
    const r = await call('GET', '/api/menu/check?slug=' + encodeURIComponent(s));
    return r.status ? { slug: s, available: !!r.available, error: r.error || '' } : { slug: s, available: null, error: r.error };
  }

  setTimeout(() => sync(), 15 * 1000).unref?.(); // never keeps the app (or a test) running by itself
  setInterval(() => sync(), 2 * 60 * 1000).unref?.();

  return {
    sync,
    available,
    cleanSlug,
    status: () => { const c = config(), slug = cleanSlug(c.slug); return { on: !!c.on, slug, url: slug ? `https://crft.live/m/${slug}` : '', published: state.ok, at: state.at, error: state.error }; },
  };
};
