// Receipt printing. In the desktop app the receipt goes straight to the chosen printer (silently, or as an ESC/POS picture
// in "direct" mode — Kur's approach). In a browser (tablet / phone / other PC) it falls back to the browser's print window.
import { t, lang } from './i18n.js';
import { state, esc, toast } from './core.js';

export const desktop = () => !!window.psmDesktop;

// Same product at the same price → one line with the quantities added up (Pepsi ×1 + Pepsi ×1 → Pepsi ×2).
export function mergeItems(items) {
  const out = new Map();
  for (const it of items || []) {
    const k = `${it.product_id ?? it.name}|${it.price}`;
    const x = out.get(k);
    if (x) x.qty = Math.round((x.qty + it.qty) * 1000) / 1000;
    else out.set(k, { ...it });
  }
  return [...out.values()];
}

const fmtMoney = (n) => `${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${t('egp')}`;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ts) => { const d = new Date(ts || Date.now()); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
// escape + keep phone numbers like "0100 000 0000" in order inside Arabic text + keep line breaks
const textBlock = (s) => esc(s).replace(/\+?\d[\d \-]*\d/g, (m) => `<bdi dir="ltr">${m}</bdi>`).replace(/\n/g, '<br>');
const mins = (m) => { m = Math.round(m || 0); const h = Math.floor(m / 60); return h ? `${h}${t('hr')} ${m % 60}${t('min')}` : `${m} ${t('min')}`; };

// Any slip (receipt, cash-up sheet, stock sheet) as a self-contained page sized for the receipt roll.
export function slipDocument(inner, s = state.settings, title = '') {
  const paper = s.paper === '58' ? 58 : 80;
  const width = paper === 58 ? 48 : 72; // printable width: 384 / 576 dots at 8 dots per mm
  const rtl = lang() === 'ar';
  return `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page { size: ${paper}mm auto; margin: 0 }
    * { box-sizing: border-box }
    html { background: #fff }
    body { margin: 0 auto; padding: 2mm 1mm 5mm; width: ${width}mm; font: ${paper === 58 ? 11 : 12.5}px/1.45 Tahoma, "Segoe UI", Arial, sans-serif; color: #000; background: #fff; overflow-wrap: anywhere }
    .c { text-align: center } .shop { font-size: 1.45em; font-weight: 700 } .muted { font-size: .9em }
    hr { border: 0; border-top: 1px dashed #000; margin: 6px 0 }
    .l { display: flex; justify-content: space-between; gap: 6px } .l span:first-child { flex: 1 }
    .q { white-space: nowrap; padding-inline: 4px } .a { white-space: nowrap; font-variant-numeric: tabular-nums }
    .tot { font-size: 1.35em; font-weight: 700 } .big { font-weight: 700 } .sec { margin-top: 6px; font-weight: 700 }
    .box { border: 1px solid #000; min-width: 22mm; height: 6mm; display: inline-block }
    .logo { display: block; max-width: 60%; max-height: 22mm; margin: 0 auto 3px }
  </style></head><body>${inner}</body></html>`;
}
// The shop's own logo (Settings → Printing), already black and white for the receipt printer. None set = the slip starts with the name.
const slipLogo = (s) => (/^data:image\/png;base64,/.test(s.receipt_logo || '') ? `<img class="logo" src="${s.receipt_logo}" alt="">` : '');
export const slipHead = (title, s = state.settings) => `<div class="c">${slipLogo(s)}<div class="shop">${esc(s.shop_name || t('app_name'))}</div>${title ? `<div class="big">${esc(title)}</div>` : ''}</div>`;
export const slipLine = (label, value, cls = '') => `<div class="l ${cls}"><span>${label}</span><span class="a">${value}</span></div>`;
export const slipMoney = fmtMoney;
export const slipStamp = stamp;

// Print a slip on the receipt printer (desktop) or through the browser's print window.
export async function printSlip(inner, title = 'slip', settingsOverride) {
  const s = settingsOverride || state.settings;
  const html = slipDocument(inner, s, title);
  if (desktop()) {
    try {
      const [r] = await window.psmDesktop.print([{ title, html }], { printer: s.printer || '', paper: s.paper || '80', direct: s.print_mode !== 'driver' });
      if (r && !r.ok) toast(`${t('print_failed')}: ${r.error}`, true);
      return r || { ok: false };
    } catch (err) { toast(`${t('print_failed')}: ${err.message}`, true); return { ok: false }; }
  }
  const w = window.open('', '_blank', 'width=380,height=640');
  if (!w) { toast(t('popup_blocked'), true); return { ok: false }; }
  w.document.write(html.replace('</body>', '<script>window.onload=()=>{window.print();setTimeout(()=>window.close(),300)}<\/script></body>'));
  w.document.close();
  return { ok: true };
}

// A complete, self-contained HTML page for one receipt, sized for the receipt roll.
export function receiptDocument(inv, s = state.settings) {
  return slipDocument(receiptInner(inv, s), s, `#${inv.id}`);
}
function receiptInner(inv, s) {
  const rows = [];
  if (inv.session) rows.push([`${t('playtime')} — ${inv.session.console_name}`, mins(inv.session.minutes), inv.time_amount]);
  for (const it of mergeItems(inv.items)) rows.push([it.name, `×${it.qty}`, it.qty * it.price]);
  const pays = (inv.payments || []).filter((p) => p.kind !== 'refund');
  const remaining = inv.total - inv.paid;
  return `
    <div class="c">${slipLogo(s)}<div class="shop">${esc(s.shop_name || t('app_name'))}</div>
      ${s.receipt_header ? `<div class="muted">${textBlock(s.receipt_header)}</div>` : ''}
      <div class="muted">${t('invoice')} #${inv.id} · ${stamp(inv.closed_at || inv.created_at)}</div>
      ${inv.user_name ? `<div class="muted">${t('cashier')}: ${esc(inv.user_name)}</div>` : ''}
      ${inv.customer ? `<div>${t('customer')}: ${esc(inv.customer.name)}</div>` : ''}</div>
    <hr>
    ${rows.map(([n, q, a]) => `<div class="l"><span>${esc(n)}</span><span class="q">${esc(q)}</span><span class="a">${fmtMoney(a)}</span></div>`).join('')}
    <hr>
    ${inv.discount ? `<div class="l"><span>${t('discount')}</span><span class="a">-${fmtMoney(inv.discount)}</span></div>` : ''}
    <div class="l tot"><span>${t('total')}</span><span class="a">${fmtMoney(inv.total)}</span></div>
    ${pays.map((p) => `<div class="l"><span>${t('method.' + p.method)}</span><span class="a">${fmtMoney(p.amount)}</span></div>`).join('')}
    ${remaining > 0.001 && inv.status !== 'void' ? `<div class="l big"><span>${t('remaining_credit')}</span><span class="a">${fmtMoney(remaining)}</span></div>` : ''}
    ${inv.status === 'void' ? `<div class="c big">${t('status.void')}</div>` : ''}
    ${s.receipt_footer ? `<hr><div class="c">${textBlock(s.receipt_footer)}</div>` : ''}`;
}

// Print one invoice. Never throws — a printer problem must not lose the sale; it is shown as a message instead.
export async function printInvoice(inv, settingsOverride) {
  const s = settingsOverride || state.settings;
  return printSlip(receiptInner(inv, s), `receipt-${inv.id}`, s);
}

export async function openDrawer(silentFail = false) {
  if (!desktop()) return { ok: false };
  try {
    const r = await window.psmDesktop.openDrawer(state.settings.printer || '');
    if (!r.ok && !silentFail) toast(`${t('drawer_failed')}: ${r.error}`, true);
    return r;
  } catch (err) { if (!silentFail) toast(err.message, true); return { ok: false }; }
}

// A sample receipt for "Print a test".
export function testInvoice() {
  const now = Date.now();
  return {
    id: 123, created_at: now, closed_at: now, user_name: state.user?.name, status: 'closed',
    session: { console_name: 'PS5 - 1', minutes: 95 }, time_amount: 65,
    items: [{ name: 'Pepsi', qty: 2, price: 20 }, { name: 'Chips', qty: 1, price: 12 }],
    discount: 0, total: 117, paid: 117, payments: [{ kind: 'invoice', method: 'cash', amount: 117 }],
  };
}
