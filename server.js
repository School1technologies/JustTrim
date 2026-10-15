import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pool, q, tx } from './db.js';
import * as U from './util.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 16) { console.error('Set JWT_SECRET (at least 16 characters).'); process.exit(1); }
const PROD = process.env.NODE_ENV === 'production';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ['https://fonts.gstatic.com'],
  imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", 'https://*.razorpay.com'], frameSrc: ['https://api.razorpay.com', 'https://checkout.razorpay.com'] } } }));
app.use(cors({ origin: (process.env.CORS_ORIGIN || '*').split(',') }));
app.use(rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }));

/* ---------- helpers ---------- */
async function settings(c = pool) {
  const { rows } = await c.query('SELECT key, value FROM settings');
  const o = { saas_price: 1499, trial_months: 3, grace_days: 7, slot_buffer_min: 5, advance_amount: 30, gst_pct: 18, customer_fee: 0 };
  rows.forEach(r => { o[r.key] = r.value; });
  return o;
}
async function userFrom(req, allowQuery) {
  let t = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!t && allowQuery) t = String(req.query.access_token || '');
  if (!t) return null;
  try {
    const p = jwt.verify(t, JWT_SECRET);
    const { rows } = await q('SELECT * FROM users WHERE id=$1', [p.sub]);
    return rows[0] || null;
  } catch { return null; }
}
const need = (...roles) => h(async (req, res, next) => {
  const u = await userFrom(req, req.path.endsWith('/events'));
  if (!u) bad('Please log in', 401);
  if (roles.length && !roles.includes(u.role)) bad('You do not have access to this', 403);
  req.user = u; next();
});
async function ownSalon(req, id, c = pool) {
  const { rows: [s] } = await c.query('SELECT * FROM salons WHERE id=$1', [id]);
  if (!s) bad('Salon not found', 404);
  if (req.user.role !== 'admin' && s.owner_id !== req.user.id) bad('This is not your salon', 403);
  return s;
}
async function loadData(id, c = pool) {
  const { rows: [salon] } = await c.query('SELECT * FROM salons WHERE id=$1', [id]);
  if (!salon) return null;
  const services = (await c.query('SELECT * FROM services WHERE salon_id=$1 AND active ORDER BY name', [id])).rows;
  const combos = (await c.query(`SELECT c.*, COALESCE(array_agg(ci.service_id) FILTER (WHERE ci.service_id IS NOT NULL), '{}'::uuid[]) AS svc_ids
    FROM combos c LEFT JOIN combo_items ci ON ci.combo_id=c.id WHERE c.salon_id=$1 GROUP BY c.id ORDER BY c.name`, [id])).rows;
  const staff = (await c.query('SELECT * FROM staff WHERE salon_id=$1 AND active ORDER BY name', [id])).rows;
  const ss = (await c.query('SELECT ss.* FROM staff_services ss JOIN staff s ON s.id=ss.staff_id WHERE s.salon_id=$1', [id])).rows;
  staff.forEach(s => { s.svc = {}; ss.filter(x => x.staff_id === s.id).forEach(x => { s.svc[x.service_id] = x.dur_min; }); });
  return { salon, services, combos, staff };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function cleanItems(x) {
  if (!Array.isArray(x)) return [];
  return x.filter(i => i && (i.t === 'svc' || i.t === 'combo') && UUID.test(String(i.id))).map(i => ({ t: i.t, id: String(i.id) }));
}
function itemsFromQuery(s) {
  return cleanItems(String(s || '').split(',').filter(Boolean).map(p => { const [t, id] = p.split(':'); return { t, id }; }));
}

const intIn = (v, lo, hi, what) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) bad(`${what} is not valid`); return n; };
const str = (v, what, max = 120, required = true) => { const s = String(v ?? '').trim(); if (required && !s) bad(`${what} is required`); if (s.length > max) bad(`${what} is too long`); return s; };

/* live alerts to the salon's phone (Server-Sent Events) */
const subs = new Map();
const push = (salonId, evt) => (subs.get(salonId) || new Set()).forEach(r => r.write(`data: ${JSON.stringify(evt)}\n\n`));
async function notify(c, salonId, text) {
  await c.query('INSERT INTO notifications (salon_id, text) VALUES ($1,$2)', [salonId, text]);
  push(salonId, { type: 'alert', text });
}

/* Find a free slot and write the booking in one safe step.
   The database's no_double_booking rule is the final guard if two people race for the same slot. */
async function placeSlot(c, data, cfg, o) {
  const now = U.nowMin(), opts = [];
  let cands = data.staff;
  if (o.staffId !== 'any') cands = cands.filter(s => s.id === o.staffId);
  else {
    const { rows } = await c.query(`SELECT staff_id, count(*)::int n FROM bookings WHERE salon_id=$1 AND date=$2 AND status<>'cancelled' GROUP BY staff_id`, [data.salon.id, o.date]);
    const load = id => (rows.find(r => r.staff_id === id) || { n: 0 }).n;
    cands = cands.slice().sort((a, b) => load(a.id) - load(b.id));
  }
  for (const st of cands) {
    const r = U.resolveItems(data, st, o.items); if (!r) continue;
    const busy = (await c.query(`SELECT id, start_min, dur_min FROM bookings WHERE staff_id=$1 AND date=$2 AND status IN ('booked','inservice','done')`, [st.id, o.date])).rows;
    const sl = U.slotsFor({ salon: data.salon, staff: st, date: o.date, dur: r.dur, busy, now, step: o.start == null ? 5 : 15, buffer: cfg.slot_buffer_min, ignore: o.ignoreId });
    if (o.start == null) { if (sl.length) opts.push({ st, r, start: sl[0] }); }
    else if (sl.includes(o.start)) opts.push({ st, r, start: o.start });
  }
  opts.sort((a, b) => a.start - b.start);
  for (const x of opts) {
    await c.query('SAVEPOINT p');
    try { const row = await o.write(c, x.st, x.r, x.start); await c.query('RELEASE SAVEPOINT p'); return row; }
    catch (e) { if (e.code === '23P01') { await c.query('ROLLBACK TO SAVEPOINT p'); continue; } throw e; }
  }
  return null;
}
const nextToken = async (c, salonId, date) => {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [salonId + date]);
  return (await c.query('SELECT COALESCE(MAX(token),0)+1 AS t FROM bookings WHERE salon_id=$1 AND date=$2', [salonId, date])).rows[0].t;
};
const publicSalon = (s, extra = {}) => ({ id: s.id, brand: s.brand, name: s.name, area: s.area, address: s.address, type: s.type, openMin: s.open_min, closeMin: s.close_min, offDays: s.off_days, holidays: s.holidays, rating: s.rating, offer: s.offer_code ? { code: s.offer_code, pct: s.offer_pct } : null, ...extra });

