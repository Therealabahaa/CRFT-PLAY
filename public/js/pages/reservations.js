import { t } from '../i18n.js';
import { get, post, esc, icon, field, opt, formBox, toast, toastErr, delegate, fmtTime, fmtMinutes, dayKey, toLocalInput } from '../core.js';

export async function render(root) {
  let day = dayKey();
  const consoles = await get('/consoles');

  async function draw() {
    const list = await get(`/reservations?from=${day}&to=${day}`);
    const now = Date.now();
    const pillFor = (r) => {
      if (r.status === 'booked' && r.end_at < now) return `<span class="pill crit"><span class="dot"></span>${t('res.late')}</span>`;
      const cls = { booked: 'info', arrived: 'good', cancelled: '', no_show: 'crit' }[r.status];
      return `<span class="pill ${cls}"><span class="dot"></span>${t('res.' + r.status)}</span>`;
    };
    root.innerHTML = `<div class="page-head"><h1>${t('nav.reservations')}</h1><span class="spacer"></span>
        <input type="date" value="${day}" data-day style="width:auto">
        <button class="btn btn-primary" data-act="new">${icon('plus')} ${t('new_reservation')}</button></div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>${t('time')}</th><th>${t('console')}</th><th>${t('customer')}</th><th>${t('phone')}</th><th>${t('duration')}</th><th>${t('status')}</th><th></th></tr></thead>
        <tbody>${list.map((r) => `<tr>
          <td class="num">${fmtTime(r.start_at)} – ${fmtTime(r.end_at)}</td>
          <td>${esc(r.console_name)} <span class="muted small">${esc(r.console_type)}</span></td>
          <td><b>${esc(r.customer_name)}</b>${r.notes ? `<div class="muted small">${esc(r.notes)}</div>` : ''}</td>
          <td class="num">${esc(r.phone || '')}</td>
          <td>${fmtMinutes((r.end_at - r.start_at) / 60000)}</td>
          <td>${pillFor(r)}</td>
          <td><div class="row" style="justify-content:flex-end">${r.status === 'booked' ? `
            <a class="btn btn-sm" href="#/floor">${icon('play')} ${t('start')}</a>
            <button class="btn btn-sm" data-act="edit" data-id="${r.id}">${icon('edit')}</button>
            <button class="btn btn-sm" data-act="status" data-id="${r.id}" data-s="no_show">${t('res.no_show')}</button>
            <button class="btn btn-sm btn-danger" data-act="status" data-id="${r.id}" data-s="cancelled">${t('cancel')}</button>` : ''}</div></td>
        </tr>`).join('') || `<tr><td colspan="7" class="empty">${t('no_reservations')}</td></tr>`}</tbody></table></div></div>`;
    root.querySelector('[data-day]').addEventListener('change', (e) => { day = e.target.value || dayKey(); draw(); });
    root._list = list;
  }

  async function edit(r) {
    const start = r ? r.start_at : (() => { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); if (day !== dayKey()) { const [y, m, dd] = day.split('-'); d.setFullYear(+y, +m - 1, +dd); } return d.getTime(); })();
    const v = await formBox(r ? t('edit_reservation') : t('new_reservation'),
      field(t('console'), `<select name="console_id">${consoles.filter((c) => c.status === 'active').map((c) => opt(c.id, `${c.name} (${c.type} · ${c.room_name || t('main_hall')})`, r?.console_id)).join('')}</select>`) +
      field(t('start_time'), `<input type="datetime-local" name="start" value="${toLocalInput(start)}" required>`) +
      field(t('duration_minutes'), `<input type="number" name="minutes" min="15" step="15" value="${r ? (r.end_at - r.start_at) / 60000 : 60}">`) +
      field(t('customer_name'), `<input name="customer_name" value="${esc(r?.customer_name || '')}" required>`) +
      field(t('phone'), `<input name="phone" inputmode="tel" value="${esc(r?.phone || '')}">`) +
      field(t('notes'), `<input name="notes" value="${esc(r?.notes || '')}">`),
      { validate: (x) => (!x.customer_name.trim() ? t('err.name_required') : !x.start ? t('err.invalid_time') : null) });
    if (!v) return;
    try {
      await post('/reservations', { ...v, id: r?.id, start_at: new Date(v.start).getTime() });
      toast(t('saved'));
      day = dayKey(new Date(v.start));
      draw();
    } catch (err) { toastErr(err); }
  }

  delegate(root, {
    new: () => edit(null),
    edit: (b) => edit(root._list.find((r) => r.id === Number(b.dataset.id))),
    status: async (b) => {
      try { await post(`/reservations/${b.dataset.id}/status`, { status: b.dataset.s }); draw(); } catch (err) { toastErr(err); }
    },
  });
  await draw();
}
