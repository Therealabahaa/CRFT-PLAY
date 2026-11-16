'use strict';
// 🌐 crft Play's online menu on crft.live/m/<name>: the rooms and their price per hour, the
// packages, and the snacks & drinks (sold out when the stock runs out). online-menu.js sends it
// to crft.live when it changes (checked every 2 minutes) and takes it down when switched off.
// Settings → Online menu.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { db, settings } = require('./db');
const { qrDataUri } = require('./qr');

const words = {
  ar: { rooms: 'الغرف · السعر للساعة', perHour: 'للساعة', packages: 'الباقات', minutes: (m) => (m % 60 ? `${m} دقيقة` : `${m / 60} ساعة`), snacks: 'سناكس ومشروبات' },
  en: { rooms: 'Rooms · price per hour', perHour: 'per hour', packages: 'Packages', minutes: (m) => (m % 60 ? `${m} min` : `${m / 60} h`), snacks: 'Snacks & drinks' },
};

function menu() {
  const s = settings(), lang = s.language === 'en' ? 'en' : 'ar', w = words[lang];
  const rooms = db.prepare(`SELECT name, rate_single, notes FROM consoles WHERE deleted = 0 AND status = 'active' ORDER BY sort, id`).all();
  const packages = db.prepare('SELECT name, minutes, price FROM packages WHERE active = 1 ORDER BY price, id').all();
  const products = db.prepare('SELECT name, category, sell_price, stock FROM products WHERE active = 1 ORDER BY category, name').all();
  const byCat = new Map();
  for (const p of products) { const k = (p.category || '').trim() || w.snacks; if (!byCat.has(k)) byCat.set(k, []); byCat.get(k).push(p); }
  return {
    name: s.shop_name, lang,
    sections: [
      { title: w.rooms, items: rooms.map((r) => ({ name: r.name, description: w.perHour, price: r.rate_single })) },
      { title: w.packages, items: packages.map((p) => ({ name: p.name, description: w.minutes(p.minutes), price: p.price })) },
      ...[...byCat].map(([title, list]) => ({ title, items: list.map((p) => ({ name: p.name, price: p.sell_price, soldOut: p.stock <= 0 })) })),
    ],
  };
}

const online = require('./online-menu')({
  app: 'play',
  machineId: () => require('../electron/license').machineId(),
  key: () => fs.readFileSync(path.join(process.env.LOCALAPPDATA || os.homedir(), 'PlayStation Cyber', 'license.key'), 'utf8'), // where electron/main.js saves it
  config: () => { const s = settings(); return { on: s.online_menu === '1' && require('./plan').allows('max'), slug: s.online_slug }; }, // the online menu is in Max
  menu,
  log: (m) => console.log(m),
});

const withQr = (s) => ({ ...s, qr: s.url ? qrDataUri(s.url) : '' });
module.exports = { online, menu, withQr };