/* ---------- health ---------- */
app.get('/healthz', h(async (req, res) => { await q('SELECT 1'); res.json({ ok: true }); }));

/* ---------- payments webhook (needs the raw body, so it comes before express.json) ---------- */
async function recordPayment(c, salonId, ref) {
  const cfg = await settings(c);
  const { rows: [s] } = await c.query('SELECT * FROM salons WHERE id=$1 FOR UPDATE', [salonId]);
  if (!s) bad('Salon not found', 404);
  const t = U.today(), b = U.billState(s, cfg, t);
  const base = s.paid_until && s.paid_until >= t ? s.paid_until : (t < b.trialEnd ? b.trialEnd : t);
  const until = U.addMonths(base, 1);
  const ins = await c.query(`INSERT INTO invoices (salon_id, amount, gst, period_end, gateway_ref) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [salonId, cfg.saas_price, Math.round(cfg.saas_price * cfg.gst_pct / 100), until, ref]);
  if (ins.rowCount === 0) return null;               // this payment was already recorded
  await c.query('UPDATE salons SET paid_until=$1 WHERE id=$2', [until, salonId]);
  return until;
}
app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json' }), h(async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) bad('Webhook not configured', 503);
  const sig = String(req.headers['x-razorpay-signature'] || '');
  const want = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) bad('Bad signature', 400);
  const evt = JSON.parse(req.body.toString('utf8'));
  if (evt.event === 'payment.captured' || evt.event === 'order.paid') {
    const pay = evt.payload?.payment?.entity, salonId = pay?.notes?.salon_id;
    if (salonId && UUID.test(salonId)) await tx(c => recordPayment(c, salonId, pay.id));
  }
  res.json({ ok: true });
}));

app.use(express.json({ limit: '400kb' }));

/* ---------- auth (email + password) ---------- */
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? no(e) : ok(k))));
async function hashPw(pw) { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + (await scrypt(pw, salt)).toString('hex'); }
async function checkPw(pw, stored) {
  const [s, hx] = String(stored).split(':'); if (!s || !hx) return false;
  const k = await scrypt(String(pw), Buffer.from(s, 'hex')), hb = Buffer.from(hx, 'hex');
  return k.length === hb.length && crypto.timingSafeEqual(k, hb);
}
const emailOk = e => e.length <= 254 && /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e);
const pwOk = p => typeof p === 'string' && p.length >= 8 && p.length <= 100;
const sign = u => jwt.sign({ sub: u.id }, JWT_SECRET, { expiresIn: '30d' });
const userOut = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, points: u.points, lang: u.lang });
const authLimit = rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: r => String(r.body?.email || 'x').toLowerCase() });
app.post('/api/auth/register', authLimit, h(async (req, res) => {
  const b = req.body || {}, email = String(b.email || '').trim().toLowerCase();
  if (!emailOk(email)) bad('Enter a valid email address');
  if (!pwOk(b.password)) bad('Password must be 8 to 100 characters');
  const name = str(b.name, 'Name', 60);
  const role = ADMIN_EMAILS.includes(email) ? 'admin' : b.accountType === 'owner' ? 'owner' : 'customer';
  let u;
  try { ({ rows: [u] } = await q('INSERT INTO users (email, password_hash, name, role, points) VALUES ($1,$2,$3,$4,20) RETURNING *', [email, await hashPw(b.password), name, role])); }
  catch (e) { if (e.code === '23505') bad('An account with this email already exists', 409); throw e; }
  res.status(201).json({ token: sign(u), user: userOut(u) });
}));
app.post('/api/auth/login', authLimit, h(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const { rows: [u] } = await q('SELECT * FROM users WHERE lower(email)=$1', [email]);
  const good = u ? await checkPw(req.body?.password, u.password_hash) : (await scrypt('x', Buffer.alloc(16)), false);   // same work either way
  if (!good) bad('Wrong email or password', 401);
  if (ADMIN_EMAILS.includes(email) && u.role !== 'admin') { await q(`UPDATE users SET role='admin' WHERE id=$1`, [u.id]); u.role = 'admin'; }
  res.json({ token: sign(u), user: userOut(u) });
}));
app.get('/api/me', need(), h(async (req, res) => res.json(userOut(req.user))));
app.patch('/api/me', need(), h(async (req, res) => {
  const name = str(req.body?.name, 'Name', 60, false), lang = ['en', 'ta', 'hi'].includes(req.body?.lang) ? req.body.lang : req.user.lang;
  await q('UPDATE users SET name=COALESCE(NULLIF($1,\'\'), name), lang=$2 WHERE id=$3', [name, lang, req.user.id]);
  res.json({ ok: true });
}));
app.post('/api/me/password', need(), authLimit, h(async (req, res) => {
  if (!(await checkPw(req.body?.current, req.user.password_hash))) bad('Current password is wrong', 401);
  if (!pwOk(req.body?.next)) bad('New password must be 8 to 100 characters');
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await hashPw(req.body.next), req.user.id]);
  res.json({ ok: true });
}));

/* ---------- public: browse salons ---------- */
app.get('/api/salons', h(async (req, res) => {
  const cfg = await settings(), now = U.nowMin(), t = U.today();
  const { rows: salons } = await q(`SELECT * FROM salons WHERE status='approved'`);
  const ids = salons.map(s => s.id);
  const staff = (await q('SELECT * FROM staff WHERE active AND salon_id=ANY($1)', [ids])).rows;
  const bks = (await q(`SELECT id, salon_id, staff_id, start_min, dur_min, status FROM bookings WHERE date=$1 AND status IN ('booked','inservice') AND salon_id=ANY($2)`, [t, ids])).rows;
  const area = String(req.query.area || ''), type = String(req.query.type || ''), term = String(req.query.q || '').toLowerCase();
  const out = salons
    .filter(s => U.billState(s, cfg).state !== 'expired')
    .filter(s => !area || s.area === area)
    .filter(s => !type || s.type === type || s.type === 'Unisex')
    .filter(s => !term || (s.name + ' ' + s.area).toLowerCase().includes(term))
    .map(s => publicSalon(s, { crowd: U.crowd(s, staff.filter(x => x.salon_id === s.id), bks.filter(b => b.salon_id === s.id), now, cfg.slot_buffer_min) }));
  res.json({ salons: out });
}));
app.get('/api/salons/:id', h(async (req, res) => {
  if (!UUID.test(req.params.id)) bad('Salon not found', 404);
  const cfg = await settings(), data = await loadData(req.params.id);
  if (!data || data.salon.status !== 'approved' || U.billState(data.salon, cfg).state === 'expired') bad('Salon not found', 404);
  const bks = (await q(`SELECT id, salon_id, staff_id, start_min, dur_min, status FROM bookings WHERE salon_id=$1 AND date=$2 AND status IN ('booked','inservice')`, [data.salon.id, U.today()])).rows;
  res.json({
    salon: publicSalon(data.salon, { crowd: U.crowd(data.salon, data.staff, bks, U.nowMin(), cfg.slot_buffer_min) }),
    services: data.services.map(s => ({ id: s.id, name: s.name, price: s.price, durMin: s.dur_min })),
    combos: data.combos.map(c => ({ id: c.id, name: c.name, price: c.price, durMin: c.dur_min, serviceIds: c.svc_ids })),
    staff: data.staff.map(s => ({ id: s.id, name: s.name, spec: s.spec, photo: s.photo, rating: s.rating, onLeaveToday: s.leave.includes(U.today()), services: Object.entries(s.svc).map(([id, d]) => ({ serviceId: id, durMin: d })) })),
    settings: { advanceAmount: cfg.advance_amount, customerFee: cfg.customer_fee },
  });
}));
app.get('/api/salons/:id/slots', h(async (req, res) => {
  const date = String(req.query.date || U.today()), items = itemsFromQuery(req.query.items), who = String(req.query.staff || 'any');
  if (!UUID.test(req.params.id) || !U.isDate(date) || !items.length) bad('Pick a date and at least one service');
  if (who !== 'any' && !UUID.test(who)) bad('Invalid stylist');
  const cfg = await settings(), data = await loadData(req.params.id);
  if (!data || data.salon.status !== 'approved') bad('Salon not found', 404);
  const now = U.nowMin(), map = new Map();
  const cands = who === 'any' ? data.staff : data.staff.filter(s => s.id === who);
  for (const st of cands) {
    const r = U.resolveItems(data, st, items); if (!r) continue;
    const busy = (await q(`SELECT id, start_min, dur_min FROM bookings WHERE staff_id=$1 AND date=$2 AND status IN ('booked','inservice','done')`, [st.id, date])).rows;
    for (const t of U.slotsFor({ salon: data.salon, staff: st, date, dur: r.dur, busy, now, buffer: cfg.slot_buffer_min, ignore: req.query.ignore })) if (!map.has(t)) map.set(t, { start: t, staffId: st.id, durMin: r.dur, price: r.price });
  }
  res.json({ date, slots: [...map.values()].sort((a, b) => a.start - b.start) });
}));

/* ---------- customer bookings ---------- */
const bookingOut = b => ({ id: b.id, salonId: b.salon_id, staffId: b.staff_id, date: b.date, startMin: b.start_min, durMin: b.dur_min, price: b.price, discount: b.discount, advance: b.advance, status: b.status, type: b.type, token: b.token, items: b.items, rating: b.rating, customerName: b.customer_name, salonName: b.salon_name, staffName: b.staff_name });
app.post('/api/bookings', need(), h(async (req, res) => {
  const b = req.body || {}, cfg = await settings(), items = cleanItems(b.items);
  if (!items.length) bad('Pick at least one service');
  if (!UUID.test(String(b.salonId))) bad('Salon not found', 404);
  if (b.staffId !== 'any' && !UUID.test(String(b.staffId))) bad('Invalid stylist');
  if (!U.isDate(b.date) || b.date < U.today() || b.date > U.addDays(U.today(), 14)) bad('Pick a date in the next 14 days');
  const start = intIn(b.start, 0, 1439, 'Start time');
  const row = await tx(async c => {
    const data = await loadData(b.salonId, c);
    if (!data || data.salon.status !== 'approved') bad('Salon not found', 404);
    if (U.billState(data.salon, cfg).state === 'expired') bad("This salon isn't taking online bookings right now", 409);
    const token = await nextToken(c, data.salon.id, b.date);
    const { rows: [me] } = await c.query('SELECT points FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
    const placed = await placeSlot(c, data, cfg, { staffId: b.staffId, date: b.date, start, items, write: async (c2, st, r, s0) => {
      const disc = data.salon.offer_code && String(b.code || '').toUpperCase() === data.salon.offer_code.toUpperCase() ? Math.round(r.price * data.salon.offer_pct / 100) : 0;
      const pts = b.usePoints ? Math.min(me.points, Math.floor((r.price - disc) * 0.2)) : 0;
      const { rows: [x] } = await c2.query(`INSERT INTO bookings (salon_id, staff_id, customer_id, customer_name, customer_contact, date, start_min, dur_min, price, discount, advance, token, items)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [data.salon.id, st.id, req.user.id, req.user.name, req.user.email, b.date, s0, r.dur, r.price - disc - pts, disc + pts, b.advance ? cfg.advance_amount : 0, token, JSON.stringify(r.names.map((n, i) => ({ ...items[i], name: n })))]);
      if (pts) await c2.query('UPDATE users SET points=points-$1 WHERE id=$2', [pts, req.user.id]);
      return x;
    } });
    if (!placed) bad('That slot was just taken. Please pick another time.', 409);
    await notify(c, data.salon.id, `${req.user.name || 'A customer'} booked ${placed.items.map(i => i.name).join(' + ')} on ${placed.date} at ${Math.floor(placed.start_min / 60)}:${String(placed.start_min % 60).padStart(2, '0')}`);
    return placed;
  });
  res.status(201).json({ booking: bookingOut(row) });
}));
app.get('/api/bookings/mine', need(), h(async (req, res) => {
  const { rows } = await q('SELECT b.*, s.name salon_name, st.name staff_name FROM bookings b JOIN salons s ON s.id=b.salon_id JOIN staff st ON st.id=b.staff_id WHERE b.customer_id=$1 ORDER BY b.date DESC, b.start_min DESC LIMIT 100', [req.user.id]);
  res.json({ bookings: rows.map(bookingOut) });
}));
async function myBooking(req, id, c = pool) {
  if (!UUID.test(id)) bad('Booking not found', 404);
  const { rows: [b] } = await c.query('SELECT * FROM bookings WHERE id=$1 AND customer_id=$2 FOR UPDATE', [id, req.user.id]);
  if (!b) bad('Booking not found', 404);
  return b;
}
const freeChange = b => b.date > U.today() || b.start_min - U.nowMin() >= 120;
app.post('/api/bookings/:id/cancel', need(), h(async (req, res) => {
  const out = await tx(async c => {
    const b = await myBooking(req, req.params.id, c);
    if (b.status !== 'booked') bad('This booking cannot be cancelled now', 409);
    await c.query(`UPDATE bookings SET status='cancelled' WHERE id=$1`, [b.id]);
    await notify(c, b.salon_id, `${b.customer_name || 'A customer'} cancelled their ${b.date} slot`);
    return { refundAdvance: freeChange(b) && b.advance > 0 };      // TODO: call the payment gateway refund API here
  });
  res.json({ cancelled: true, ...out });
}));
app.post('/api/bookings/:id/reschedule', need(), h(async (req, res) => {
  const cfg = await settings(), date = req.body?.date, start = intIn(req.body?.start, 0, 1439, 'Start time');
  if (!U.isDate(date) || date < U.today() || date > U.addDays(U.today(), 14)) bad('Pick a date in the next 14 days');
  const row = await tx(async c => {
    const b = await myBooking(req, req.params.id, c);
    if (b.status !== 'booked') bad('This booking cannot be moved now', 409);
    if (!freeChange(b)) bad('Changes are free only until 2 hours before the slot', 409);
    const data = await loadData(b.salon_id, c);
    const items = cleanItems(b.items);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [b.salon_id + date]);
    const placed = await placeSlot(c, data, cfg, { staffId: req.body?.staffId && UUID.test(req.body.staffId) ? req.body.staffId : 'any', date, start, items, ignoreId: b.id,
      write: async (c2, st, r, s0) => (await c2.query(`UPDATE bookings SET date=$1, start_min=$2, staff_id=$3, dur_min=$4 WHERE id=$5 RETURNING *`, [date, s0, st.id, r.dur, b.id])).rows[0] });
    if (!placed) bad('That slot is not free. Please pick another time.', 409);
    await notify(c, b.salon_id, `${b.customer_name || 'A customer'} moved their booking to ${date}`);
    return placed;
  });
  res.json({ booking: bookingOut(row) });
}));
app.post('/api/bookings/:id/rate', need(), h(async (req, res) => {
  const n = intIn(req.body?.rating, 1, 5, 'Rating');
  await tx(async c => {
    const b = await myBooking(req, req.params.id, c);
    if (b.status !== 'done' || b.rating) bad('You can rate a finished visit once', 409);
    await c.query('UPDATE bookings SET rating=$1 WHERE id=$2', [n, b.id]);
    await c.query(`UPDATE staff SET rating = ROUND(((SELECT COALESCE(AVG(rating),$1) FROM bookings WHERE staff_id=$2 AND rating IS NOT NULL))::numeric,1) WHERE id=$2`, [n, b.staff_id]);
    await c.query(`UPDATE salons SET rating = ROUND(((SELECT COALESCE(AVG(rating),$1) FROM bookings WHERE salon_id=$2 AND rating IS NOT NULL))::numeric,1) WHERE id=$2`, [n, b.salon_id]);
  });
  res.json({ ok: true });
}));
/* walk-in queue: a customer (or the salon, for a guest) joins today's queue and gets the earliest free chair */
app.post('/api/salons/:id/walkin', need(), h(async (req, res) => {
  const cfg = await settings(), items = cleanItems(req.body?.items);
  if (!items.length) bad('Pick at least one service');
  const row = await tx(async c => {
    const data = await loadData(req.params.id, c);
    if (!data) bad('Salon not found', 404);
    const isOwner = req.user.role === 'admin' || data.salon.owner_id === req.user.id;
    if (!isOwner && data.salon.status !== 'approved') bad('Salon not found', 404);
    const t = U.today(), token = await nextToken(c, data.salon.id, t);
    const who = String(req.body?.staffId || 'any'), guest = isOwner ? str(req.body?.name || 'Walk-in guest', 'Name', 60) : req.user.name;
    const placed = await placeSlot(c, data, cfg, { staffId: who === 'any' || !UUID.test(who) ? 'any' : who, date: t, start: null, items,
      write: async (c2, st, r, s0) => (await c2.query(`INSERT INTO bookings (salon_id, staff_id, customer_id, customer_name, customer_contact, date, start_min, dur_min, price, token, type, items)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'walkin',$11) RETURNING *`,
        [data.salon.id, st.id, isOwner ? null : req.user.id, guest, isOwner ? '' : req.user.email, t, s0, r.dur, r.price, token, JSON.stringify(r.names.map((n, i) => ({ ...items[i], name: n })))])).rows[0] });
    if (!placed) bad('No stylist can take this today', 409);
    if (!isOwner) await notify(c, data.salon.id, `${guest} joined the walk-in queue (token #${placed.token})`);
    return placed;
  });
  res.status(201).json({ booking: bookingOut(row), waitMin: Math.max(0, row.start_min - U.nowMin()) });
}));
app.post('/api/tickets', need(), h(async (req, res) => {
  const { rows: [b] } = await q('SELECT * FROM bookings WHERE id=$1 AND customer_id=$2', [String(req.body?.bookingId), req.user.id]);
  if (!b) bad('Booking not found', 404);
  await q('INSERT INTO tickets (salon_id, booking_id, customer_id, text, amount) VALUES ($1,$2,$3,$4,$5)', [b.salon_id, b.id, req.user.id, str(req.body?.text, 'Details', 500), b.advance]);
  res.status(201).json({ ok: true });
}));

