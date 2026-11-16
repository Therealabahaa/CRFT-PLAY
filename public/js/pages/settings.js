import { t, deviceLang, setDeviceLang, setDefaultLang } from '../i18n.js';
import { state, get, post, put, del, esc, money, icon, field, opt, formBox, toast, toastErr, delegate, fmtDateTime, dayKey, can, confirmBox, fmtMinutes, busy } from '../core.js';
import { desktop, printInvoice, openDrawer, receiptDocument, testInvoice } from '../print.js';

const PERMS = ['discount', 'refund', 'inventory', 'expenses', 'reports', 'manage'];

export async function render(root) {
  const manage = can('manage');
  const tabs = manage ? ['consoles', 'packages', 'general', 'printing', 'online', 'telegram', 'staff', 'language', 'signins', 'backups', 'audit'] : ['staff', 'language'];
  let tab = location.hash.includes('tab=') ? location.hash.split('tab=')[1] : tabs[0];
  if (!tabs.includes(tab)) tab = tabs[0];
  let auditDay = dayKey();

  async function draw() {
    let body = '';
    if (tab === 'consoles') {
      // Rooms & prices: each room is just a name and ONE fixed price per hour (however many people play).
      const list = await get('/consoles');
      body = `<div class="card"><div class="card-head"><h2>🚪 ${t('rooms')}</h2><span class="spacer"></span><button class="btn btn-primary" data-act="console">${icon('plus')} ${t('add_room')}</button></div>
        <p class="muted small" style="margin:0 0 10px">${t('rooms_hint')}</p>
        <div class="table-wrap"><table><thead><tr><th>${t('room')}</th><th class="n">${t('price_per_hour')}</th><th>${t('status')}</th><th>${t('notes')}</th><th></th></tr></thead>
        <tbody>${list.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td class="n"><b>${money(c.rate_single)}</b> / ${t('hr')}</td>
          <td>${c.status === 'active' ? `<span class="pill good"><span class="dot"></span>${t('active')}</span>` : `<span class="pill warn"><span class="dot"></span>${t('status.maintenance')}</span>`}</td>
          <td class="muted small">${esc(c.notes || '')}</td>
          <td><div class="row" style="justify-content:flex-end"><button class="btn btn-sm" data-act="console" data-id="${c.id}">${icon('edit')} ${t('edit')}</button>
          <button class="icon-btn" data-act="console-del" data-id="${c.id}" aria-label="${t('delete')}">${icon('trash')}</button></div></td></tr>`).join('') || `<tr><td colspan="5" class="empty">${t('no_consoles')}</td></tr>`}</tbody></table></div></div>`;
      root._consoles = list;
    } else if (tab === 'packages') {
      const list = await get('/packages');
      body = `<div class="card"><div class="card-head"><h2>${t('packages')}</h2><span class="spacer"></span><button class="btn btn-primary" data-act="package">${icon('plus')} ${t('add_package')}</button></div>
        <div class="table-wrap"><table><thead><tr><th>${t('name')}</th><th>${t('duration')}</th><th class="n">${t('price')}</th><th>${t('status')}</th><th></th></tr></thead>
        <tbody>${list.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td>${fmtMinutes(p.minutes)}</td>
          <td class="n">${money(p.price)}</td><td>${p.active ? `<span class="pill good">${t('active')}</span>` : `<span class="pill">${t('inactive')}</span>`}</td>
          <td><button class="icon-btn" data-act="package" data-id="${p.id}" aria-label="${t('edit')}">${icon('edit')}</button></td></tr>`).join('') || `<tr><td colspan="7" class="empty">${t('no_records')}</td></tr>`}</tbody></table></div>
        <p class="muted small">${t('packages_hint')}</p></div>`;
      root._packages = list;
    } else if (tab === 'general') {
      const s = await get('/settings');
      body = `<form class="card stack" data-general style="max-width:720px"><h2>${t('general')}</h2><div class="form-grid">
        ${field(t('shop_name'), `<input name="shop_name" value="${esc(s.shop_name)}">`)}
        ${field(t('round_to'), `<input name="round_to" type="number" min="0" step="any" value="${esc(s.round_to)}">`)}
        ${field(t('min_minutes'), `<input name="min_minutes" type="number" min="0" value="${esc(s.min_minutes)}">`)}
        ${field(t('grace_minutes'), `<input name="grace_minutes" type="number" min="0" value="${esc(s.grace_minutes)}">`)}</div>
        <p class="muted small" style="margin:0">${t('pricing_rules_hint')}</p>
        <h3 style="margin-top:8px">🏷 ${t('discounts')}</h3>
        <div class="form-grid">
          ${field(t('max_discount_pct'), `<input name="max_discount_pct" type="number" min="0" max="100" step="1" value="${esc(s.max_discount_pct)}">`)}
          ${field(t('max_discount_egp'), `<input name="max_discount_egp" type="number" min="0" step="1" value="${esc(s.max_discount_egp)}" placeholder="${t('no_limit')}">`)}
        </div>
        <p class="muted small" style="margin:0">${t('discount_limit_hint')}</p>
        <div><button class="btn btn-primary" data-act="save-general">${t('save')}</button></div></form>
        ${desktop() ? `<div class="card stack" style="max-width:720px"><h2>${t('when_pc_starts')}</h2>
          <label class="check"><input type="checkbox" data-autostart ${(await window.psmDesktop.autostart()) ? 'checked' : ''}> <span><b>${t('autostart')}</b> <span class="muted">${t('autostart_hint')}</span></span></label></div>` : ''}`;
    } else if (tab === 'printing') {
      const s = await get('/settings');
      const printers = desktop() ? await window.psmDesktop.printers().catch(() => []) : [];
      const def = printers.find((p) => p.isDefault);
      body = `<form class="card stack" data-printing style="max-width:720px"><h2>${icon('print')} ${t('printing')}</h2>
        <label class="check"><input type="checkbox" name="auto_print" ${s.auto_print !== '0' ? 'checked' : ''}> ${t('auto_print')}</label>
        ${desktop() ? `<div class="form-grid">
            ${field(t('printer'), `<select name="printer">${opt('', t('windows_default') + (def ? ' — ' + def.label : ''), s.printer)}${opt('__ask', t('ask_each_time'), s.printer)}
              ${printers.map((p) => opt(p.name, p.label, s.printer)).join('')}</select>`)}
            ${field(t('paper_width'), `<select name="paper">${opt('80', t('paper_80'), s.paper)}${opt('58', t('paper_58'), s.paper)}</select>`)}
          </div>
          ${field(t('print_mode'), `<select name="print_mode">${opt('direct', t('print_direct'), s.print_mode)}${opt('driver', t('print_driver'), s.print_mode)}</select>`)}
          <p class="muted small" style="margin:0">${t('print_mode_hint')}</p>
          <label class="check"><input type="checkbox" name="open_drawer_on_cash" ${s.open_drawer_on_cash === '1' ? 'checked' : ''}> ${t('drawer_on_cash')}</label>
          <p class="muted small" style="margin:0">${t('drawer_hint')}</p>`
        : `<div class="banner info">${icon('alert')} ${t('printer_desktop_only')}</div>`}
        <h3 style="margin-top:6px">${t('receipt')}</h3>
        ${field(t('receipt_header'), `<textarea name="receipt_header" rows="2" maxlength="200" placeholder="${t('receipt_header_ph')}">${esc(s.receipt_header || '')}</textarea>`)}
        ${field(t('receipt_footer'), `<textarea name="receipt_footer" rows="2" maxlength="200" placeholder="${t('receipt_footer_ph')}">${esc(s.receipt_footer || '')}</textarea>`)}
        <div class="stack"><b class="small">${t('receipt_logo')}</b><div class="row" style="align-items:center;flex-wrap:wrap">
          ${s.receipt_logo ? `<img src="${s.receipt_logo}" alt="" style="max-width:200px;max-height:100px;padding:6px;background:#fff;border:1px solid var(--line);border-radius:6px">` : `<span class="muted small">${t('receipt_logo_none')}</span>`}
          <button type="button" class="btn" data-act="logo-pick">${t('receipt_logo_choose')}</button>${s.receipt_logo ? `<button type="button" class="btn" data-act="logo-rm">${t('remove')}</button>` : ''}
          <input type="file" data-logo-file accept="image/*" hidden></div>
          <p class="muted small" style="margin:0">${t('receipt_logo_hint')}</p></div>
        <div class="row"><button class="btn btn-primary" data-act="save-printing">${t('save')}</button>
          <button class="btn" data-act="test-print">${icon('print')} ${t('test_print')}</button>
          ${desktop() ? `<button class="btn" data-act="open-drawer">${icon('wallet')} ${t('open_drawer')}</button>` : ''}</div>
        <div><b class="small">${t('preview')}</b><iframe data-preview style="display:block;margin-top:6px;width:${s.paper === '58' ? 240 : 320}px;height:420px;border:1px solid var(--line);border-radius:8px;background:#fff"></iframe></div></form>`;
    } else if (tab === 'online') {
      // 🌐 the price list on crft.live/m/<name> (src/online.js): customers open it on their own mobile data, no shop Wi-Fi needed
      const o = await get('/online-menu');
      const suggest = o.slug || String(state.settings.shop_name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      body = `<div class="card stack" style="max-width:720px"><h2>🌐 ${t('om_title')}</h2>
        <p class="muted small" style="margin:0">${t('om_intro')}</p>
        <label class="check"><input type="checkbox" data-om-on ${o.on ? 'checked' : ''}> <b>${t('om_on')}</b></label>
        ${field(t('om_address'), `<div class="row" style="flex-wrap:nowrap;align-items:center" dir="ltr"><span class="muted">crft.live/m/</span><input data-om-slug value="${esc(suggest)}" maxlength="40" placeholder="my-lounge" autocomplete="off" spellcheck="false"><button class="btn" data-act="om-save">${t('save')}</button></div>`)}
        <p class="muted small" data-om-hint style="margin:0">${t('om_hint')}</p>
        ${o.on && o.slug ? (o.published
          ? `<div class="banner info" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap"><img data-om-qr src="${o.qr}" alt="QR" style="width:140px;height:140px;background:#fff;border-radius:6px;image-rendering:pixelated">
              <div style="flex:1;min-width:200px">✅ <b>${t('om_live')}</b>${o.at ? ` <span class="muted small">· ${fmtDateTime(o.at)}</span>` : ''}<br><a href="${esc(o.url)}" target="_blank" rel="noopener" dir="ltr">${esc(o.url)}</a>
                <div class="row" style="margin-top:10px"><button class="btn" data-act="om-dl">${t('om_download_qr')}</button><button class="btn" data-act="om-now">${t('om_update_now')}</button></div>
                <p class="muted small" style="margin:6px 0 0">${t('om_qr_stays')}</p></div></div>`
          : `<div class="banner warn">${o.error ? esc(o.error) : t('om_sending')} <button class="btn btn-sm" data-act="om-now">${t('om_try_again')}</button></div>`) : ''}
      </div>`;
      root._online = o;
    } else if (tab === 'telegram') {
      const c = await get('/telegram');
      const isReady = c.token_set && c.chat;
      body = `<div class="card stack" style="max-width:720px"><h2>✈️ ${t('telegram_title')}</h2>
        <p class="muted small" style="margin:0">${t('telegram_intro')}</p>
        ${isReady ? `<div class="banner info">${icon('check')} ${t('telegram_ready')}</div>` : `<div class="banner warn" style="display:block;line-height:1.7">${t('telegram_setup')}</div>`}
        <form class="stack" data-tg>
          ${field(t('bot_token'), `<input name="token" type="password" autocomplete="off" placeholder="${c.token_set ? t('saved_type_to_replace') : '123456789:AA...'}">`)}
          <div class="row" style="align-items:flex-end;flex-wrap:nowrap">${field(t('chat_id'), `<input name="chat" autocomplete="off" value="${esc(c.chat || '')}">`, 'grow')}
            <button class="btn" type="button" data-act="tg-find">${t('find_my_chat')}</button></div>
          <h3>${t('send_when')}</h3>
          <label class="check"><input type="checkbox" name="important" ${c.important ? 'checked' : ''}> <span>${t('tg_important')}</span></label>
          <label class="check"><input type="checkbox" name="shift_report" ${c.shift_report ? 'checked' : ''}> <span>${t('tg_shift_report')}</span></label>
          <label class="check"><input type="checkbox" name="low_stock" ${c.low_stock ? 'checked' : ''}> <span>${t('tg_low_stock')}</span></label>
          <h3>${t('the_bot')}</h3>
          <label class="check"><input type="checkbox" name="commands" ${c.commands ? 'checked' : ''}> <span>${t('tg_commands')}</span></label>
          <p class="muted small" style="margin:0">${t('tg_open_hint')}</p>
          <div class="row"><button class="btn btn-primary" data-act="tg-save">${t('save')}</button><button class="btn" data-act="tg-test">${t('send_test')}</button></div>
        </form>
        ${c.recent.length ? `<h3>${t('recently_sent')}</h3><div class="table-wrap"><table><tbody>${c.recent.map((r) => `<tr><td>${r.ok ? '✅' : '❌'}</td>
          <td class="small" style="white-space:pre-line">${esc(String(r.text || '').split('\n').slice(1, 3).join('\n'))}${r.ok ? '' : `<div style="color:var(--crit-ink)">${esc(r.error || '')}</div>`}</td>
          <td class="muted small num">${fmtDateTime(r.created_at)}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>`;
    } else if (tab === 'language') {
      const dev = deviceLang();
      const shop = state.settings.language === 'en' ? 'en' : 'ar';
      const choice = (val, label, sub, on) => `<button class="lang-choice ${on ? 'on' : ''}" data-act="device-lang" data-l="${val}">
        <b>${label}</b><span class="muted small">${sub}</span>${on ? `<span class="pill info">${icon('check')} ${t('selected')}</span>` : ''}</button>`;
      body = `<div class="card stack" style="max-width:720px"><h2>${t('language_this_device')}</h2>
          <p class="muted small" style="margin:0">${t('language_device_hint')}</p>
          <div class="lang-choices">
            ${choice('ar', 'العربية', 'من اليمين لليسار', dev === 'ar')}
            ${choice('en', 'English', 'Left to right', dev === 'en')}
            ${choice('', t('follow_shop_default'), shop === 'ar' ? 'العربية' : 'English', !dev)}
          </div></div>
        ${manage ? `<div class="card stack" style="max-width:720px"><h2>${t('shop_default_language')}</h2>
          <p class="muted small" style="margin:0">${t('shop_default_language_hint')}</p>
          <div class="row"><select data-shop-lang style="max-width:240px">${opt('ar', 'العربية', shop)}${opt('en', 'English', shop)}</select>
          <button class="btn btn-primary" data-act="save-shop-lang">${t('save')}</button></div></div>` : ''}`;
    } else if (tab === 'staff') {
      // Kur's Staff screen: everyone who uses the till, their role and status. Staff sign in by picking their name.
      const list = manage ? await get('/users') : [];
      const pw = `<form class="card stack" data-pw style="max-width:520px"><h2>${icon('shield')} ${t('change_my_password')}</h2>
        <div class="muted">${esc(state.user.name)} — ${t('role.' + state.user.role)}</div>
        ${field(t('current_password'), '<input type="password" name="current" autocomplete="current-password">')}
        ${field(t('new_password'), '<input type="password" name="password" autocomplete="new-password">')}
        ${field(t('confirm_password'), '<input type="password" name="password2" autocomplete="new-password">')}
        <div><button class="btn btn-primary" data-act="save-pw">${t('save')}</button></div></form>`;
      body = (manage ? `<div class="card"><div class="card-head"><h2>${icon('users')} ${t('staff_title')}</h2><span class="spacer"></span><button class="btn btn-primary" data-act="user">${icon('plus')} ${t('add_staff')}</button></div>
        <div class="table-wrap"><table><thead><tr><th>${t('name')}</th><th>${t('role')}</th><th>${t('permissions')}</th><th>${t('status')}</th><th></th></tr></thead>
        <tbody>${list.map((u) => `<tr><td><b>${esc(u.name)}</b>${u.id === state.user.id ? ` <span class="pill info">${t('you')}</span>` : ''}</td>
          <td>${u.role === 'admin' ? '👑 ' : ''}${t('role.' + u.role)}</td>
          <td class="small">${u.role === 'admin' ? t('all_permissions') : u.perms.map((p) => t('perm.' + p)).join('، ') || `<span class="muted">${t('cashier_basics')}</span>`}</td>
          <td>${u.active ? `<span class="pill good"><span class="dot"></span>${t('active')}</span>` : `<span class="pill"><span class="dot"></span>${t('disabled')}</span>`}</td>
          <td style="text-align:end"><button class="btn btn-sm" data-act="user" data-id="${u.id}">${icon('edit')} ${t('edit')}</button></td></tr>`).join('')}</tbody></table></div>
        <p class="muted small">${t('staff_hint')}</p></div>` : '') + pw;
      root._users = list;
    } else if (tab === 'signins') {
      const list = await get('/login-log');
      body = `<div class="card"><div class="card-head"><h2>${t('tab.signins')}</h2></div>
        <div class="table-wrap"><table><thead><tr><th>${t('time')}</th><th>${t('user')}</th><th>${t('action')}</th><th>${t('result')}</th><th>${t('details')}</th></tr></thead>
        <tbody>${list.map((l) => `<tr><td class="num">${fmtDateTime(l.created_at)}</td><td>${esc(l.user_name || '—')}</td><td>${t('login.' + l.action)}</td>
          <td>${l.success ? `<span class="pill good">${icon('check')} ${t('success')}</span>` : `<span class="pill crit">${icon('x')} ${t('failed')}</span>`}</td>
          <td class="muted small">${l.reason ? esc(t('reason.' + l.reason) === 'reason.' + l.reason ? l.reason : t('reason.' + l.reason)) : ''}</td></tr>`).join('')
          || `<tr><td colspan="5" class="empty">${t('no_records')}</td></tr>`}</tbody></table></div></div>`;
    } else if (tab === 'backups') {
      const b = await get('/backups');
      const s = await get('/settings');
      body = `<div class="card stack"><div class="card-head"><h2>${t('backups')}</h2><span class="spacer"></span><button class="btn btn-primary" data-act="backup">${icon('shield')} ${t('backup_now')}</button></div>
        <form class="form-grid" data-backup-settings>
          ${field(t('backup_every_hours'), `<input name="backup_every_hours" type="number" min="0" step="any" value="${esc(s.backup_every_hours)}">`)}
          ${field(t('backup_keep'), `<input name="backup_keep" type="number" min="1" value="${esc(s.backup_keep)}">`)}
          ${desktop()
            ? field(t('backup_dir'), `<div class="row" style="flex-wrap:nowrap"><input name="backup_dir" value="${esc(s.backup_dir)}" placeholder="${esc(b.dir)}" readonly>
                <button type="button" class="btn" data-act="pick-backup-dir">📁 ${t('choose_folder')}</button></div>`, 'span-2')
            : field(t('backup_dir'), `<input name="backup_dir" value="${esc(s.backup_dir)}" placeholder="${esc(b.dir)}">`)}
          <div style="align-self:end"><button class="btn" data-act="save-backup">${t('save')}</button></div></form>
        <p class="muted small" style="margin:0">${desktop() ? t('backup_hint_desktop') : t('backup_hint')} <span class="num">${esc(b.dir)}</span></p>
        ${desktop() ? `<div><button class="btn btn-sm" data-act="open-backups">📂 ${t('open_backup_folder')}</button></div>` : ''}
        <div class="table-wrap"><table><thead><tr><th>${t('file')}</th><th>${t('time')}</th><th class="n">${t('size')}</th><th></th></tr></thead>
        <tbody>${b.files.map((f) => `<tr><td class="num">${esc(f.name)}</td><td>${fmtDateTime(f.created_at)}</td><td class="n num">${Math.round(f.size / 1024)} KB</td>
          <td><div class="row" style="justify-content:flex-end">${desktop() ? `<button class="btn btn-sm" data-act="restore" data-name="${esc(f.name)}">↩️ ${t('restore')}</button>` : ''}
            <a class="btn btn-sm" href="/api/backups/${encodeURIComponent(f.name)}" download draggable="false">${icon('download')} ${desktop() ? t('save_copy') : t('download')}</a></div></td></tr>`).join('') || `<tr><td colspan="4" class="empty">${t('no_records')}</td></tr>`}</tbody></table></div></div>`;
    } else if (tab === 'audit') {
      const list = await get(`/audit?from=${auditDay}&to=${auditDay}`);
      body = `<div class="card"><div class="card-head"><h2>${t('audit_log')}</h2><span class="spacer"></span><input type="date" data-audit-day value="${auditDay}" style="width:auto"></div>
        <div class="table-wrap"><table><thead><tr><th>${t('time')}</th><th>${t('user')}</th><th>${t('action')}</th><th>${t('details')}</th></tr></thead>
        <tbody>${list.map((a) => `<tr><td class="num">${fmtDateTime(a.created_at)}</td><td>${esc(a.user_name || '')}</td><td>${esc(t('act.' + a.action) === 'act.' + a.action ? a.action : t('act.' + a.action))}</td>
          <td class="small muted num" style="max-width:420px;overflow-wrap:anywhere">${esc(a.details || '')}</td></tr>`).join('') || `<tr><td colspan="4" class="empty">${t('no_records')}</td></tr>`}</tbody></table></div></div>`;
    }
    root.innerHTML = `<div class="page-head"><h1>${t('nav.settings')}</h1></div>
      ${tabs.length > 1 ? `<div class="seg" style="flex-wrap:wrap">${tabs.map((x) => `<button data-act="tab" data-t="${x}" class="${x === tab ? 'on' : ''}">${t('tab.' + x)}</button>`).join('')}</div>` : ''}
      ${body}`;
    const ad = root.querySelector('[data-audit-day]');
    if (ad) ad.addEventListener('change', () => { auditDay = ad.value || dayKey(); draw(); });
    const omOn = root.querySelector('[data-om-on]'), omSlug = root.querySelector('[data-om-slug]');
    if (omOn) omOn.addEventListener('change', async () => {
      if (omOn.checked && !omSlug.value.trim()) { omOn.checked = false; omSlug.focus(); return toast(t('om_type_address'), true); }
      try { state.settings = await put('/settings', { online_menu: omOn.checked ? '1' : '0', online_slug: omSlug.value }); toast(omOn.checked ? t('om_sending') : t('om_taken_down')); draw(); }
      catch (e) { toastErr(e); }
    });
    if (omSlug) {
      let timer;
      omSlug.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const r = await get('/online-menu/check?slug=' + encodeURIComponent(omSlug.value)).catch(() => null);
          const hint = root.querySelector('[data-om-hint]');
          if (!r || !hint) return;
          hint.textContent = r.slug === root._online.slug && root._online.published ? t('om_yours') : r.available ? `✓ crft.live/m/${r.slug} ${t('om_free')}` : (r.error || `crft.live/m/${r.slug} ${t('om_taken')}`);
        }, 500);
      });
    }
    const as = root.querySelector('[data-autostart]');
    if (as) as.addEventListener('change', async () => { const on = await window.psmDesktop.autostart(as.checked); as.checked = !!on; toast(on ? t('autostart_on') : t('autostart_off')); });
    const pf = root.querySelector('[data-printing]');
    if (pf) {
      const preview = () => {
        const s = { ...state.settings, ...printingVals() };
        const fr = pf.querySelector('[data-preview]');
        fr.style.width = (s.paper === '58' ? 200 : 290) + 'px';
        fr.srcdoc = receiptDocument(testInvoice(), s);
      };
      pf.addEventListener('input', preview);
      pf.addEventListener('change', preview);
      preview();
    }
  }

  const printingVals = () => {
    const f = root.querySelector('[data-printing]');
    const v = {};
    f.querySelectorAll('[name]').forEach((i) => { v[i.name] = i.type === 'checkbox' ? (i.checked ? '1' : '0') : i.value; });
    return v;
  };
  const tgVals = () => {
    const f = root.querySelector('[data-tg]');
    const v = {};
    f.querySelectorAll('[name]').forEach((i) => { v[i.name] = i.type === 'checkbox' ? i.checked : i.value; });
    return v;
  };

  const formVals = (sel) => Object.fromEntries([...root.querySelectorAll(`${sel} [name]`)].map((i) => [i.name, i.value]));
  // A chosen picture made ready for the receipt printer: scaled to fit the roll, then each dot solid black or white (a thermal printer has
  // no grey). Done once here, so what Settings shows is exactly what prints. Returns a PNG data: URL.
  const printableLogo = (file) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error(t('err.not_a_picture')));
    img.onload = () => {
      const k = Math.min(1, 384 / img.width, 200 / img.height), w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h); // a transparent logo prints on white paper
      const px = g.getImageData(0, 0, w, h);
      for (let i = 0; i < px.data.length; i += 4) { const v = 0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2] < 128 ? 0 : 255; px.data[i] = px.data[i + 1] = px.data[i + 2] = v; px.data[i + 3] = 255; }
      g.putImageData(px, 0, 0); resolve(c.toDataURL('image/png'));
    };
    const r = new FileReader();
    r.onerror = () => reject(new Error(t('err.not_a_picture')));
    r.onload = () => { img.src = r.result; };
    r.readAsDataURL(file);
  });
  root.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-logo-file]')) return;
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    run(async () => { state.settings = await put('/settings', { receipt_logo: await printableLogo(file) }); }, t('receipt_logo_saved'));
  });
  const run = async (fn, msg = t('saved')) => { try { await fn(); toast(msg); draw(); } catch (err) { toastErr(err); } };

  delegate(root, {
    tab: (b) => { tab = b.dataset.t; draw(); },
    console: async (b) => {
      const c = b.dataset.id ? root._consoles.find((x) => x.id === Number(b.dataset.id)) : null;
      // a room = a name + one fixed price per hour
      const v = await formBox(c ? t('edit_room') : t('add_room'),
        field(t('room_name'), `<input name="name" value="${esc(c?.name || '')}" placeholder="${t('room_name_ph')}" required>`) +
        field(t('price_per_hour'), `<input name="rate_single" type="number" step="any" min="0" value="${c?.rate_single ?? ''}" placeholder="${t('egp')}" required>`) +
        field(t('status'), `<select name="status">${opt('active', t('active'), c?.status)}${opt('maintenance', t('status.maintenance'), c?.status)}</select>`) +
        field(t('notes'), `<input name="notes" value="${esc(c?.notes || '')}" placeholder="${t('room_notes_ph')}">`),
        { validate: (x) => (!x.name.trim() ? t('err.name_required') : !(Number(x.rate_single) > 0) ? t('err.price_required') : null) });
      if (v) run(() => post('/consoles', { ...(c || {}), ...v, id: c?.id }));
    },
    room: async (b) => {
      const r = b.dataset.id ? root._rooms.find((x) => x.id === Number(b.dataset.id)) : null;
      const v = await formBox(r ? t('edit_room') : t('add_room'),
        field(t('room_name'), `<input name="name" value="${esc(r?.name || '')}" placeholder="${t('room_name_ph')}" required>`) +
        field(t('room_rate_single'), `<input name="rate_single" type="number" step="any" min="0" value="${r?.rate_single ?? ''}" placeholder="${t('egp')}/${t('hr')}">`) +
        field(t('room_rate_multi'), `<input name="rate_multi" type="number" step="any" min="0" value="${r?.rate_multi ?? ''}" placeholder="${t('egp')}/${t('hr')}">`) +
        field(t('notes'), `<input name="notes" value="${esc(r?.notes || '')}" placeholder="${t('room_notes_ph')}">`, 'span-2') +
        `<p class="muted small" style="grid-column:1/-1;margin:0">${t('room_rate_hint')}</p>`,
        { validate: (x) => (!x.name.trim() ? t('err.name_required') : null) });
      if (v) run(() => post('/rooms', { ...v, id: r?.id }));
    },
    'room-del': async (b) => {
      if (await confirmBox(t('confirm_delete_room'), { danger: true, okText: t('delete') })) run(() => del(`/rooms/${b.dataset.id}`), t('deleted'));
    },
    'console-del': async (b) => {
      if (await confirmBox(t('confirm_delete'), { danger: true, okText: t('delete') })) run(() => del(`/consoles/${b.dataset.id}`), t('deleted'));
    },
    package: async (b) => {
      const p = b.dataset.id ? root._packages.find((x) => x.id === Number(b.dataset.id)) : null;
      const v = await formBox(p ? t('edit_package') : t('add_package'),
        field(t('name'), `<input name="name" value="${esc(p?.name || '')}" required>`) +
        field(t('duration_minutes'), `<input name="minutes" type="number" min="1" value="${p?.minutes ?? 120}">`) +
        field(t('price'), `<input name="price" type="number" step="any" min="0" value="${p?.price ?? 0}">`) +
        `<label class="check"><input type="checkbox" name="active" ${!p || p.active ? 'checked' : ''}> ${t('active')}</label>`,
        { validate: (x) => (!x.name.trim() ? t('err.name_required') : null) });
      if (v) run(() => post('/packages', { ...v, id: p?.id }));
    },
    user: async (b) => {
      const u = b.dataset.id ? root._users.find((x) => x.id === Number(b.dataset.id)) : null;
      const v = await formBox(u ? t('edit_staff') : t('add_staff'),
        field(t('name'), `<input name="name" value="${esc(u?.name || '')}" required>`) +
        field(t('role'), `<select name="role">${opt('cashier', t('role.cashier'), u?.role)}${state.user.role === 'admin' ? opt('admin', '👑 ' + t('role.admin'), u?.role) : ''}</select>`) +
        field(u ? t('new_password_keep') : t('starting_password'), '<input name="password" type="password" maxlength="40" autocomplete="new-password">', 'span-2') +
        `<div style="grid-column:1/-1" class="stack"><b class="small">${t('permissions')} <span class="muted">(${t('perms_hint')})</span></b><div class="row">
          ${PERMS.map((p) => `<label class="check"><input type="checkbox" name="perms" value="${p}" data-multi="1" ${u?.perms.includes(p) ? 'checked' : ''}> ${t('perm.' + p)}</label>`).join('')}</div></div>` +
        (u ? `<label class="check" style="grid-column:1/-1"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> ${t('active_can_sign_in')}</label>` : ''),
        { wide: true, validate: (x) => (!x.name.trim() ? t('err.name_required') : (!u && x.password.length < 4) || (x.password && x.password.length < 4) ? t('err.password_too_short') : null) });
      if (v) run(() => post('/users', { ...v, perms: v.perms || [], id: u?.id, username: u?.username, active: u ? v.active : true }));
    },
    'save-printing': (b) => busy(b, async () => { state.settings = await put('/settings', printingVals()); toast(t('saved')); }),
    // the receipt logo: saved on its own, straight away (it has no name="", so the printing form's Save never touches it)
    'logo-pick': () => root.querySelector('[data-logo-file]').click(),
    'logo-rm': () => run(async () => { state.settings = await put('/settings', { receipt_logo: '' }); }, t('removed')),
    'test-print': (b) => busy(b, async () => {
      const s = { ...state.settings, ...printingVals() };
      const r = await printInvoice(testInvoice(), s);
      if (r && r.ok) toast(t('test_sent'));
    }),
    'open-drawer': (b) => busy(b, async () => { const r = await openDrawer(); if (r.ok) toast(t('drawer_opened')); }),
    'tg-find': (b) => busy(b, async () => {
      const r = await post('/telegram/find-chat', { token: root.querySelector('[data-tg] [name=token]').value });
      root.querySelector('[data-tg] [name=chat]').value = r.chat_id;
      toast(`${t('tg_found')} ${r.name ? '“' + r.name + '”' : ''} — ${t('tg_now_save')}`);
    }),
    'om-save': (b) => busy(b, async () => {
      const o = root._online, slug = root.querySelector('[data-om-slug]').value.trim();
      if (o.published && o.slug && slug !== o.slug && !(await confirmBox(t('om_change_confirm')))) return;
      state.settings = await put('/settings', { online_slug: slug }); toast(t('saved')); draw();
    }),
    'om-now': (b) => busy(b, async () => { const r = await post('/online-menu/publish'); toast(r.published ? t('om_updated') : (r.error || t('om_sending')), !r.published); draw(); }),
    'om-dl': async () => { // a big PNG with a caption, ready to print or put on a stand
      const img = new Image(); img.src = root.querySelector('[data-om-qr]').src; await img.decode();
      const c = document.createElement('canvas'); c.width = 1200; c.height = 1450; const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingEnabled = false; g.drawImage(img, 100, 60, 1000, 1000);
      g.fillStyle = '#000'; g.textAlign = 'center'; g.font = 'bold 72px Tahoma, Arial'; g.fillText('امسح الكود وشوف الأسعار', 600, 1170);
      g.font = '48px Arial'; g.fillText('Scan for prices', 600, 1250);
      g.font = 'bold 44px Tahoma, Arial'; g.fillText(state.settings.shop_name || '', 600, 1340);
      const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = 'online-menu-qr.png'; a.click();
    },
    'tg-save': (b) => busy(b, async () => { await put('/telegram', tgVals()); toast(t('saved')); draw(); }),
    'tg-test': (b) => busy(b, async () => {
      await put('/telegram', tgVals());
      const r = await post('/telegram/test');
      if (r.ok) toast(t('tg_test_ok')); else toast(`${t('tg_test_fail')}: ${r.error}`, true);
      draw();
    }),
    'device-lang': (b) => {
      setDeviceLang(b.dataset.l || null, state.settings.language);
      location.hash = '#/settings?tab=language';
      window.dispatchEvent(new Event('psm:lang'));
      toast(t('saved'));
    },
    'save-shop-lang': (b) => busy(b, async () => {
      state.settings = await put('/settings', { language: root.querySelector('[data-shop-lang]').value });
      setDefaultLang(state.settings.language);
      location.hash = '#/settings?tab=language';
      window.dispatchEvent(new Event('psm:lang'));
      toast(t('saved'));
    }),
    'save-general': (b) => busy(b, async () => {
      const v = formVals('[data-general]');
      if (v.max_discount_pct !== '' && !(Number(v.max_discount_pct) >= 0 && Number(v.max_discount_pct) <= 100)) throw Object.assign(new Error(), { code: 'invalid_discount' });
      const s = await put('/settings', v); state.settings = s; toast(t('saved'));
    }),
    'save-backup': (b) => busy(b, async () => { await put('/settings', formVals('[data-backup-settings]')); toast(t('saved')); draw(); }),
    backup: (b) => busy(b, async () => { const r = await post('/backups'); toast(`${t('backup_done')}: ${r.name}`); draw(); }),
    'pick-backup-dir': async () => {
      const dir = await window.psmDesktop.pickFolder(t('backup_dir'));
      if (dir) root.querySelector('[name=backup_dir]').value = dir;
    },
    'open-backups': () => window.psmDesktop.openPath('backups'),
    restore: async (b) => {
      const r = await window.psmDesktop.restoreBackup(b.dataset.name);
      if (r && !r.ok && !r.cancelled) toast(`${t('restore_failed')}: ${r.error}`, true);
    },
    'save-pw': (b) => busy(b, async () => {
      const v = formVals('[data-pw]');
      if (v.password !== v.password2) return toast(t('passwords_dont_match'), true);
      await post('/me/password', v);
      state.defaultPassword = false;
      toast(t('password_changed'));
      setTimeout(() => location.reload(), 600);
    }),
  });
  await draw();
}
