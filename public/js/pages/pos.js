import { t } from '../i18n.js';
import { state, get, post, esc, money, moneyText, icon, toast, toastErr, delegate } from '../core.js';
import { payDialog, afterPayment } from './shared.js';

export async function render(root) {
  let products = await get('/products');
  state.shift = await get('/shifts/current');
  const cart = new Map(); // product_id -> qty
  let filter = '';
  let cat = '';

  const cats = () => [...new Set(products.map((p) => p.category || ''))];
  const total = () => [...cart].reduce((s, [id, q]) => s + q * products.find((p) => p.id === id).sell_price, 0);

  function draw() {
    const list = products.filter((p) => (!cat || (p.category || '') === cat) && (!filter || p.name.toLowerCase().includes(filter)));
    root.innerHTML = `<div class="page-head"><h1>${t('nav.pos')}</h1></div>
      ${!state.shift ? `<div class="banner warn">${icon('alert')} ${t('no_shift_banner')} <a class="btn btn-sm" href="#/shift">${t('open_shift')}</a></div>` : ''}
      <div class="pos">
        <div class="card stack">
          <div class="row"><input type="search" data-search placeholder="${t('search')}" value="${esc(filter)}" style="flex:1;min-width:160px">
            <div class="seg">${['', ...cats()].map((c) => `<button data-act="cat" data-c="${esc(c)}" class="${c === cat ? 'on' : ''}">${esc(c === '' ? t('all') : c || t('other'))}</button>`).join('')}</div></div>
          <div class="product-grid">${list.map((p) => `<button class="product-tile" data-act="add" data-id="${p.id}" ${p.stock - (cart.get(p.id) || 0) <= 0 ? 'disabled' : ''}>
            <span class="pn">${esc(p.name)}</span><span class="pp">${money(p.sell_price)}</span>
            <span class="ps">${t('stock')}: <span class="num">${p.stock - (cart.get(p.id) || 0)}</span></span></button>`).join('') || `<div class="empty">${t('no_products')}</div>`}</div>
        </div>
        <div class="card">
          <div class="card-head"><h2>${t('cart')}</h2><span class="spacer"></span>${cart.size ? `<button class="btn btn-sm btn-ghost" data-act="clear">${t('clear')}</button>` : ''}</div>
          ${cart.size ? [...cart].map(([id, q]) => { const p = products.find((x) => x.id === id); return `<div class="cart-line">
            <div class="grow"><b>${esc(p.name)}</b><div class="muted small">${moneyText(p.sell_price)}</div></div>
            <div class="qty"><button data-act="dec" data-id="${id}" aria-label="-">−</button><b class="num" style="min-width:24px;text-align:center">${q}</b><button data-act="add" data-id="${id}" aria-label="+" ${q >= p.stock ? 'disabled' : ''}>+</button></div>
            <b class="num" style="min-width:64px;text-align:end">${moneyText(q * p.sell_price)}</b></div>`; }).join('') : `<div class="empty">${t('cart_empty')}</div>`}
          <div class="totals"><div class="line grand"><span>${t('total')}</span><span>${money(total())}</span></div></div>
          <button class="btn btn-good btn-lg btn-block" data-act="pay" ${cart.size ? '' : 'disabled'}>${icon('check')} ${t('pay')}</button>
        </div>
      </div>`;
    const s = root.querySelector('[data-search]');
    s.addEventListener('input', () => { filter = s.value.trim().toLowerCase(); draw(); const n = root.querySelector('[data-search]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
  }

  delegate(root, {
    cat: (b) => { cat = b.dataset.c; draw(); },
    add: (b) => { const id = Number(b.dataset.id); cart.set(id, (cart.get(id) || 0) + 1); draw(); },
    dec: (b) => { const id = Number(b.dataset.id); const q = (cart.get(id) || 0) - 1; if (q <= 0) cart.delete(id); else cart.set(id, q); draw(); },
    clear: () => { cart.clear(); draw(); },
    pay: async () => {
      if (!state.shift) return toast(t('err.no_open_shift'), true);
      const lines = [...cart].map(([id, q]) => { const p = products.find((x) => x.id === id); return { label: `${p.name} ×${q}`, amount: q * p.sell_price }; });
      const pay = await payDialog({ title: t('checkout'), sub: t('quick_sale'), lines, gross: total() });
      if (!pay) return;
      try {
        const inv = await post('/sales', { ...pay, items: [...cart].map(([product_id, qty]) => ({ product_id, qty })) });
        cart.clear();
        products = await get('/products');
        draw();
        afterPayment(inv, pay);
      } catch (err) { toastErr(err); }
    },
  });
  draw();
}
