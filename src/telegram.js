// Telegram: alerts to the owner and the owner's bot (same approach as Kur).
// One bot (made with @BotFather) talks to one chat — the owner's own chat or the owners' group.
// Alerts: shift opened/closed (with the cash difference), refunds, cancelled sessions, expenses, low stock, backup problems.
// The bot answers questions while the app is open: الأجهزة, تقرير, وردية, مخزون, ديون, حجوزات, مساعدة.
const { db, secret, setSecret, money, settings, onCommit } = require('./db');

const DEFAULTS = { token: '', chat: '', important: true, low_stock: true, shift_report: true, commands: true };

function config() {
  let c = {};
  try { c = JSON.parse(secret('config', '{}') || '{}'); } catch { c = {}; }
  return {
    token: c.token || '', chat: c.chat || '',
    important: c.important !== false, low_stock: c.low_stock !== false, shift_report: c.shift_report !== false, commands: c.commands !== false,
  };
}
const ready = (c) => !!(c.token && c.chat);
function saveConfig(patch) {
  const old = config();
  const flag = (k) => (patch[k] === undefined ? old[k] : patch[k] !== false);
  const c = {
    token: String(patch.token || '').trim() || old.token,
    chat: patch.chat === undefined ? old.chat : String(patch.chat).replace(/[^\d-]/g, ''),
    important: flag('important'), low_stock: flag('low_stock'), shift_report: flag('shift_report'), commands: flag('commands'),
  };
  setSecret('config', JSON.stringify(c));
  return c;
}
// What the settings page may see: never the token itself.
function publicConfig() {
  const c = config();
  return {
    token_set: !!c.token, chat: c.chat, important: c.important, low_stock: c.low_stock, shift_report: c.shift_report, commands: c.commands,
    recent: db.prepare('SELECT * FROM tg_log ORDER BY id DESC LIMIT 12').all(),
  };
}

const api = (token, method, body, ms = 15000) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: 'POST', signal: AbortSignal.timeout(ms), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
}).then((r) => r.json());

async function send(c, text) {
  if (!ready(c)) throw new Error('Telegram bot token and chat id are not set');
  let j = await api(c.token, 'sendMessage', { chat_id: c.chat, text });
  if (!j.ok && j.parameters && j.parameters.migrate_to_chat_id) { // the group became a supergroup: follow the new id
    saveConfig({ chat: String(j.parameters.migrate_to_chat_id) });
    j = await api(c.token, 'sendMessage', { chat_id: j.parameters.migrate_to_chat_id, text });
  }
  if (!j.ok) throw new Error(j.description || 'Telegram error');
}
async function sendLong(c, text) { // Telegram allows 4096 characters per message
  const parts = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if ((cur + '\n' + line).length > 3900) { parts.push(cur); cur = line; } else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) parts.push(cur);
  for (const p of parts) await send(c, p);
}

async function deliver(c, text, kind) {
  const log = db.prepare('INSERT INTO tg_log(kind, text, ok, error, created_at) VALUES(?,?,?,?,?)');
  try {
    await sendLong(c, text);
    log.run(kind, text, 1, null, Date.now());
    return { ok: true };
  } catch (e) {
    const msg = String(e.message || e);
    log.run(kind, text, 0, msg, Date.now());
    return { ok: false, error: msg };
  } finally {
    try { db.prepare('DELETE FROM tg_log WHERE id <= (SELECT MAX(id) FROM tg_log) - 60').run(); } catch { /* keep going */ }
  }
}

let chain = Promise.resolve();
const lastSent = new Map();
// kind: 'important' | 'low_stock' | 'shift_report'. Never throws — alerts must not break a sale.
// Inside a transaction the alert waits until the data is saved (a rolled-back sale sends nothing).
function notify(kind, text, opts = {}) {
  onCommit(() => notifyNow(kind, text, opts));
}
function notifyNow(kind, text, { minGapMs = 0, key = '' } = {}) {
  try {
    if (process.env.PSM_NO_TG) return;
    const c = config();
    if (!ready(c) || !c[kind]) return;
    if (minGapMs) {
      const k = key || text;
      if (Date.now() - (lastSent.get(k) || 0) < minGapMs) return;
      lastSent.set(k, Date.now());
    }
    const shop = settings().shop_name || 'crft Play';
    chain = chain.then(() => deliver(c, `🎮 ${shop}\n${text}`, kind)).then(() => new Promise((r) => setTimeout(r, 800))).catch(() => {});
  } catch { /* never block the caller */ }
}

/* ---------- answers ---------- */
const egp = (n) => `${money(n).toLocaleString('en-US')} ج.م`;
const pad = (n) => String(n).padStart(2, '0');
const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dur = (min) => { min = Math.round(min); const h = Math.floor(min / 60); return h ? `${h} س ${min % 60} د` : `${min} د`; };
const norm = (s) => String(s || '').toLowerCase().replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').trim();

