// Dates use India time (IST) and plain 'YYYY-MM-DD' strings.
export const IST = () => new Date(Date.now() + 330 * 60000);
export const today = () => IST().toISOString().slice(0, 10);
export const nowMin = () => { const d = IST(); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
export const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const addMonths = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
export const dow = s => new Date(s + 'T00:00:00Z').getUTCDay();
export const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
export const closedOn = (salon, date) => salon.off_days.includes(dow(date)) || salon.holidays.includes(date);

// Subscription state: trial -> active (paid) -> grace -> expired
export function billState(salon, cfg, t = today()) {
  const trialEnd = addMonths(salon.joined, cfg.trial_months);
  if (salon.paid_until && salon.paid_until >= t) return { state: 'active', until: salon.paid_until, trialEnd };
  if (!salon.paid_until && t <= trialEnd) return { state: 'trial', until: trialEnd, trialEnd };
  const due = salon.paid_until && salon.paid_until > trialEnd ? salon.paid_until : trialEnd;
  return { state: t <= addDays(due, cfg.grace_days) ? 'grace' : 'expired', until: due, trialEnd };
}

// Work out time and price of the chosen items for one stylist. Returns null if they cannot do them.
export function resolveItems(data, staff, items) {
  let dur = 0, price = 0; const names = [];
  for (const it of items) {
    if (it.t === 'combo') {
      const c = data.combos.find(x => x.id === it.id);
      if (!c || !c.svc_ids.every(id => id in staff.svc)) return null;
      dur += c.dur_min; price += c.price; names.push(c.name);
    } else {
      const s = data.services.find(x => x.id === it.id);
      if (!s || !(s.id in staff.svc)) return null;
      dur += staff.svc[s.id] ?? s.dur_min; price += s.price; names.push(s.name);
    }
  }
  return { dur, price, names };
}

// Free start times for one stylist on one date
export function slotsFor({ salon, staff, date, dur, busy, now, step = 15, buffer = 5, ignore }) {
  if (closedOn(salon, date) || staff.leave.includes(date) || !(dur > 0)) return [];
  let t0 = salon.open_min; if (date === today()) t0 = Math.max(t0, now);
  t0 = Math.ceil(t0 / step) * step;
  const b = busy.filter(x => x.id !== ignore), out = [];
  for (let t = t0; t + dur <= salon.close_min; t += step)
    if (!b.some(x => t < x.start_min + x.dur_min + buffer && x.start_min < t + dur + buffer)) out.push(t);
  return out;
}

// Live crowd meter shown to customers
export function crowd(salon, staff, bks, now, buffer = 5) {
  const t = today(), on = staff.filter(s => !s.leave.includes(t));
  if (closedOn(salon, t) || now < salon.open_min || now >= salon.close_min || !on.length) return { closed: true, chairs: on.length };
  let busy = 0;
  for (const s of on) if (bks.some(b => b.staff_id === s.id && (b.status === 'inservice' || (b.start_min <= now && now < b.start_min + b.dur_min)))) busy++;
  const soon = bks.filter(b => b.start_min > now && b.start_min < now + 60).length;
  const r = (busy + soon * 0.5) / on.length, level = r < 0.6 ? 'low' : r < 1.3 ? 'med' : 'busy';
  let best = null;
  for (const s of on) {
    const sl = slotsFor({ salon, staff: s, date: t, dur: 45, busy: bks.filter(b => b.staff_id === s.id), now, step: 5, buffer });
    if (sl.length && (best === null || sl[0] < best)) best = sl[0];
  }
  return { closed: false, chairs: on.length, busy, level, waitMin: best === null ? salon.close_min - now : Math.max(0, best - now) };
}
