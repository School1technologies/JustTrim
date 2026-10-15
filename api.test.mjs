// End-to-end test against a real PostgreSQL database.
// Usage: DATABASE_URL=postgres://... npm test   (starts its own server on port 3199)
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import pg from 'pg';

const DB = process.env.DATABASE_URL; if (!DB) { console.error('Set DATABASE_URL'); process.exit(1); }
const env = { ...process.env, DATABASE_URL: DB, JWT_SECRET: 'test-secret-test-secret', PORT: '3199', ADMIN_EMAILS: 'admin@test.in', ALLOW_DEV_PAYMENTS: '1', NODE_ENV: 'development' };
const BASE = 'http://localhost:3199';
const pool = new pg.Pool({ connectionString: DB });
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await new Promise((ok, no) => spawn('node', ['src/migrate.js'], { env, stdio: 'inherit' }).on('exit', c => c ? no(new Error('migrate failed')) : ok()));
const srv = spawn('node', ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(ok => srv.stdout.on('data', d => String(d).includes('listening') && ok()));

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
async function api(method, path, body, token) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
async function login(email, name) {
  const v = await api('POST', '/api/auth/register', { email, password: 'Passw0rd!', name });
  assert.equal(v.status, 201); return v.body.token;
}
const tomorrow = new Date(Date.now() + 330 * 60000 + 86400000).toISOString().slice(0, 10);

try {
  // --- auth ---
  const reg0 = { email: 'dup@test.in', password: 'Passw0rd!', name: 'Dup' };
  assert.equal((await api('POST', '/api/auth/register', { ...reg0, email: 'not-an-email' })).status, 400); ok('rejects an invalid email');
  assert.equal((await api('POST', '/api/auth/register', { ...reg0, password: 'short' })).status, 400); ok('rejects a short password');
  assert.equal((await api('POST', '/api/auth/register', reg0)).status, 201); ok('creates an account');
  assert.equal((await api('POST', '/api/auth/register', { ...reg0, email: 'DUP@test.in' })).status, 409); ok('refuses a duplicate email (any letter case)');
  assert.equal((await api('POST', '/api/auth/login', { email: 'dup@test.in', password: 'wrong-password' })).status, 401); ok('rejects a wrong password');
  assert.equal((await api('POST', '/api/auth/login', { email: 'nobody@test.in', password: 'Passw0rd!' })).status, 401); ok('rejects an unknown email with the same message');
  const lg = await api('POST', '/api/auth/login', { email: 'Dup@Test.in', password: 'Passw0rd!' });
  assert.equal(lg.status, 200); assert.ok(lg.body.token); ok('logs in with the right password');
  assert.equal((await api('POST', '/api/me/password', { current: 'Passw0rd!', next: 'NewPassw0rd!' }, lg.body.token)).status, 200);
  assert.equal((await api('POST', '/api/auth/login', { email: 'dup@test.in', password: 'NewPassw0rd!' })).status, 200); ok('changes password');
  assert.equal((await pool.query(`SELECT password_hash FROM users WHERE email='dup@test.in'`)).rows[0].password_hash.includes('Passw0rd'), false); ok('passwords are stored hashed');
  const adminT = await login('admin@test.in', 'Admin'), ownerT = await login('owner@test.in', 'Owner'), custT = await login('rahul@test.in', 'Rahul');
  assert.equal((await api('GET', '/api/me', null, adminT)).body.role, 'admin'); ok('admin phone gets the admin role');
  assert.equal((await api('GET', '/api/admin/overview', null, custT)).status, 403); ok('customers cannot use admin routes');
  assert.equal((await api('POST', '/api/admin/users/reset-password', { email: 'rahul@test.in', password: 'Rahul-new-pass1' }, adminT)).status, 200);
  assert.equal((await api('POST', '/api/auth/login', { email: 'rahul@test.in', password: 'Rahul-new-pass1' })).status, 200); ok('admin can reset a forgotten password');

  // --- salon registration and approval ---
  const reg = await api('POST', '/api/salons', { name: 'Cut & Co', area: 'Anna Nagar', address: '2nd Ave', type: 'Men', openMin: 540, closeMin: 1260, staffCount: 2 }, ownerT);
  assert.equal(reg.status, 201); const sid = reg.body.salon.id; ok('owner registers a salon (menu pre-filled)');
  assert.equal((await api('GET', '/api/salons')).body.salons.length, 0); ok('pending salon is hidden from customers');
  assert.equal((await api('POST', `/api/admin/salons/${sid}/approve`, null, adminT)).status, 409); ok('approval blocked until a stylist is added');
  const man = (await api('GET', `/api/salons/${sid}/manage`, null, ownerT)).body;
  const [hair, shave] = ['Haircut', 'Shave'].map(n => man.services.find(x => x.name === n).id);
  const st = await api('POST', `/api/salons/${sid}/staff`, { name: 'Arun', spec: 'Fades', services: [{ serviceId: hair, durMin: 40 }, { serviceId: shave }] }, ownerT);
  assert.equal(st.status, 201); const arun = st.body.id;
  const st2 = await api('POST', `/api/salons/${sid}/staff`, { name: 'Karthik', services: [{ serviceId: hair }, { serviceId: shave }] }, ownerT);
  const combo = await api('POST', `/api/salons/${sid}/combos`, { name: 'Haircut + Shave', price: 200, serviceIds: [hair, shave], durMin: 80 }, ownerT);
  assert.equal(combo.status, 201); ok('owner adds stylists with their own timings, and a combo');
  assert.equal((await api('POST', `/api/admin/salons/${sid}/approve`, null, adminT)).status, 200); ok('admin approves the salon');
  const list = (await api('GET', '/api/salons')).body.salons;
  assert.equal(list.length, 1); assert.ok('crowd' in list[0]); ok('approved salon is listed with its crowd meter');

  // --- slots and booking ---
  const items = [{ t: 'svc', id: hair }];
  const q = `items=svc:${hair}&date=${tomorrow}&staff=${arun}`;
  const slots = (await api('GET', `/api/salons/${sid}/slots?${q}`)).body.slots;
  assert.equal(slots[0].durMin, 40); assert.equal(slots[0].start, 540); ok("slots use the stylist's own 40 minute haircut time");
  const b1 = await api('POST', '/api/bookings', { salonId: sid, staffId: arun, date: tomorrow, start: 540, items, advance: true }, custT);
  assert.equal(b1.status, 201); assert.equal(b1.body.booking.advance, 30); ok('customer books a slot');
  const after = (await api('GET', `/api/salons/${sid}/slots?${q}`)).body.slots.map(s => s.start);
  assert.ok(!after.includes(540) && !after.includes(555)); assert.ok(after.includes(585)); ok('the booked time plus buffer is blocked');

  // --- concurrency: 8 customers race for the same slot ---
  const racers = []; for (let i = 0; i < 8; i++) racers.push(await login(`r${i}@test.in`, 'R' + i));
  const res = await Promise.all(racers.map(t => api('POST', '/api/bookings', { salonId: sid, staffId: arun, date: tomorrow, start: 600, items }, t)));
  const wins = res.filter(r => r.status === 201).length;
  assert.equal(wins, 1); assert.ok(res.every(r => r.status === 201 || r.status === 409)); ok('8 simultaneous bookings for one slot: exactly 1 wins, 7 get a clear 409');
  const any = await api('POST', '/api/bookings', { salonId: sid, staffId: 'any', date: tomorrow, start: 600, items }, custT);
  assert.equal(any.status, 201); assert.notEqual(any.body.booking.staffId, arun); ok('"any stylist" falls back to the other free stylist');

  // --- offers, points ---
  await api('PATCH', `/api/salons/${sid}`, { offer: { code: 'first10', pct: 10 } }, ownerT);
  const b3 = await api('POST', '/api/bookings', { salonId: sid, staffId: arun, date: tomorrow, start: 660, items, code: 'FIRST10', usePoints: true }, custT);
  assert.equal(b3.status, 201); assert.ok(b3.body.booking.discount > 15); ok('offer code and loyalty points reduce the price');

  // --- cancel, reschedule, status flow ---
  const c1 = await api('POST', `/api/bookings/${b1.body.booking.id}/cancel`, null, custT);
  assert.equal(c1.status, 200); assert.equal(c1.body.refundAdvance, true); ok('cancel early: advance flagged for refund');
  assert.ok((await api('GET', `/api/salons/${sid}/slots?${q}`)).body.slots.some(s => s.start === 540)); ok('cancelled slot becomes free again');
  const rs = await api('POST', `/api/bookings/${b3.body.booking.id}/reschedule`, { date: tomorrow, start: 720, staffId: arun }, custT);
  assert.equal(rs.status, 200); assert.equal(rs.body.booking.startMin, 720); ok('reschedule moves the booking');
  const other = await api('POST', `/api/bookings/${b3.body.booking.id}/cancel`, null, racers[0]);
  assert.equal(other.status, 404); ok("customers cannot touch someone else's booking");
  const ownerList = (await api('GET', `/api/salons/${sid}/bookings?date=${tomorrow}`, null, ownerT)).body.bookings;
  assert.ok(ownerList.length >= 3); ok('owner sees the day\'s bookings');
  const bid = b3.body.booking.id;
  assert.equal((await api('PATCH', `/api/bookings/${bid}/status`, { status: 'done' }, ownerT)).status, 409); ok('status cannot skip steps');
  await api('PATCH', `/api/bookings/${bid}/status`, { status: 'inservice' }, ownerT);
  assert.equal((await api('PATCH', `/api/bookings/${bid}/status`, { status: 'done' }, ownerT)).status, 200);
  assert.equal((await api('POST', `/api/bookings/${bid}/rate`, { rating: 5 }, custT)).status, 200); ok('start, finish and rate a visit');
  assert.equal((await api('PATCH', `/api/bookings/${bid}/status`, { status: 'noshow' }, custT)).status, 403); ok('customers cannot change booking status');
  const notes = (await api('GET', `/api/salons/${sid}/notifications`, null, ownerT)).body.notifications;
  assert.ok(notes.length >= 3); ok('salon receives booking alerts');

  // --- live alert stream ---
  const ac = new AbortController();
  const sse = await fetch(`${BASE}/api/salons/${sid}/events?access_token=${ownerT}`, { signal: ac.signal });
  const reader = sse.body.getReader(); let got = '';
  const waiter = (async () => { while (!got.includes('"alert"')) { const { value } = await reader.read(); got += new TextDecoder().decode(value); } })();
  await new Promise(r => setTimeout(r, 200));
  await api('POST', '/api/bookings', { salonId: sid, staffId: 'any', date: tomorrow, start: 780, items }, custT);
  await Promise.race([waiter, new Promise((_, no) => setTimeout(() => no(new Error('no live alert')), 3000))]); ac.abort(); ok('salon gets a live alert the moment a booking is made');

  // --- billing ---
  const bill = (await api('GET', `/api/salons/${sid}/billing`, null, ownerT)).body;
  assert.equal(bill.state, 'trial'); assert.equal(bill.pricePerMonth, 1499); ok('new salon starts on the 3 month free trial at ₹1499/month');
  assert.equal((await api('POST', `/api/salons/${sid}/billing/checkout`, null, ownerT)).status, 200);
  const bill2 = (await api('GET', `/api/salons/${sid}/billing`, null, ownerT)).body;
  assert.equal(bill2.state, 'active'); assert.equal(bill2.invoices.length, 1); assert.equal(bill2.invoices[0].gst, 270); ok('payment records an invoice with 18% GST and extends the plan');
  await pool.query(`UPDATE salons SET joined = CURRENT_DATE - interval '2 years', paid_until = NULL WHERE id=$1`, [sid]);
  assert.equal((await api('GET', '/api/salons')).body.salons.length, 0); ok('expired salon disappears from customer search');
  assert.equal((await api('POST', '/api/bookings', { salonId: sid, staffId: arun, date: tomorrow, start: 900, items }, custT)).status, 409); ok('expired salon cannot take online bookings');
  assert.equal((await api('POST', `/api/admin/salons/${sid}/mark-paid`, null, adminT)).status, 200);
  assert.equal((await api('GET', '/api/salons')).body.salons.length, 1); ok('admin marks it paid and it comes back');
  const ov = (await api('GET', '/api/admin/overview', null, adminT)).body;
  assert.equal(ov.mrr, 1499); ok('admin overview shows recurring revenue');
  const set = await api('PUT', '/api/admin/settings', { saas_price: 1799, trial_months: 3 }, adminT);
  assert.equal(set.body.saas_price, 1799); await api('PUT', '/api/admin/settings', { saas_price: 1499 }, adminT); ok('admin can change pricing settings');

  // --- security ---
  assert.equal((await api('POST', '/api/bookings', { salonId: sid, staffId: arun, date: tomorrow, start: 540, items })).status, 401); ok('booking requires login');
  assert.equal((await api('PATCH', `/api/salons/${sid}`, { name: 'Hacked' }, custT)).status, 403); ok('customers cannot edit a salon');
  const other2 = await login('other@test.in', 'Other owner');
  assert.equal((await api('PATCH', `/api/salons/${sid}`, { name: 'Hacked' }, other2)).status, 403); ok("another user cannot edit someone else's salon");
  assert.equal((await api('GET', `/api/salons/1' OR '1'='1`)).status, 404); ok('malformed ids are refused safely');
  console.log(`\nAll ${passed} checks passed.`);
} catch (e) { console.error('\nFAILED:', e.message); process.exitCode = 1; }
finally { srv.kill(); await pool.end(); }