function ansConsoles() {
  const Pricing = require('../public/js/pricing');
  const st = settings();
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM consoles WHERE deleted = 0 ORDER BY id').all();
  const lines = [];
  let running = 0;
  for (const c of rows) {
    const s = db.prepare("SELECT * FROM sessions WHERE console_id = ? AND status != 'ended'").get(c.id);
    if (c.status === 'maintenance') { lines.push(`🔧 ${c.name} — صيانة`); continue; }
    if (!s) { lines.push(`🟢 ${c.name} — متاح`); continue; }
    s.segments = db.prepare('SELECT * FROM session_segments WHERE session_id = ?').all(s.id);
    const p = Pricing.compute(s, st, now);
    const items = db.prepare('SELECT COALESCE(SUM(qty*price),0) s FROM invoice_items WHERE invoice_id = ?').get(s.invoice_id).s;
    running += p.amount + items;
    lines.push(`${s.status === 'paused' ? '⏸' : '🔵'} ${c.name} — ${dur(p.minutes)} — ${egp(p.amount + items)}${s.customer_name ? ` (${s.customer_name})` : ''}${s.status === 'paused' ? ' — متوقف' : ''}`);
  }
  return `🚪 الغرف الآن (${hm(now)})\n${lines.join('\n') || 'لا توجد غرف'}\n\nإجمالي الغرف الشغالة: ${egp(running)}`;
}

