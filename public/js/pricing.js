// Shared session pricing — used by the server (require) and the browser (window.Pricing)
// so the live timer on the screen always matches what is charged at checkout.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pricing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function roundUp(amount, step) {
    step = Number(step) || 0;
    if (step <= 0) return Math.round(amount * 100) / 100;
    return Math.ceil(amount / step - 1e-9) * step;
  }

  /**
   * session: { segments: [{start_at, end_at|null, rate}], package_minutes, package_price }
   * opts: { round_to, min_minutes, grace_minutes }
   * Segments are played periods; pauses are the gaps between them and are never charged.
   */
  function compute(session, opts, now) {
    now = now || Date.now();
    opts = opts || {};
    const segs = (session.segments || []).slice().sort((a, b) => a.start_at - b.start_at);
    let minutes = 0;
    const parts = segs.map((s) => {
      const m = Math.max(0, ((s.end_at || now) - s.start_at) / 60000);
      minutes += m;
      return { minutes: m, rate: Number(s.rate) || 0 };
    });

    const grace = Number(opts.grace_minutes) || 0;
    if (grace > 0 && minutes < grace && !session.package_minutes) {
      return { minutes, amount: 0, overtime: 0 };
    }

    let amount = 0;
    let overtime = 0;
    const pkgMin = Number(session.package_minutes) || 0;
    if (pkgMin > 0) {
      // Package: fixed price covers the first pkgMin minutes, the rest is charged per segment rate.
      amount = Number(session.package_price) || 0;
      let covered = pkgMin;
      for (const p of parts) {
        const used = Math.min(covered, p.minutes);
        covered -= used;
        const extra = p.minutes - used;
        if (extra > 0) {
          overtime += extra;
          amount += (extra * p.rate) / 60;
        }
      }
    } else {
      for (const p of parts) amount += (p.minutes * p.rate) / 60;
      const minMin = Number(opts.min_minutes) || 0;
      if (minMin > 0 && minutes < minMin && parts.length) {
        amount += ((minMin - minutes) * parts[parts.length - 1].rate) / 60;
      }
    }
    return { minutes, amount: roundUp(amount, opts.round_to), overtime };
  }

  function formatDuration(minutes) {
    const totalSec = Math.max(0, Math.floor(minutes * 60));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  return { compute, roundUp, formatDuration };
});