/* ---------- salon owner ---------- */
const MEN = [['Haircut', 150, 45], ['Shave', 80, 45], ['Beard trim', 100, 45], ['Head massage', 100, 20], ['Hair colour', 500, 90], ['Facial', 400, 50]];
const WOMEN = [['Haircut', 300, 45], ['Threading', 60, 15], ['Facial', 600, 60], ['Hair spa', 900, 75], ['Manicure', 400, 45], ['Cleanup', 350, 40]];
const UNI = [['Haircut', 200, 45], ['Shave', 90, 45], ['Beard trim', 100, 45], ['Threading', 60, 15], ['Facial', 500, 55], ['Hair spa', 800, 75]];
app.post('/api/salons', need('customer', 'owner', 'admin'), h(async (req, res) => {
  const b = req.body || {}, type = ['Men', 'Women', 'Unisex'].includes(b.type) ? b.type : bad('Choose Men, Women or Unisex');
  const open = intIn(b.openMin ?? 540, 0, 1439, 'Opening time'), close = intIn(b.closeMin ?? 1260, 1, 1440, 'Closing time');
  if (close <= open) bad('Closing time must be after opening');
  const name = str(b.name, 'Salon name');
  const out = await tx(async c => {
    let brand = name;
    if (UUID.test(String(b.branchOf || ''))) { const parent = await ownSalon(req, b.branchOf, c); brand = parent.brand; }
    if (req.user.role === 'customer') await c.query(`UPDATE users SET role='owner' WHERE id=$1`, [req.user.id]);
    const { rows: [s] } = await c.query(`INSERT INTO salons (owner_id, brand, name, area, address, type, open_min, close_min, declared_staff) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.id, brand, name, str(b.area, 'Area', 60), str(b.address, 'Address', 200), type, open, close, Math.max(0, Math.min(50, parseInt(b.staffCount) || 0))]);
    for (const [n, p, d] of type === 'Women' ? WOMEN : type === 'Men' ? MEN : UNI) await c.query('INSERT INTO services (salon_id, name, price, dur_min) VALUES ($1,$2,$3,$4)', [s.id, n, p, d]);
    return s;
  });
  res.status(201).json({ salon: publicSalon(out, { status: out.status }) });
}));
app.get('/api/my/salons', need('owner', 'admin'), h(async (req, res) => {
  const cfg = await settings();
  const { rows } = await q('SELECT * FROM salons WHERE owner_id=$1 ORDER BY created_at', [req.user.id]);
  res.json({ salons: rows.map(s => publicSalon(s, { status: s.status, billing: U.billState(s, cfg) })) });
}));
app.get('/api/salons/:id/manage', need('owner', 'admin'), h(async (req, res) => {   // full menu and team, even before approval
  await ownSalon(req, req.params.id);
  const d = await loadData(req.params.id), cfg = await settings();
  res.json({ salon: publicSalon(d.salon, { status: d.salon.status, billing: U.billState(d.salon, cfg) }),
    services: d.services.map(x => ({ id: x.id, name: x.name, price: x.price, durMin: x.dur_min })),
    combos: d.combos.map(x => ({ id: x.id, name: x.name, price: x.price, durMin: x.dur_min, serviceIds: x.svc_ids })),
    staff: d.staff.map(x => ({ id: x.id, name: x.name, spec: x.spec, photo: x.photo, leave: x.leave, services: Object.entries(x.svc).map(([id, m]) => ({ serviceId: id, durMin: m })) })) });
}));
app.patch('/api/salons/:id', need('owner', 'admin'), h(async (req, res) => {
  const s = await ownSalon(req, req.params.id), b = req.body || {};
  const f = {
    name: b.name !== undefined ? str(b.name, 'Name') : s.name, area: b.area !== undefined ? str(b.area, 'Area', 60) : s.area,
    address: b.address !== undefined ? str(b.address, 'Address', 200, false) : s.address, type: ['Men', 'Women', 'Unisex'].includes(b.type) ? b.type : s.type,
    open: b.openMin !== undefined ? intIn(b.openMin, 0, 1439, 'Opening time') : s.open_min, close: b.closeMin !== undefined ? intIn(b.closeMin, 1, 1440, 'Closing time') : s.close_min,
    off: Array.isArray(b.offDays) ? b.offDays.map(n => intIn(n, 0, 6, 'Weekly off')) : s.off_days,
    hol: Array.isArray(b.holidays) ? b.holidays.filter(U.isDate) : s.holidays,
    code: b.offer === null ? null : b.offer ? str(b.offer.code, 'Offer code', 20).toUpperCase() : s.offer_code,
    pct: b.offer === null ? null : b.offer ? intIn(b.offer.pct, 1, 50, 'Discount') : s.offer_pct,
  };
  if (f.close <= f.open) bad('Closing time must be after opening');
  await q('UPDATE salons SET name=$1, area=$2, address=$3, type=$4, open_min=$5, close_min=$6, off_days=$7, holidays=$8, offer_code=$9, offer_pct=$10 WHERE id=$11',
    [f.name, f.area, f.address, f.type, f.open, f.close, f.off, f.hol, f.code, f.pct, s.id]);
  res.json({ ok: true });
}));
app.get('/api/salons/:id/bookings', need('owner', 'admin'), h(async (req, res) => {
  const s = await ownSalon(req, req.params.id), date = U.isDate(req.query.date) ? req.query.date : U.today();
  const { rows } = await q(`SELECT * FROM bookings WHERE salon_id=$1 AND date=$2 ORDER BY start_min`, [s.id, date]);
  res.json({ date, bookings: rows.map(bookingOut) });
}));
const NEXT = { booked: ['inservice', 'noshow', 'cancelled'], inservice: ['done'] };
app.patch('/api/bookings/:id/status', need('owner', 'admin'), h(async (req, res) => {
  const to = String(req.body?.status || '');
  await tx(async c => {
    if (!UUID.test(req.params.id)) bad('Booking not found', 404);
    const { rows: [b] } = await c.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!b) bad('Booking not found', 404);
    await ownSalon(req, b.salon_id, c);
    if (!(NEXT[b.status] || []).includes(to)) bad(`A ${b.status} booking cannot move to ${to}`, 409);
    await c.query('UPDATE bookings SET status=$1 WHERE id=$2', [to, b.id]);
    if (to === 'done' && b.customer_id) await c.query('UPDATE users SET points=points+$1 WHERE id=$2', [Math.floor(b.price / 10), b.customer_id]);
  });
  res.json({ ok: true });
}));
app.get('/api/salons/:id/notifications', need('owner', 'admin'), h(async (req, res) => {
  const s = await ownSalon(req, req.params.id);
  const { rows } = await q('SELECT id, text, seen, created_at FROM notifications WHERE salon_id=$1 ORDER BY id DESC LIMIT 50', [s.id]);
  await q('UPDATE notifications SET seen=true WHERE salon_id=$1', [s.id]);
  res.json({ notifications: rows });
}));
app.get('/api/salons/:id/events', need('owner', 'admin'), h(async (req, res) => {
  const s = await ownSalon(req, req.params.id);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders(); res.write('retry: 5000\n\n');
  if (!subs.has(s.id)) subs.set(s.id, new Set());
  subs.get(s.id).add(res);
  const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(beat); subs.get(s.id)?.delete(res); });
}));

/* staff, services, combos */
async function writeStaffServices(c, salonId, staffId, list) {
  await c.query('DELETE FROM staff_services WHERE staff_id=$1', [staffId]);
  for (const x of Array.isArray(list) ? list : []) {
    if (!UUID.test(String(x.serviceId))) continue;
    const ok = await c.query('SELECT 1 FROM services WHERE id=$1 AND salon_id=$2 AND active', [x.serviceId, salonId]);
    if (!ok.rowCount) bad('A selected service does not belong to this salon');
    await c.query('INSERT INTO staff_services (staff_id, service_id, dur_min) VALUES ($1,$2,$3)', [staffId, x.serviceId, x.durMin ? intIn(x.durMin, 5, 480, 'Service time') : null]);
  }
}
const photoOk = p => p == null || p === '' || (typeof p === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(p) && p.length < 300_000) || bad('Photo must be a small JPEG, PNG or WebP');
app.post('/api/salons/:id/staff', need('owner', 'admin'), h(async (req, res) => {
  const s = await ownSalon(req, req.params.id), b = req.body || {}; photoOk(b.photo);
  const id = await tx(async c => {
    const { rows: [x] } = await c.query('INSERT INTO staff (salon_id, name, spec, photo, leave) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [s.id, str(b.name, 'Name', 60), str(b.spec, 'Speciality', 100, false), b.photo || null, (b.leave || []).filter(U.isDate)]);
    await writeStaffServices(c, s.id, x.id, b.services); return x.id;
  });
  res.status(201).json({ id });
}));
app.put('/api/staff/:id', need('owner', 'admin'), h(async (req, res) => {
  const b = req.body || {}; photoOk(b.photo);
  await tx(async c => {
    if (!UUID.test(req.params.id)) bad('Not found', 404);
    const { rows: [st] } = await c.query('SELECT * FROM staff WHERE id=$1', [req.params.id]); if (!st) bad('Not found', 404);
    await ownSalon(req, st.salon_id, c);
    await c.query('UPDATE staff SET name=$1, spec=$2, photo=$3, leave=$4, active=$5 WHERE id=$6',
      [str(b.name ?? st.name, 'Name', 60), str(b.spec ?? st.spec, 'Speciality', 100, false), b.photo === undefined ? st.photo : (b.photo || null), Array.isArray(b.leave) ? b.leave.filter(U.isDate) : st.leave, b.active === undefined ? st.active : !!b.active, st.id]);
    if (b.services) await writeStaffServices(c, st.salon_id, st.id, b.services);
  });
  res.json({ ok: true });
}));
app.delete('/api/staff/:id', need('owner', 'admin'), h(async (req, res) => {   // soft delete keeps booking history
  if (!UUID.test(req.params.id)) bad('Not found', 404);
  const { rows: [st] } = await q('SELECT * FROM staff WHERE id=$1', [req.params.id]); if (!st) bad('Not found', 404);
  await ownSalon(req, st.salon_id);
  await q('UPDATE staff SET active=false WHERE id=$1', [st.id]); res.json({ ok: true });
}));
app.post('/api/salons/:id/services', need('owner', 'admin'), h(async (req, res) => {
  const s = await ownSalon(req, req.params.id), b = req.body || {};
  const { rows: [x] } = await q('INSERT INTO services (salon_id, name, price, dur_min) VALUES ($1,$2,$3,$4) RETURNING id', [s.id, str(b.name, 'Name', 60), intIn(b.price, 0, 100000, 'Price'), intIn(b.durMin, 5, 480, 'Time')]);
  res.status(201).json({ id: x.id });
}));
app.put('/api/services/:id', need('owner', 'admin'), h(async (req, res) => {
  if (!UUID.test(req.params.id)) bad('Not found', 404);
  const { rows: [x] } = await q('SELECT * FROM services WHERE id=$1', [req.params.id]); if (!x) bad('Not found', 404);
  await ownSalon(req, x.salon_id); const b = req.body || {};
  await q('UPDATE services SET name=$1, price=$2, dur_min=$3 WHERE id=$4', [str(b.name ?? x.name, 'Name', 60), intIn(b.price ?? x.price, 0, 100000, 'Price'), intIn(b.durMin ?? x.dur_min, 5, 480, 'Time'), x.id]);
  res.json({ ok: true });
}));
app.delete('/api/services/:id', need('owner', 'admin'), h(async (req, res) => {   // soft delete; combos that use it are removed
  if (!UUID.test(req.params.id)) bad('Not found', 404);
  await tx(async c => {
    const { rows: [x] } = await c.query('SELECT * FROM services WHERE id=$1', [req.params.id]); if (!x) bad('Not found', 404);
    await ownSalon(req, x.salon_id, c);
    await c.query('UPDATE services SET active=false WHERE id=$1', [x.id]);
    await c.query('DELETE FROM combos WHERE id IN (SELECT combo_id FROM combo_items WHERE service_id=$1)', [x.id]);
    await c.query('DELETE FROM staff_services WHERE service_id=$1', [x.id]);
  });
  res.json({ ok: true });
}));
app.post('/api/salons/:id/combos', need('owner', 'admin'), h(async (req, res) => {
  const s = await ownSalon(req, req.params.id), b = req.body || {}, ids = [...new Set((b.serviceIds || []).filter(i => UUID.test(String(i))))];
  if (ids.length < 2) bad('A combo needs at least 2 services');
  const id = await tx(async c => {
    const { rows } = await c.query('SELECT id, dur_min FROM services WHERE salon_id=$1 AND active AND id=ANY($2)', [s.id, ids]);
    if (rows.length !== ids.length) bad('A selected service does not belong to this salon');
    const dur = b.durMin ? intIn(b.durMin, 5, 600, 'Time') : rows.reduce((a, r) => a + r.dur_min, 0);
    const { rows: [x] } = await c.query('INSERT INTO combos (salon_id, name, price, dur_min) VALUES ($1,$2,$3,$4) RETURNING id', [s.id, str(b.name, 'Name', 60), intIn(b.price, 0, 100000, 'Price'), dur]);
    for (const sid of ids) await c.query('INSERT INTO combo_items VALUES ($1,$2)', [x.id, sid]);
    return x.id;
  });
  res.status(201).json({ id });
}));
app.delete('/api/combos/:id', need('owner', 'admin'), h(async (req, res) => {
  if (!UUID.test(req.params.id)) bad('Not found', 404);
  const { rows: [x] } = await q('SELECT * FROM combos WHERE id=$1', [req.params.id]); if (!x) bad('Not found', 404);
  await ownSalon(req, x.salon_id); await q('DELETE FROM combos WHERE id=$1', [x.id]); res.json({ ok: true });
}));

/* subscription billing for the salon */
app.get('/api/salons/:id/billing', need('owner', 'admin'), h(async (req, res) => {
  const s = await ownSalon(req, req.params.id), cfg = await settings();
  const { rows } = await q('SELECT id, amount, gst, issued, period_end, status FROM invoices WHERE salon_id=$1 ORDER BY issued DESC, id DESC LIMIT 24', [s.id]);
  res.json({ ...U.billState(s, cfg), pricePerMonth: cfg.saas_price, gstPct: cfg.gst_pct, invoices: rows });
}));
app.post('/api/salons/:id/billing/checkout', need('owner', 'admin'), h(async (req, res) => {
  const s = await ownSalon(req, req.params.id), cfg = await settings();
  const total = cfg.saas_price + Math.round(cfg.saas_price * cfg.gst_pct / 100);
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    const r = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64') },
      body: JSON.stringify({ amount: total * 100, currency: 'INR', receipt: `jt_${s.id.slice(0, 8)}_${Date.now()}`, notes: { salon_id: s.id } }) });
    if (!r.ok) bad('Payment provider error', 502);
    const o = await r.json(); return res.json({ orderId: o.id, amount: total, keyId: process.env.RAZORPAY_KEY_ID });
  }
  if (PROD || process.env.ALLOW_DEV_PAYMENTS !== '1') bad('Payments are not configured', 503);
  const until = await tx(c => recordPayment(c, s.id, 'dev_' + crypto.randomUUID()));  // development only
  res.json({ dev: true, paidUntil: until });
}));

/* ---------- Super Admin ---------- */
const admin = need('admin');
app.get('/api/admin/overview', admin, h(async (req, res) => {
  const cfg = await settings(), { rows: salons } = await q(`SELECT * FROM salons WHERE status IN ('approved','suspended')`);
  const states = {}; salons.forEach(s => { const k = U.billState(s, cfg).state; states[k] = (states[k] || 0) + 1; });
  const { rows: [t] } = await q(`SELECT count(*)::int n, COALESCE(sum(price),0)::int value FROM bookings WHERE date=$1 AND status<>'cancelled'`, [U.today()]);
  const { rows: [p] } = await q(`SELECT count(*)::int n FROM salons WHERE status='pending'`);
  res.json({ salonsLive: salons.length, pending: p.n, billing: states, mrr: ((states.active || 0) + (states.grace || 0)) * cfg.saas_price, bookingsToday: t.n, bookingValueToday: t.value });
}));
app.get('/api/admin/salons', admin, h(async (req, res) => {
  const cfg = await settings(), st = String(req.query.status || '');
  const { rows } = await q(`SELECT s.*, (SELECT count(*)::int FROM staff WHERE salon_id=s.id AND active) staff_n, (SELECT count(*)::int FROM services WHERE salon_id=s.id AND active) services_n, u.email owner_email
    FROM salons s JOIN users u ON u.id=s.owner_id WHERE ($1='' OR s.status=$1) ORDER BY s.created_at DESC`, [st]);
  res.json({ salons: rows.map(s => publicSalon(s, { status: s.status, ownerEmail: s.owner_email, staffAdded: s.staff_n, staffDeclared: s.declared_staff, servicesCount: s.services_n, joined: s.joined, billing: U.billState(s, cfg) })) });
}));
app.post('/api/admin/salons/:id/:action', admin, h(async (req, res) => {
  const id = req.params.id, a = req.params.action;
  if (!UUID.test(id)) bad('Not found', 404);
  const { rows: [s] } = await q('SELECT * FROM salons WHERE id=$1', [id]); if (!s) bad('Not found', 404);
  if (a === 'approve') {
    const { rows: [n] } = await q('SELECT (SELECT count(*) FROM staff WHERE salon_id=$1 AND active)::int st, (SELECT count(*) FROM services WHERE salon_id=$1 AND active)::int sv', [id]);
    if (!s.address || !n.st || !n.sv) bad('The salon needs an address, at least 1 stylist and at least 1 service before approval', 409);
    await q(`UPDATE salons SET status='approved' WHERE id=$1`, [id]);
  } else if (a === 'reject') await q(`UPDATE salons SET status='rejected' WHERE id=$1`, [id]);
  else if (a === 'suspend') await q(`UPDATE salons SET status='suspended' WHERE id=$1`, [id]);
  else if (a === 'activate') await q(`UPDATE salons SET status='approved' WHERE id=$1`, [id]);
  else if (a === 'mark-paid') await tx(c => recordPayment(c, id, 'manual_' + crypto.randomUUID()));
  else if (a === 'extend-trial') await q(`UPDATE salons SET joined = (joined + interval '1 month')::date WHERE id=$1`, [id]);
  else bad('Unknown action', 404);
  res.json({ ok: true });
}));
app.post('/api/admin/users/reset-password', admin, h(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!pwOk(req.body?.password)) bad('Password must be 8 to 100 characters');
  const r = await q('UPDATE users SET password_hash=$1 WHERE lower(email)=$2', [await hashPw(req.body.password), email]);
  if (!r.rowCount) bad('No account with that email', 404);
  res.json({ ok: true });
}));
app.get('/api/admin/settings', admin, h(async (req, res) => res.json(await settings())));
app.put('/api/admin/settings', admin, h(async (req, res) => {
  const allowed = { saas_price: [0, 100000], trial_months: [0, 24], grace_days: [0, 60], slot_buffer_min: [0, 30], advance_amount: [0, 1000], gst_pct: [0, 28], customer_fee: [0, 100] };
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!allowed[k]) continue;
    const n = intIn(v, allowed[k][0], allowed[k][1], k);
    await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, JSON.stringify(n)]);
  }
  res.json(await settings());
}));
app.get('/api/admin/tickets', admin, h(async (req, res) => {
  const { rows } = await q(`SELECT t.*, s.name salon_name FROM tickets t JOIN salons s ON s.id=t.salon_id ORDER BY (t.status='open') DESC, t.created_at DESC LIMIT 100`);
  res.json({ tickets: rows });
}));
app.post('/api/admin/tickets/:id/resolve', admin, h(async (req, res) => {
  const to = ['refunded', 'rejected'].includes(req.body?.status) ? req.body.status : bad('Choose refunded or rejected');
  if (!UUID.test(req.params.id)) bad('Not found', 404);
  await q(`UPDATE tickets SET status=$1 WHERE id=$2 AND status='open'`, [to, req.params.id]);   // TODO: trigger the gateway refund when "refunded"
  res.json({ ok: true });
}));

/* ---------- web app (static files) ---------- */
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: 'index.html' }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(PUBLIC_DIR + 'index.html'));

/* ---------- errors ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.code === '23P01') return res.status(409).json({ error: 'That slot was just taken. Please pick another time.' });
  if (err.code === '23505') return res.status(409).json({ error: 'This already exists' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const port = Number(process.env.PORT || 3000);
export const server = app.listen(port, () => console.log(`Just Trim API listening on ${port}`));
process.on('SIGTERM', () => { server.close(() => pool.end()); });