function period(word) {
  const d = new Date();
  const start = (x) => { const y = new Date(x); y.setHours(0, 0, 0, 0); return y.getTime(); };
  const end = (x) => { const y = new Date(x); y.setHours(23, 59, 59, 999); return y.getTime(); };
  if (/امبارح|امس|yesterday/.test(word)) { d.setDate(d.getDate() - 1); return [start(d), end(d), 'امبارح']; }
  if (/اسبوع|week/.test(word)) { const f = new Date(); f.setDate(f.getDate() - 6); return [start(f), end(d), 'آخر 7 أيام']; }
  if (/شهر|month/.test(word)) { return [start(new Date(d.getFullYear(), d.getMonth(), 1)), end(d), 'الشهر ده']; }
  return [start(d), end(d), 'النهارده'];
}
function ansReport(word) {
  const { buildReport } = require('./routes/reports');
  const [from, to, label] = period(word);
  const r = buildReport(from, to);
  const k = r.kpis;
  const top = r.consoles.slice(0, 3).map((c) => `  • ${c.name}: ${dur(c.minutes)} — ${egp(c.revenue)}`).join('\n');
  const methods = Object.entries(r.methods).map(([m, v]) => `  • ${METHOD_AR[m] || m}: ${egp(v)}`).join('\n');
  return `📊 تقرير ${label}\n`
    + `الإيراد: ${egp(k.revenue)} (${k.sessions} جلسة · ${k.sales} بيع)\n`
    + `  • البلايستيشن: ${egp(k.time_revenue)}\n  • المنتجات: ${egp(k.items_revenue)} (ربح ${egp(k.items_profit)})\n`
    + `الخصومات: ${egp(k.discounts)}\nالمصروفات: ${egp(k.expenses)}${k.waste ? ` · الهالك: ${egp(k.waste)}` : ''}\n`
    + `صافي الربح: ${egp(k.net_profit)}\n`
    + `المحصّل: ${egp(k.collected)}${k.refunds ? ` · مرتجعات: ${egp(k.refunds)}` : ''}\n${methods ? methods + '\n' : ''}`
    + `آجل جديد: ${egp(k.unpaid)} · ديون العملاء: ${egp(k.outstanding_debts)}`
    + (top ? `\n\nأكتر الأجهزة شغل:\n${top}` : '');
}
const METHOD_AR = { cash: 'كاش', card: 'فيزا', online: 'أونلاين', wallet: 'محفظة', instapay: 'إنستاباي' };
const diffAr = (d) => (d == null ? 'ما اتعدّش' : `${d > 0 ? '+' : ''}${egp(d)} ${d < 0 ? '🔴 عجز' : d > 0 ? '🟡 زيادة' : '✅ مضبوط'}`);
function shiftText(s, title) {
  const by = Object.entries(s.by_method).map(([m, v]) => `${METHOD_AR[m] || m} ${egp(v)}`).join(' · ');
  return `${title}\nالكاشير: ${s.user_name} · من ${hm(s.opened_at)}${s.closed_at ? ` لـ ${hm(s.closed_at)}` : ''}\n`
    + `الإيراد: ${egp(s.revenue)} (${s.sessions_count} جلسة · ${s.sales_count} بيع)\n`
    + `  • البلايستيشن: ${egp(s.time_revenue)} · المنتجات: ${egp(s.items_revenue)}\n`
    + (by ? `المحصّل: ${by}\n` : '')
    + (s.discounts ? `الخصومات: ${egp(s.discounts)}\n` : '')
    + (s.refunds ? `المرتجعات: ${egp(s.refunds)}\n` : '')
    + (s.drawer_expenses ? `مصروفات من الدرج: ${egp(s.drawer_expenses)}\n` : '')
    + (s.moves_in ? `إضافة للدرج: ${egp(s.moves_in)}\n` : '')
    + (s.moves_out ? `سحب من الدرج: ${egp(s.moves_out)}\n` : '')
    + `الكاش المتوقع في الدرج: ${egp(s.expected_cash)}`
    + (s.closed_at
      ? `\n\n💵 الكاش: المفروض ${egp(s.expected_cash)} — اتعدّ ${s.counted_cash == null ? '-' : egp(s.counted_cash)} — ${diffAr(s.difference)}`
        + `\n💳 الفيزا: المفروض ${egp(s.expected_card)} — ${diffAr(s.card_difference)}`
        + `\n🌐 الأونلاين: المفروض ${egp(s.expected_online)} — ${diffAr(s.online_difference)}`
        + (s.notes ? `\n📝 ${s.notes}` : '')
      : '');
}
function ansShift() {
  const { shiftSummary } = require('./routes/cashier');
  const open = db.prepare('SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').get();
  if (open) return shiftText(shiftSummary(open), `🕒 الوردية الحالية #${open.id}`);
  const last = db.prepare('SELECT * FROM shifts ORDER BY id DESC LIMIT 1').get();
  return last ? shiftText(shiftSummary(last), `🕒 آخر وردية #${last.id} (مقفولة)`) : 'لا توجد ورديات بعد.';
}
function ansStock() {
  const low = db.prepare('SELECT * FROM products WHERE active = 1 AND stock <= low_stock ORDER BY stock').all();
  const all = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY category, name').all();
  const value = all.reduce((s, p) => s + Math.max(0, p.stock) * p.cost_price, 0);
  return `📦 المخزون\n${low.length ? `⚠️ قرب يخلص / خلص:\n${low.map((p) => `  • ${p.name}: ${p.stock}${p.stock <= 0 ? ' 🚫' : ''}`).join('\n')}\n` : '✅ مفيش حاجة قربت تخلص\n'}`
    + `\nكل المنتجات:\n${all.map((p) => `  • ${p.name}: ${p.stock}`).join('\n')}\n\nقيمة المخزون (بالتكلفة): ${egp(value)}`;
}
function ansDebts() {
  const rows = db.prepare(`SELECT c.name, c.phone, SUM(l.amount) bal FROM customer_ledger l JOIN customers c ON c.id = l.customer_id
    GROUP BY c.id HAVING bal > 0.001 ORDER BY bal DESC`).all();
  if (!rows.length) return '✅ مفيش ديون على العملاء.';
  const total = rows.reduce((s, r) => s + r.bal, 0);
  return `💳 ديون العملاء: ${egp(total)} (${rows.length} عميل)\n${rows.slice(0, 25).map((r) => `  • ${r.name}${r.phone ? ` (${r.phone})` : ''}: ${egp(r.bal)}`).join('\n')}`;
}
function ansReservations() {
  const [from, to] = period('');
  const rows = db.prepare(`SELECT r.*, c.name console_name FROM reservations r JOIN consoles c ON c.id = r.console_id
    WHERE r.start_at BETWEEN ? AND ? AND r.status = 'booked' ORDER BY r.start_at`).all(Date.now() - 3600000, to);
  void from;
  return rows.length ? `📅 حجوزات النهارده:\n${rows.map((r) => `  • ${hm(r.start_at)} — ${r.console_name} — ${r.customer_name}${r.phone ? ` (${r.phone})` : ''}`).join('\n')}` : '📅 مفيش حجوزات باقية النهارده.';
}
const HELP = '🤖 اكتب أي كلمة من دول:\n'
  + '• الغرف — مين بيلعب دلوقتي وحسابه كام\n'
  + '• تقرير — تقرير النهارده (أو: تقرير امبارح / اسبوع / شهر)\n'
  + '• وردية — الوردية الحالية أو آخر وردية\n'
  + '• مخزون — المنتجات اللي قربت تخلص\n'
  + '• ديون — العملاء اللي عليهم فلوس\n'
  + '• حجوزات — حجوزات النهارده\n\n'
  + 'English works too: rooms, report, shift, stock, debts, reservations.';

function answer(text) {
  const w = norm(String(text).replace(/^\//, '').replace(/@\S+/, ''));
  if (!w) return null;
  if (/^(start|help|مساعده|اوامر|\?)/.test(w)) return HELP;
  if (/(اجهز|جهاز|غرف|غرفه|rooms?|consoles?|floor|playing)/.test(w)) return ansConsoles();
  if (/(تقرير|report)/.test(w)) return ansReport(w);
  if (/(وردي|shift)/.test(w)) return ansShift();
  if (/(مخزن|مخزون|stock)/.test(w)) return ansStock();
  if (/(دين|ديون|debt)/.test(w)) return ansDebts();
  if (/(حجز|reserv)/.test(w)) return ansReservations();
  return `مش فاهم "${String(text).slice(0, 40)}" 🤔\n\n${HELP}`;
}

/* ---------- the bot loop: long-polls Telegram while the app is open ---------- */
let offset = null;
let activeToken = '';
const seen = new Map(); // recent chats the bot heard from (for "Find my chat")
let stopped = false;
async function loop() {
  while (!stopped) {
    const c = config();
    if (!c.token || !c.chat || !c.commands) { offset = null; await new Promise((r) => setTimeout(r, 20000)); continue; }
    try {
      if (offset === null || activeToken !== c.token) { // starting: skip what was sent while the app was closed
        const j = await api(c.token, 'getUpdates', { offset: -1, timeout: 0 });
        offset = j.ok && j.result.length ? j.result[j.result.length - 1].update_id + 1 : 0;
        activeToken = c.token;
        continue;
      }
      const j = await api(c.token, 'getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'my_chat_member'] }, 40000);
      if (!j.ok) throw new Error(j.description || 'getUpdates failed');
      for (const u of j.result) {
        offset = u.update_id + 1;
        const chat = (u.message && u.message.chat) || (u.my_chat_member && u.my_chat_member.chat);
        if (chat) { seen.set(String(chat.id), { chat_id: String(chat.id), name: chat.title || chat.first_name || '', type: chat.type }); if (seen.size > 20) seen.delete(seen.keys().next().value); }
        const m = u.message;
        if (m && m.migrate_to_chat_id && String(m.chat.id) === String(c.chat)) { saveConfig({ chat: String(m.migrate_to_chat_id) }); continue; }
        if (!m || !m.text || String(m.chat.id) !== String(c.chat)) continue; // only the shop's own chat
        let reply;
        try { reply = answer(m.text); } catch (e) { reply = '⚠️ حصل خطأ وأنا بجهز الرد — جرب تاني.'; }
        if (reply) await sendLong(c, reply).catch(() => {});
      }
    } catch (e) {
      if (e.name !== 'TimeoutError') await new Promise((r) => setTimeout(r, 15000));
    }
  }
}
function start() {
  if (process.env.PSM_NO_TG) return;
  setTimeout(() => { loop(); }, 3000);
}

// After pressing Start on the bot (or /start in the group), find the chat id so nobody has to dig for it.
async function findChat(tokenIn) {
  const token = String(tokenIn || '').trim() || config().token;
  if (!token) throw new Error('paste_token_first');
  const me = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => ({}));
  if (!me.ok) throw new Error(me.description || 'bad_token');
  const pick = (x) => ({ chat_id: x.chat_id, name: x.name, group: x.type !== 'private', bot: me.result.username });
  if (offset !== null && activeToken === token) { // the running bot takes the updates itself: use what it heard
    const last = [...seen.values()].pop();
    if (!last) throw new Error('no_message_yet');
    return pick(last);
  }
  const j = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => ({}));
  if (!j.ok) throw new Error(j.description || 'bad_token');
  const msg = [...(j.result || [])].reverse().map((u) => u.message || u.channel_post || (u.my_chat_member && { chat: u.my_chat_member.chat })).find((m) => m && m.chat);
  if (!msg) throw new Error('no_message_yet');
  return pick({ chat_id: String(msg.chat.id), name: msg.chat.title || msg.chat.first_name || '', type: msg.chat.type });
}

async function test() {
  const c = config();
  if (!ready(c)) throw new Error('not_configured');
  const shop = settings().shop_name || 'crft Play';
  return deliver(c, `🎮 ${shop}\n✅ رسالة تجريبية — التنبيهات شغالة.\n\n${HELP}`, 'test');
}

// Shift closed: the full summary with the cash difference.
function notifyShiftClosed(summary) {
  notify('shift_report', shiftText(summary, `⏹ اتقفلت الوردية #${summary.id}`));
}

module.exports = { config, saveConfig, publicConfig, notify, notifyShiftClosed, start, findChat, test, answer, egp };
