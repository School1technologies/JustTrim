(() => {
'use strict';
const VERSION = '2026.10.17-roles';
/* ---------- helpers ---------- */
const $ = (s, e = document) => e.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const fmtT = m => (Math.floor(m / 60) % 12 || 12) + ':' + pad(m % 60) + ' ' + (Math.floor(m / 60) % 24 >= 12 ? 'PM' : 'AM');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = s => new Date(s + 'T00:00:00').getDay();
const inr = n => '₹' + Math.round(n).toLocaleString('en-IN');
const fmtD = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const TODAY = ymd(new Date());
const dayLabel = d => d === TODAY ? 'Today' : d === addDays(TODAY, 1) ? 'Tomorrow' : DAYS[dow(d)] + ' ' + Number(d.slice(8));
const timeOpts = sel => { let h = ''; for (let m = 300; m <= 1410; m += 30) h += `<option value="${m}" ${m === sel ? 'selected' : ''}>${fmtT(m)}</option>`; return h; };
function toast(title, msg, kind) {
  const d = document.createElement('div'); d.className = 'toast ' + (kind || ''); d.setAttribute('role', 'status');
  d.innerHTML = '<b>' + esc(title) + '</b>' + (msg ? '<div>' + esc(msg) + '</div>' : '');
  $('#toasts').appendChild(d); setTimeout(() => d.remove(), 4000);
}
const A = { token: localStorage.getItem('jt_token') || '', user: null };
async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(A.token ? { Authorization: 'Bearer ' + A.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error((j && j.error) || 'Something went wrong'); e.status = r.status; throw e; }
  return j;
}
const V = { tab: 'explore', view: 'list', stab: 'today', atab: 'overview', mode: 'login', q: '', type: 'All', sel: [], staffId: 'any', date: TODAY, slot: null, slots: [], code: '', adv: true, pts: false, sdate: TODAY, modal: null, salons: [], mine: [], my: [], sid: null, es: null };
let TOP = false;

/* ---------- shared pieces ---------- */
function crowdHtml(c) {
  if (!c) return '';
  if (c.closed) return `<div class="crowd"><span class="tag">Closed</span><span class="muted">${c.chairs ? 'Outside working hours' : 'No stylists on duty today'}</span></div>`;
  const lab = c.level === 'low' ? 'Quiet' : c.level === 'med' ? 'Moderate' : 'Busy', w = c.waitMin <= 5 ? 'No wait' : 'Wait ~' + c.waitMin + ' min';
  return `<div class="crowd ${c.level}"><span class="chairs ${c.level}" aria-hidden="true">${Array.from({ length: c.chairs }, (_, i) => `<i class="${i < c.busy ? 'on' : ''}"></i>`).join('')}</span><b>${lab}</b><span class="muted">· ${w} · ${c.busy}/${c.chairs} chairs in use</span></div>`;
}
function avatar(st, sz) {
  const z = sz ? `width:${sz}px;height:${sz}px;font-size:${Math.round(sz / 2.3)}px;` : '';
  if (st.photo) return `<img class="av" style="${z}" src="${esc(st.photo)}" alt="">`;
  const hue = [...st.name].reduce((a, c) => a + c.charCodeAt(0), 0) * 37 % 360;
  return `<div class="av" style="${z}background:hsl(${hue} 42% 36%)" aria-hidden="true">${esc(st.name[0] || '?')}</div>`;
}
const pill = (cls, text) => `<span class="pill p-${cls}">${esc(text)}</span>`;
const STAT = { booked: 'Booked', inservice: 'In chair', done: 'Done', noshow: 'No-show', cancelled: 'Cancelled' };
const BL = { trial: 'Free trial', active: 'Paying', grace: 'Payment due', expired: 'Expired' };
const empty = t => `<div class="empty">${t}</div>`;

/* ---------- auth ---------- */
function authView() {
  const reg = V.mode === 'register';
  return `<div class="app"><main class="pad"><div class="stack"><div class="logocard"><img src="/logo.png" alt="Just Trim. Style Made Easy"></div><h1 class="hero">Know before you go.</h1>
  <p class="muted">See how busy a salon is, pick your stylist and book a slot. Salon owners manage the whole day from their phone.</p>
  <form class="card stack" data-submit="${reg ? 'register' : 'login'}">
  ${reg ? '<label>Your name<input class="in" name="name" required autocomplete="name"></label>' : ''}
  <label>Email<input class="in" type="email" name="email" required autocomplete="email"></label>
  <label>Password${reg ? ' (at least 8 characters)' : ''}<input class="in" type="password" name="password" required minlength="${reg ? 8 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
  ${reg ? '<label>I am a<select class="in" name="accountType"><option value="customer">Customer</option><option value="owner">Salon owner</option></select></label>' : ''}
  <button class="btn block">${reg ? 'Create account' : 'Log in'}</button></form>
  <button class="link" data-a="mode">${reg ? 'Have an account? Log in' : 'New here? Create an account'}</button><div class="muted small" style="text-align:center">Version ${VERSION}</div></div></main></div>`;
}

/* ---------- shell ---------- */
function tabsFor() {
  const r = A.user.role;
  if (r === 'owner') return [['salon', 'My salon'], ['support', 'Support']];
  if (r === 'admin') return [];
  return [['explore', 'Salons'], ['mine', 'My bookings']];
}
function shell() {
  let body = '', dock = '';
  if (V.tab === 'explore') { body = V.view === 'shop' ? shopView() : V.view === 'book' ? bookView() : V.view === 'ticket' ? ticketView() : listView(); dock = V.view === 'shop' ? shopDock() : V.view === 'book' ? bookDock() : ''; }
  else if (V.tab === 'mine') body = mineView();
  else if (V.tab === 'salon') body = salonView();
  else if (V.tab === 'support') body = supportView();
  else body = adminView();
  const tabs = tabsFor();
  return `<div class="app"><header class="top"><div class="row"><div class="logo"><img src="/pin.png" alt="">Just<span>Trim</span></div><div class="sp"></div><span class="small" style="opacity:.8">${esc(A.user.name)}${A.user.role !== 'customer' ? ' · ' + (A.user.role === 'admin' ? 'Super Admin' : 'Salon owner') : ''}</span><button class="clock" data-a="logout">Log out</button></div>
  ${tabs.length ? `<div class="seg">${tabs.map(([k, l]) => `<button class="${V.tab === k ? 'on' : ''}" data-a="tab" data-v="${k}">${l}</button>`).join('')}</div>` : ''}</header><main class="pad">${body}<div class="muted small" style="text-align:center;margin-top:16px">Version ${VERSION}</div></main>${dock}</div>`;
}
function render() {
  const y = window.scrollY, f = document.activeElement, fid = f && f.id, pos = f && f.selectionStart;
  $('#app').innerHTML = A.user ? shell() : authView();
  const n = fid && document.getElementById(fid); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch {} }
  renderModal(); window.scrollTo(0, TOP ? 0 : y); TOP = false;
}

/* ---------- customer: explore, book ---------- */
function listHtml() {
  const q = V.q.trim().toLowerCase();
  const L = V.salons.filter(s => (V.type === 'All' || s.type === V.type || s.type === 'Unisex') && (!q || (s.name + ' ' + s.area).toLowerCase().includes(q)));
  if (!L.length) return empty('No salons yet. Salons appear here once they are approved.');
  return L.map(s => `<button class="card shopcard" data-a="openShop" data-id="${s.id}"><div class="row"><div class="sp"><h3>${esc(s.name)}</h3><div class="muted small">${esc(s.area)} · ${s.type}</div></div>${s.rating ? `<div class="rate">★ ${s.rating.toFixed(1)}</div>` : ''}</div>${crowdHtml(s.crowd)}${s.offer ? `<div class="offer">${s.offer.pct}% off with ${esc(s.offer.code)}</div>` : ''}</button>`).join('');
}
function listView() {
  return `<div class="stack"><h2>Salons near you</h2><input class="in" id="q" data-in="q" placeholder="Search salons or areas" value="${esc(V.q)}" aria-label="Search salons">
  <div class="chips">${['All', 'Men', 'Women', 'Unisex'].map(x => `<button class="chip ${V.type === x ? 'on' : ''}" data-a="setType" data-v="${x}">${x}</button>`).join('')}</div>
  <div id="shoplist" class="stack">${listHtml()}</div></div>`;
}
const svcOf = id => V.shop.services.find(x => x.id === id), cmbOf = id => V.shop.combos.find(x => x.id === id);
const selItems = () => V.sel.filter(x => x.t === 'combo' ? cmbOf(x.id) : svcOf(x.id));
const offers = (st, id) => st.services.find(x => x.serviceId === id);
const staffCan = (st, items) => items.every(it => it.t === 'combo' ? cmbOf(it.id).serviceIds.every(id => offers(st, id)) : offers(st, it.id));
const staffDur = (st, items) => items.reduce((a, it) => a + (it.t === 'combo' ? cmbOf(it.id).durMin : (offers(st, it.id).durMin ?? svcOf(it.id).durMin)), 0);
const itemsTotal = items => items.reduce((a, it) => a + (it.t === 'combo' ? cmbOf(it.id).price : svcOf(it.id).price), 0);
const itemsQuery = () => selItems().map(i => i.t + ':' + i.id).join(',');
function shopView() {
  const D = V.shop, s = D.salon, items = selItems(), on = (t, id) => V.sel.some(x => x.t === t && x.id === id);
  const stRow = st => {
    const ok = !items.length || staffCan(st, items);
    return `<div class="card st ${V.staffId === st.id ? 'sel' : ''} ${ok ? '' : 'dim'}" data-a="pickStaff" data-id="${st.id}">${avatar(st)}<div class="sp"><b>${esc(st.name)}</b> <span class="muted small">${st.rating ? '★ ' + st.rating.toFixed(1) : 'New'}</span><div class="muted small">${esc(st.spec)}</div>${!ok ? '<div class="small muted">Does not do the selected service</div>' : st.onLeaveToday ? '<div class="small muted">On leave today</div>' : ''}</div></div>`;
  };
  return `<div class="stack"><button class="link" data-a="backList">‹ Back</button><div><h2>${esc(s.name)}</h2><div class="muted small">${esc(s.address || s.area)} · ${fmtT(s.openMin)}–${fmtT(s.closeMin)}${s.offDays.length ? ' · Off: ' + s.offDays.map(d => DAYS[d]).join(', ') : ''}</div></div>
  <div class="card">${crowdHtml(s.crowd)}${s.crowd.closed ? '' : '<button class="btn alt block" style="margin-top:10px" data-a="joinQueue">Join walk-in queue</button>'}${s.offer ? `<div class="offer">${s.offer.pct}% off with ${esc(s.offer.code)}</div>` : ''}</div>
  <h3>Services</h3><div>${D.services.map(v => `<button class="pick ${on('svc', v.id) ? 'on' : ''}" data-a="togItem" data-t="svc" data-id="${v.id}"><span class="ck">${on('svc', v.id) ? '✓' : ''}</span><span class="sp"><b>${esc(v.name)}</b><div class="muted small">${v.durMin} min (varies by stylist)</div></span><b>${inr(v.price)}</b></button>`).join('')}</div>
  ${D.combos.length ? `<h3>Combos</h3><div>${D.combos.map(v => `<button class="pick ${on('combo', v.id) ? 'on' : ''}" data-a="togItem" data-t="combo" data-id="${v.id}"><span class="ck">${on('combo', v.id) ? '✓' : ''}</span><span class="sp"><b>${esc(v.name)}</b><div class="muted small">${v.serviceIds.map(id => svcOf(id) ? esc(svcOf(id).name) : '').join(' + ')} · ${v.durMin} min${(sv => sv > v.price ? ' · save ' + inr(sv - v.price) : '')(v.serviceIds.reduce((a, id) => a + (svcOf(id) ? svcOf(id).price : 0), 0))}</div></span><b>${inr(v.price)}</b></button>`).join('')}</div>` : ''}
  <h3>Stylists</h3><div><div class="card st ${V.staffId === 'any' ? 'sel' : ''}" data-a="pickStaff" data-id="any"><div class="av" style="background:var(--brand);color:var(--brand-ink)" aria-hidden="true">★</div><div class="sp"><b>Any available</b><div class="muted small">We assign the first free stylist</div></div></div>${D.staff.map(stRow).join('')}</div></div>`;
}
function shopDock() {
  const items = selItems();
  if (!items.length) return '<div class="dock"><div class="sp muted">Pick one or more services to continue.</div></div>';
  const els = V.shop.staff.filter(st => staffCan(st, items) && (V.staffId === 'any' || st.id === V.staffId));
  const d = els.length ? Math.min(...els.map(st => staffDur(st, items))) : 0;
  return `<div class="dock"><div class="sp"><b>${inr(itemsTotal(items))}</b><div class="muted small">${d ? d + ' min' : 'No stylist does all of these'}</div></div><button class="btn acc" data-a="toBook" ${d ? '' : 'disabled'}>Choose time</button></div>`;
}
function bookView() {
  const D = V.shop, items = selItems(), s = D.salon, st = D.staff.filter(x => staffCan(x, items));
  const days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(TODAY, i));
  const price = V.slot ? V.slot.price : itemsTotal(items);
  const disc = s.offer && V.code && V.code.toUpperCase() === s.offer.code.toUpperCase() ? Math.round(price * s.offer.pct / 100) : 0;
  return `<div class="stack"><button class="link" data-a="backShop">‹ Back</button><h2>Pick your time</h2>
  <div class="card"><b>${esc(s.name)}</b><div class="muted small">${items.map(i => esc(i.t === 'combo' ? cmbOf(i.id).name : svcOf(i.id).name)).join(' + ')}</div></div>
  <div><label>Stylist</label><div class="chips"><button class="chip ${V.staffId === 'any' ? 'on' : ''}" data-a="pickStaff2" data-id="any">Any available</button>${st.map(x => `<button class="chip ${V.staffId === x.id ? 'on' : ''}" data-a="pickStaff2" data-id="${x.id}">${esc(x.name)}</button>`).join('')}</div></div>
  <div><label>Date</label><div class="chips">${days.map(x => `<button class="chip ${V.date === x ? 'on' : ''}" data-a="pickDate" data-v="${x}" ${s.offDays.includes(dow(x)) || s.holidays.includes(x) ? 'disabled' : ''}>${dayLabel(x)}</button>`).join('')}</div></div>
  <div><label>Free slots</label>${V.slots.length ? `<div class="slots">${V.slots.map(x => `<button class="slot ${V.slot && V.slot.start === x.start && V.slot.staffId === x.staffId ? 'on' : ''}" data-a="pickSlot" data-t="${x.start}">${fmtT(x.start)}</button>`).join('')}</div>` : empty('No free slots on this day. Try another day or stylist.')}</div>
  <div class="card stack">${s.offer ? `<div class="row gap"><input class="in sp" id="code" placeholder="Offer code" value="${esc(V.code)}"><button class="btn alt sm" data-a="applyCode">Apply</button></div>${disc ? `<div class="note ok">${s.offer.pct}% off applied</div>` : ''}` : ''}
  ${A.user.points > 0 ? `<label style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" data-ch="pts" ${V.pts ? 'checked' : ''}> Use loyalty points (you have ${A.user.points})</label>` : ''}
  ${D.settings.advanceAmount ? `<label style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" data-ch="adv" ${V.adv ? 'checked' : ''}> Pay ${inr(D.settings.advanceAmount)} advance (cuts no-shows)</label>` : ''}
  <hr><div class="row"><b class="sp">Total</b><b>${inr(price - disc)}${V.pts ? ' or less' : ''}</b></div></div></div>`;
}
const bookDock = () => `<div class="dock"><div class="sp muted small">${V.slot ? fmtT(V.slot.start) + ' · ' + dayLabel(V.date) : 'Choose a time slot'}</div><button class="btn acc" data-a="confirmBook" ${V.slot ? '' : 'disabled'}>Confirm booking</button></div>`;
function ticketView() {
  const b = V.ticket, st = V.shop.staff.find(x => x.id === b.staffId);
  return `<div class="stack"><h2>${b.type === 'walkin' ? "You're in the queue" : 'Booking confirmed'}</h2>
  <div class="ticket"><div class="tk-top"><div><div class="muted small">Token</div><div class="tk-no">#${b.token}</div></div><div style="text-align:right"><b>${dayLabel(b.date)}</b><div style="font:800 24px 'Bricolage Grotesque',sans-serif">${fmtT(b.startMin)}</div><div class="muted small">${b.durMin} min</div></div></div><div class="tk-cut"></div>
  <div class="tk-bot"><b>${esc(V.shop.salon.name)}</b><div class="muted small">${esc(V.shop.salon.address || V.shop.salon.area)}</div><div style="margin-top:8px">${b.items.map(i => esc(i.name)).join(' + ')}${st ? ' with <b>' + esc(st.name) + '</b>' : ''}</div><div class="muted small">${b.advance ? 'Advance ' + inr(b.advance) + ' · ' : ''}Pay ${inr(Math.max(0, b.price - b.advance))} at the salon</div></div></div>
  <div class="note ok">The salon has been notified on their phone.</div><button class="btn block" data-a="tab" data-v="mine">View my bookings</button><button class="btn alt block" data-a="backList">Back to salons</button></div>`;
}
function mineView() {
  const up = V.mine.filter(b => b.status === 'booked' || b.status === 'inservice'), past = V.mine.filter(b => !up.includes(b));
  const card = b => `<div class="card stack"><div class="row"><div class="sp"><b>${esc(b.salonName)}</b><div class="muted small">${dayLabel(b.date)} · ${fmtT(b.startMin)} · ${esc(b.staffName)}</div></div>${pill(b.status, STAT[b.status])}</div><div>${b.items.map(i => esc(i.name)).join(' + ')} · ${inr(b.price)} · Token #${b.token}</div>
  ${b.status === 'booked' ? `<div class="row gap"><button class="btn bad sm" data-a="cancelBk" data-id="${b.id}">Cancel</button></div>` : ''}
  ${b.status === 'done' ? `<span class="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-a="rate" data-id="${b.id}" data-n="${n}" aria-label="${n} stars" ${b.rating ? 'disabled' : ''}>${n <= (b.rating || 0) ? '★' : '☆'}</button>`).join('')}</span>` : ''}</div>`;
  return `<div class="stack"><h2>My bookings</h2><div class="muted small">Loyalty points: ${A.user.points}. Free changes until 2 hours before your slot.</div>${up.length ? up.map(card).join('') : empty('No upcoming bookings. Find a salon and grab a slot.')}${past.length ? '<h3>Earlier</h3>' + past.map(card).join('') : ''}</div>`;
}

/* ---------- salon owner ---------- */
const curSalon = () => V.my.find(s => s.id === V.sid);
function billBanner(b) {
  if (!b) return '';
  const days = Math.round((new Date(b.until + 'T00:00:00') - new Date(TODAY + 'T00:00:00')) / 864e5);
  if (b.state === 'grace') return `<div class="note">Payment was due ${fmtD(b.until)}. Pay soon to keep taking bookings. <button class="btn sm" data-a="pay">Pay now</button></div>`;
  if (b.state === 'expired') return `<div class="note bad">Subscription expired. Customers cannot see or book this salon. <button class="btn sm" data-a="pay">Pay now</button></div>`;
  if (b.state === 'trial' && days <= 14) return `<div class="note">Free trial ends in ${days} days.</div>`;
  return '';
}
function salonForm(branch) {
  return `<form class="card stack" data-submit="regSave"><b>${branch ? 'Add a branch' : 'Register your salon'}</b><label>${branch ? 'Branch name' : 'Salon name'}<input class="in" name="name" required></label>
  <div class="cols2"><label>Area<input class="in" name="area" required></label><label>Type<select class="in" name="type"><option>Men</option><option>Women</option><option>Unisex</option></select></label></div>
  <label>Address<input class="in" name="address" required></label><div class="cols2"><label>Opens<select class="in" name="openMin">${timeOpts(540)}</select></label><label>Closes<select class="in" name="closeMin">${timeOpts(1260)}</select></label></div>
  <label>People working<input class="in" type="number" name="staffCount" min="1" value="2"></label><div class="note">Next you add your team, menu prices and payment details, then submit for approval. The first 3 months are free after approval.</div><button class="btn block">Create salon</button></form>`;
}
function setupCard() {
  const s = curSalon(), M = V.manage, ok = [['Address added', !!M.salon.address], ['At least 1 stylist', M.staff.length > 0], ['Menu has services', M.services.length > 0], ['Payment details saved', M.billingDetails.agreed]];
  return `<div class="card stack"><b>Before you submit for approval</b>${s.status === 'rejected' ? '<div class="note bad">This salon was rejected. Fix the details and submit again.</div>' : ''}<div class="checks">${ok.map(([l, v]) => `<span class="tag" style="background:var(${v ? '--okbg' : '--badbg'})">${v ? '✓' : '✕'} ${l}</span>`).join('')}</div>${M.billingDetails.agreed ? '' : '<button class="btn alt block" data-a="sTab" data-v="billing">Go to Payment</button>'}<button class="btn block" data-a="submitSalon" ${ok.every(x => x[1]) ? '' : 'disabled'}>Submit for approval</button></div>`;
}
function salonView() {
  if (!V.my.length) return `<div class="stack"><h2>Set up your salon</h2>${salonForm(false)}</div>`;
  const s = curSalon(), tabs = [['today', 'Today'], ['walkin', 'Walk-ins'], ['team', 'Team'], ['menu', 'Menu'], ['shop', 'Shop'], ['billing', 'Payment']];
  const notes = { pending: 'Waiting for Super Admin approval. Customers cannot see this salon yet. Add your team and menu meanwhile.', rejected: 'This salon was rejected. Update the details or contact support.', suspended: 'This salon is suspended by Super Admin.' };
  const body = { today: salonToday, walkin: salonWalkin, team: salonTeam, menu: salonMenu, shop: salonShop, billing: salonBilling }[V.stab]();
  return `<div class="stack"><div class="row gap" style="flex-wrap:nowrap"><select class="in" data-ch="sPick" aria-label="Choose salon">${V.my.map(x => `<option value="${x.id}" ${x.id === V.sid ? 'selected' : ''}>${esc(x.name)}${x.status !== 'approved' ? ' (' + x.status + ')' : ''}</option>`).join('')}</select><button class="btn alt sm" data-a="branchAdd">+ Branch</button></div>
  ${s.status === 'draft' || s.status === 'rejected' ? setupCard() : s.status !== 'approved' ? `<div class="note ${s.status === 'pending' ? '' : 'bad'}">${notes[s.status]}</div>` : billBanner(s.billing)}
  <div class="chips">${tabs.map(([k, l]) => `<button class="chip ${V.stab === k ? 'on' : ''}" data-a="sTab" data-v="${k}">${l}</button>`).join('')}</div>${body}</div>`;
}
const stName = id => { const x = V.manage.staff.find(y => y.id === id); return x ? x.name : ''; };
function salonToday() {
  const L = V.sbk.filter(b => b.status !== 'cancelled'), done = L.filter(b => b.status === 'done');
  const row = b => `<div class="card stack"><div class="row"><div class="sp"><b>${fmtT(b.startMin)}–${fmtT(b.startMin + b.durMin)}</b> <span class="tag">${b.type === 'walkin' ? 'Walk-in #' : '#'}${b.token}</span><div>${esc(b.customerName)} · ${b.items.map(i => esc(i.name)).join(' + ')}</div><div class="muted small">${esc(stName(b.staffId))} · ${inr(b.price)}${b.advance ? ' · advance paid' : ''}</div></div>${pill(b.status, STAT[b.status])}</div>
  ${b.status === 'booked' ? `<div class="row gap"><button class="btn sm" data-a="bkSet" data-id="${b.id}" data-s="inservice">Start</button><button class="btn alt sm" data-a="bkSet" data-id="${b.id}" data-s="noshow">No-show</button><button class="btn bad sm" data-a="bkSet" data-id="${b.id}" data-s="cancelled">Cancel</button></div>` : b.status === 'inservice' ? `<button class="btn acc sm" data-a="bkSet" data-id="${b.id}" data-s="done">Mark done</button>` : ''}</div>`;
  return `<div class="chips">${[-1, 0, 1, 2, 3].map(i => { const d = addDays(TODAY, i); return `<button class="chip ${V.sdate === d ? 'on' : ''}" data-a="sDate" data-v="${d}">${i === -1 ? 'Yesterday' : dayLabel(d)}</button>`; }).join('')}</div>
  <div class="kpis"><div class="kpi"><b>${L.length}</b>Bookings</div><div class="kpi"><b>${L.filter(b => b.type === 'walkin').length}</b>Walk-ins</div><div class="kpi"><b>${done.length}</b>Completed</div><div class="kpi"><b>${inr(done.reduce((a, b) => a + b.price, 0))}</b>Earned</div></div>
  <h3>Bookings</h3>${V.sbk.length ? V.sbk.map(row).join('') : empty('No bookings on this day yet. New ones appear here instantly.')}`;
}
const itemChecks = () => `<div class="checks">${V.manage.services.map(v => `<label><input type="checkbox" name="it" value="svc:${v.id}"> ${esc(v.name)}</label>`).join('')}${V.manage.combos.map(v => `<label><input type="checkbox" name="it" value="combo:${v.id}"> ${esc(v.name)}</label>`).join('')}</div>`;
const salonWalkin = () => `<form class="card stack" data-submit="walkinAdd"><b>Add a walk-in</b><label>Customer name<input class="in" name="name" placeholder="Name (optional)"></label><div><label>Services</label>${itemChecks()}</div><label>Stylist<select class="in" name="staff"><option value="any">Any available</option>${V.manage.staff.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label><button class="btn block">Add to queue</button></form><div class="muted small">Walk-ins you add here also update the crowd meter customers see.</div>`;
function salonTeam() {
  const M = V.manage;
  return `<button class="btn block" data-a="staffAdd">+ Add team member</button>${M.staff.length ? M.staff.map(x => `<div class="card stack"><div class="row">${avatar(x)}<div class="sp"><b>${esc(x.name)}</b><div class="muted small">${esc(x.spec)}</div></div></div><div class="small muted">${x.services.map(o => { const v = M.services.find(y => y.id === o.serviceId); return v ? esc(v.name) + ' ' + (o.durMin ?? v.durMin) + 'm' : ''; }).join(' · ')}</div>${x.leave.length ? `<div class="small">Leave: ${x.leave.map(dayLabel).join(', ')}</div>` : ''}<div class="row gap"><button class="btn alt sm" data-a="staffEdit" data-id="${x.id}">Edit</button><button class="btn bad sm" data-a="staffDel" data-id="${x.id}">Remove</button></div></div>`).join('') : empty('No team members yet. Add stylists with a photo and their speciality.')}`;
}
function salonMenu() {
  const M = V.manage, sum = c => c.serviceIds.reduce((a, id) => { const y = M.services.find(z => z.id === id); return a + (y ? y.price : 0); }, 0);
  return `<div class="row gap"><button class="btn sm" data-a="svcAdd">+ Service</button><button class="btn alt sm" data-a="comboAdd">+ Combo offer</button></div><div class="muted small">Change a name, price or time and press Save. A stylist's own time (in Team) overrides the default time.</div>
  <h3>Services</h3>${M.services.map(v => `<form class="card stack" data-submit="svcInline" data-id="${v.id}"><label>Name<input class="in" name="name" value="${esc(v.name)}" required></label><div class="cols2"><label>Price (₹)<input class="in" type="number" min="0" name="price" value="${v.price}" required></label><label>Time (minutes)<input class="in" type="number" min="5" step="5" name="durMin" value="${v.durMin}" required></label></div><div class="row gap"><button class="btn sm">Save</button><button type="button" class="btn bad sm" data-a="svcDel" data-id="${v.id}">Remove</button></div></form>`).join('') || empty('No services yet.')}
  <h3>Combo offers</h3>${M.combos.map(v => { const save = sum(v) - v.price; return `<div class="card stack"><div class="row"><div class="sp"><b>${esc(v.name)}</b><div class="muted small">${v.serviceIds.map(id => { const y = M.services.find(z => z.id === id); return y ? esc(y.name) : ''; }).join(' + ')}<br>${v.durMin} min · ${inr(v.price)}${save > 0 ? ' · customers save ' + inr(save) : ''}</div></div>${pill(v.active ? 'active' : 'draft', v.active ? 'On' : 'Off')}</div><div class="row gap"><button class="btn alt sm" data-a="comboEdit" data-id="${v.id}">Edit</button><button class="btn alt sm" data-a="comboToggle" data-id="${v.id}">${v.active ? 'Switch off' : 'Switch on'}</button><button class="btn bad sm" data-a="comboDel" data-id="${v.id}">Remove</button></div></div>`; }).join('') || empty('No combo offers yet. Bundle services at a better price.')}`;
}
function salonShop() {
  const s = V.manage.salon;
  return `<form class="card stack" data-submit="shopSave"><b>Salon details</b><label>Shop name<input class="in" name="name" value="${esc(s.name)}" required></label>
  <div class="cols2"><label>Area<input class="in" name="area" value="${esc(s.area)}" required></label><label>Type<select class="in" name="type">${['Men', 'Women', 'Unisex'].map(x => `<option ${s.type === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label></div>
  <label>Address<input class="in" name="address" value="${esc(s.address)}"></label><div class="cols2"><label>Opens<select class="in" name="openMin">${timeOpts(s.openMin)}</select></label><label>Closes<select class="in" name="closeMin">${timeOpts(s.closeMin)}</select></label></div>
  <div><label>Weekly off</label><div class="checks">${DAYS.map((d, i) => `<label><input type="checkbox" name="off" value="${i}" ${s.offDays.includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div></div>
  <div class="cols2"><label>Offer code<input class="in" name="ocode" value="${esc(s.offer ? s.offer.code : '')}" placeholder="e.g. FIRST10"></label><label>Discount %<input class="in" type="number" min="0" max="50" name="opct" value="${s.offer ? s.offer.pct : ''}"></label></div><button class="btn block">Save details</button></form>
  <div class="card stack"><b>Holidays</b><div class="row gap"><input class="in sp" type="date" id="hol" min="${TODAY}"><button class="btn alt sm" data-a="holAdd">Add</button></div><div class="chips" style="flex-wrap:wrap">${s.holidays.length ? s.holidays.map(d => `<button class="chip" data-a="holDel" data-v="${d}">${dayLabel(d)} ✕</button>`).join('') : '<span class="muted small">No holidays set.</span>'}</div></div>`;
}
function salonBilling() {
  const b = V.bill, d = V.manage.billingDetails;
  return `<form class="card stack" data-submit="billSave"><b>Payment details</b><div class="note">${b.trialMonths} months free after approval. Then ${inr(b.pricePerMonth)} per month + ${b.gstPct}% GST.${d.agreed ? '' : ' Save these details to unlock Submit for approval.'}</div>
  <label>Billing name<input class="in" name="name" value="${esc(d.name)}" required placeholder="Business or owner name"></label><label>Billing email<input class="in" type="email" name="email" value="${esc(d.email || A.user.email)}" required></label>
  <label>GSTIN (optional)<input class="in" name="gstin" value="${esc(d.gstin)}" maxlength="15" placeholder="15 characters" style="text-transform:uppercase"></label>
  <label style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" name="agree" ${d.agreed ? 'checked' : ''}> I agree to pay the subscription after the free period</label><button class="btn block">Save payment details</button></form>
  <div class="card stack"><div class="row"><b class="sp">${BL[b.state]}</b><span class="tag">${inr(b.pricePerMonth)}/month</span></div><div class="muted small">${b.state === 'trial' ? 'Free until ' + fmtD(b.until) + '.' : b.state === 'active' ? 'Paid until ' + fmtD(b.until) + '.' : 'Was due ' + fmtD(b.until) + '.'}</div>
  <button class="btn alt block" data-a="pay">${b.state === 'trial' ? 'Pay early' : 'Pay ' + inr(b.pricePerMonth) + ' + GST'}</button>
  ${b.invoices.length ? '<div class="small muted">Invoices</div>' + b.invoices.slice(0, 6).map(i => `<div class="row small"><span class="sp">${fmtD(i.issued)}</span><span>${inr(i.amount)} + ${inr(i.gst)} GST · ${i.status}</span></div>`).join('') : ''}</div>`;
}

/* ---------- support questions ---------- */
function qCard(x, adm) {
  return `<div class="card stack"><div class="row"><div class="sp"><b>${esc(x.subject)}</b><div class="muted small">${adm ? esc(x.userEmail) + (x.salonName ? ' · ' + esc(x.salonName) : '') : (x.salonName ? esc(x.salonName) : 'General')}</div></div>${pill(x.status === 'open' ? 'grace' : 'active', x.status === 'open' ? 'Open' : 'Resolved')}</div>
  ${x.messages.map(m => `<div class="msg ${m.from === 'admin' ? 'admin' : ''}"><div class="muted small">${m.from === 'admin' ? 'Super Admin' : (adm ? 'Salon owner' : 'You')}</div>${esc(m.body)}</div>`).join('')}
  <form class="row gap" data-submit="qReply" data-id="${x.id}" style="flex-wrap:nowrap"><input class="in sp" name="body" required placeholder="Write a reply"><button class="btn sm">Send</button></form>
  ${adm ? `<button class="btn alt sm" data-a="qStatus" data-id="${x.id}" data-v="${x.status === 'open' ? 'resolved' : 'open'}">${x.status === 'open' ? 'Mark resolved' : 'Reopen'}</button>` : ''}</div>`;
}
function supportView() {
  return `<div class="stack"><h2>Support</h2><div class="muted small">Ask Super Admin about approval, payments, pricing or anything else. You will see the answer here.</div>
  <form class="card stack" data-submit="qNew"><b>New question</b>${V.my.length ? `<label>About<select class="in" name="salonId"><option value="">General</option>${V.my.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>` : ''}
  <label>Subject<input class="in" name="subject" required maxlength="120"></label><label>Message<textarea class="in" name="body" rows="3" required maxlength="2000"></textarea></label><button class="btn block">Send to Super Admin</button></form>
  <h3>Your questions</h3>${V.queries.length ? V.queries.map(x => qCard(x, false)).join('') : empty('No questions yet.')}</div>`;
}

/* ---------- Super Admin ---------- */
function adminView() {
  const o = V.ov, T = V.atab;
  const tabs = [['overview', 'Overview'], ['approve', 'Approvals' + (o.pending ? ' (' + o.pending + ')' : '')], ['salons', 'Salons'], ['settings', 'Pricing'], ['queries', 'Queries' + (o.openQueries ? ' (' + o.openQueries + ')' : '')], ['tickets', 'Disputes' + (o.openDisputes ? ' (' + o.openDisputes + ')' : '')], ['users', 'Users']];
  let body = '';
  if (T === 'overview') {
    const mx = Math.max(1, ...o.daily.map(x => x.n));
    body = `<div class="kpis"><div class="kpi"><b>${o.salonsLive}</b>Salons live</div><div class="kpi"><b>${o.pending}</b>Awaiting approval</div><div class="kpi"><b>${inr(o.mrr)}</b>Monthly recurring</div><div class="kpi"><b>${o.bookingsToday}</b>Bookings today</div><div class="kpi"><b>${o.customers}</b>Customers</div><div class="kpi"><b>${o.owners}</b>Salon owners</div><div class="kpi"><b>${o.openQueries}</b>Open salon questions</div><div class="kpi"><b>${o.openDisputes}</b>Open disputes</div></div>
    <div class="card"><b>Bookings, last 7 days</b><div class="vbars" style="margin-top:8px">${o.daily.map(x => `<div class="vb"><span>${x.n}</span><i style="height:${x.n / mx * 80}%"></i><span>${DAYS[dow(x.date)]}</span></div>`).join('')}</div></div>
    <div class="muted small">Booking value today: ${inr(o.bookingValueToday)}. Standard subscription: ${inr(o.saasPrice)} per salon per month.</div>`;
  } else if (T === 'approve') {
    const L = V.asalons.filter(s => s.status === 'pending');
    body = L.length ? L.map(s => { const ok = [['Location added', !!s.address], ['Timings set', s.closeMin > s.openMin], ['Menu has services', s.servicesCount > 0], ['At least 1 stylist added', s.staffAdded > 0], ['Payment details confirmed', s.billingReady]];
      return `<div class="card stack"><div><h3>${esc(s.name)}</h3><div class="muted small">${esc(s.area)} · ${esc(s.address || 'No address')} · ${s.type} · ${esc(s.ownerEmail)}</div></div><div class="small">Hours ${fmtT(s.openMin)}–${fmtT(s.closeMin)} · ${s.staffDeclared} staff declared · ${s.staffAdded} added</div><div class="checks">${ok.map(([l, v]) => `<span class="tag" style="background:var(${v ? '--okbg' : '--badbg'})">${v ? '✓' : '✕'} ${l}</span>`).join('')}</div><div class="row gap"><button class="btn sm" data-a="aAct" data-id="${s.id}" data-v="approve" ${ok.every(x => x[1]) ? '' : 'disabled'}>Approve</button><button class="btn bad sm" data-a="aAct" data-id="${s.id}" data-v="reject">Reject</button></div></div>`; }).join('') : empty('No salons waiting. Salons appear here after the owner submits them.');
  } else if (T === 'salons') {
    body = V.asalons.filter(s => s.status !== 'pending').map(s => { const b = s.billing, off = s.status !== 'approved';
      return `<div class="card stack"><div class="row"><div class="sp"><b>${esc(s.name)}</b><div class="muted small">${esc(s.area)} · ${esc(s.ownerEmail)} · joined ${fmtD(s.joined)}</div></div>${pill(off ? s.status : b.state, off ? s.status : BL[b.state])}</div><div class="small muted">${b.state === 'trial' ? 'Trial ends ' + fmtD(b.until) : b.state === 'active' ? 'Paid until ' + fmtD(b.until) : 'Payment due since ' + fmtD(b.until)} · ${inr(s.customPrice ?? o.saasPrice)}/month${s.customPrice != null ? ' (custom)' : ''}</div>
      <form class="row gap" data-submit="aPrice" data-id="${s.id}" style="flex-wrap:nowrap"><input class="in sp" type="number" min="0" name="price" placeholder="Custom ₹/month (empty = standard)" value="${s.customPrice ?? ''}"><button class="btn alt sm">Set price</button></form>
      <div class="row gap"><button class="btn sm" data-a="aAct" data-id="${s.id}" data-v="mark-paid">Mark paid</button><button class="btn alt sm" data-a="aAct" data-id="${s.id}" data-v="extend-trial">+1 month trial</button>${off ? `<button class="btn sm" data-a="aAct" data-id="${s.id}" data-v="activate">Activate</button>` : `<button class="btn bad sm" data-a="aAct" data-id="${s.id}" data-v="suspend">Suspend</button>`}</div></div>`; }).join('') || empty('No salons yet.');
  } else if (T === 'settings') {
    const c = V.settings, f = (k, l) => `<label>${l}<input class="in" type="number" name="${k}" min="0" value="${c[k]}"></label>`;
    body = `<form class="card stack" data-submit="cfgSave"><b>Subscription and booking settings</b><div class="muted small">The standard price applies to every salon unless you set a custom price on its card in the Salons tab.</div><div class="cols2">${f('saas_price', 'Subscription (₹/month)')}${f('trial_months', 'Free trial (months)')}${f('grace_days', 'Grace period (days)')}${f('gst_pct', 'GST %')}${f('customer_fee', 'Customer fee (₹)')}${f('advance_amount', 'Advance token (₹)')}${f('slot_buffer_min', 'Slot buffer (min)')}</div><button class="btn block">Save settings</button></form>`;
  } else if (T === 'queries') body = V.aqueries.length ? V.aqueries.map(x => qCard(x, true)).join('') : empty('No questions from salon owners.');
  else if (T === 'tickets') body = V.tickets.length ? V.tickets.map(k => `<div class="card stack"><div class="row"><div class="sp"><b>${esc(k.salon_name)}</b></div>${pill(k.status === 'open' ? 'grace' : 'active', k.status)}</div><div>${esc(k.text)}</div>${k.status === 'open' ? `<div class="row gap"><button class="btn sm" data-a="tkSet" data-id="${k.id}" data-v="refunded">Refund ${inr(k.amount)}</button><button class="btn alt sm" data-a="tkSet" data-id="${k.id}" data-v="rejected">Reject</button></div>` : ''}</div>`).join('') : empty('No customer disputes.');
  else body = `<form class="row gap" data-submit="uSearch" style="flex-wrap:nowrap"><input class="in sp" name="q" placeholder="Search name or email" value="${esc(V.uq || '')}"><button class="btn alt sm">Search</button></form>${V.users.map(u => `<div class="card row"><div class="sp"><b>${esc(u.name || '—')}</b><div class="muted small">${esc(u.email)} · joined ${fmtD(u.createdAt.slice(0, 10))}</div></div>${pill(u.role === 'admin' ? 'active' : u.role === 'owner' ? 'grace' : 'approved', u.role)}<button class="btn alt sm" data-a="userReset" data-email="${esc(u.email)}">Reset password</button></div>`).join('') || empty('No users found.')}`;
  return `<div class="stack"><h2>Super Admin</h2><div class="chips">${tabs.map(([k, l]) => `<button class="chip ${T === k ? 'on' : ''}" data-a="aTab" data-v="${k}">${l}</button>`).join('')}</div>${body}</div>`;
}

/* ---------- modals ---------- */
function modalBody(M) {
  switch (M.type) {
    case 'reset': return `<h3>Reset password</h3><form class="stack" data-submit="resetPw"><div class="muted small">${esc(M.email)}</div><input type="hidden" name="email" value="${esc(M.email)}"><label>New password (8 or more characters)<input class="in" type="text" name="password" minlength="8" required></label><div class="muted small">Share it with the user safely and ask them to change it.</div><button class="btn block">Reset password</button><button type="button" class="btn alt block" data-a="closeModal">Cancel</button></form>`;
    case 'branch': return `<h3>Add a branch</h3>${salonForm(true)}<button type="button" class="btn alt block" data-a="closeModal">Cancel</button>`;
    case 'staff': {
      const d = M.draft;
      return `<h3>${M.id ? 'Edit' : 'Add'} team member</h3><form id="mf" class="stack" data-submit="staffSave"><div class="row">${avatar({ name: d.name || '?', photo: d.photo })}<label class="sp">Photo<input type="file" accept="image/*" data-ch="photo" class="in"></label></div>
      <label>Name<input class="in" name="name" value="${esc(d.name)}" required></label><label>Speciality<input class="in" name="spec" value="${esc(d.spec)}" placeholder="e.g. Skin fades & beard styling"></label>
      <div><label>Services they do and their own time (minutes)</label>${V.manage.services.map(v => `<div class="sv-row"><label><input type="checkbox" name="sv" value="${v.id}" ${d.svc[v.id] !== undefined ? 'checked' : ''}> ${esc(v.name)} <span class="muted small">(${v.durMin})</span></label><input class="in" type="number" min="5" step="5" name="d_${v.id}" value="${d.svc[v.id] || ''}" placeholder="${v.durMin}"></div>`).join('')}</div>
      <div><label>Leave dates</label><div class="row gap"><input class="in sp" type="date" id="leaveDate" min="${TODAY}"><button type="button" class="btn alt sm" data-a="leaveAdd">Add</button></div><div class="chips" style="flex-wrap:wrap;margin-top:6px">${d.leave.map(x => `<button type="button" class="chip" data-a="leaveDel" data-v="${x}">${dayLabel(x)} ✕</button>`).join('')}</div></div>
      <button class="btn block">Save</button><button type="button" class="btn alt block" data-a="closeModal">Cancel</button></form>`;
    }
    case 'svc': { const v = M.id ? V.manage.services.find(x => x.id === M.id) : { name: '', price: '', durMin: 45 };
      return `<h3>${M.id ? 'Edit' : 'Add'} service</h3><form class="stack" data-submit="svcSave"><label>Name<input class="in" name="name" value="${esc(v.name)}" required></label><div class="cols2"><label>Price (₹)<input class="in" type="number" min="0" name="price" value="${v.price}" required></label><label>Default time (min)<input class="in" type="number" min="5" step="5" name="durMin" value="${v.durMin}" required></label></div><button class="btn block">Save</button><button type="button" class="btn alt block" data-a="closeModal">Cancel</button></form>`; }
    case 'combo': { const v = M.id ? V.manage.combos.find(x => x.id === M.id) : { name: '', serviceIds: [], price: '', durMin: '', active: true };
      return `<h3>${M.id ? 'Edit' : 'Add'} combo offer</h3><form class="stack" data-submit="comboSave"><label>Name<input class="in" name="name" value="${esc(v.name)}" required></label><div><label>Includes (pick at least 2)</label><div class="checks">${V.manage.services.map(x => `<label><input type="checkbox" name="cs" value="${x.id}" ${v.serviceIds.includes(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('')}</div></div><div class="cols2"><label>Offer price (₹)<input class="in" type="number" min="0" name="price" value="${v.price}" required></label><label>Total time (min)<input class="in" type="number" min="5" step="5" name="durMin" value="${v.durMin}" placeholder="Auto: sum"></label></div><label style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Offer is on (customers can book it)</label><button class="btn block">Save</button><button type="button" class="btn alt block" data-a="closeModal">Cancel</button></form>`; }
  }
  return '';
}
function renderModal() { const M = V.modal; $('#modal').innerHTML = M ? `<div class="ov"><div class="sheet" role="dialog" aria-modal="true">${modalBody(M)}</div></div>` : ''; }
function syncStaff() {
  const f = $('#mf'); if (!f || !V.modal || V.modal.type !== 'staff') return; const fd = new FormData(f), d = V.modal.draft;
  d.name = fd.get('name') || ''; d.spec = fd.get('spec') || ''; d.svc = {};
  fd.getAll('sv').forEach(id => { const x = fd.get('d_' + id); d.svc[id] = x ? Number(x) : null; });
}
function sd(M) { return M ? { name: M.name, spec: M.spec, photo: M.photo, svc: Object.fromEntries(M.services.map(o => [o.serviceId, o.durMin])), leave: M.leave.slice() } : { name: '', spec: '', photo: '', svc: {}, leave: [] }; }

/* ---------- data loading ---------- */
async function loadTab() {
  if (V.tab === 'explore' && V.view === 'list') V.salons = (await api('GET', '/salons')).salons;
  else if (V.tab === 'mine') V.mine = (await api('GET', '/bookings/mine')).bookings;
  else if (V.tab === 'salon') {
    V.my = (await api('GET', '/my/salons')).salons;
    if (V.my.length && !curSalon()) V.sid = V.my[0].id;
    if (V.sid) {
      V.manage = await api('GET', `/salons/${V.sid}/manage`);
      if (V.stab === 'today') V.sbk = (await api('GET', `/salons/${V.sid}/bookings?date=${V.sdate}`)).bookings;
      if (V.stab === 'billing') V.bill = await api('GET', `/salons/${V.sid}/billing`);
      connectLive();
    }
  } else if (V.tab === 'support') {
    V.my = (await api('GET', '/my/salons')).salons; V.queries = (await api('GET', '/queries/mine')).queries;
  } else if (V.tab === 'admin') {
    V.ov = await api('GET', '/admin/overview');
    if (V.atab === 'approve' || V.atab === 'salons') V.asalons = (await api('GET', '/admin/salons')).salons;
    if (V.atab === 'settings') V.settings = await api('GET', '/admin/settings');
    if (V.atab === 'tickets') V.tickets = (await api('GET', '/admin/tickets')).tickets;
    if (V.atab === 'queries') V.aqueries = (await api('GET', '/admin/queries')).queries;
    if (V.atab === 'users') V.users = (await api('GET', '/admin/users?q=' + encodeURIComponent(V.uq || ''))).users;
  }
}
async function refresh(top) { try { await loadTab(); } catch (e) { handleErr(e); } if (top) TOP = true; render(); }
function handleErr(e) { if (e.status === 401 && A.user) { logout(); toast('Please log in again'); } else toast('Could not complete that', e.message); }
function connectLive() {
  if (typeof EventSource === 'undefined' || V.esSid === V.sid) return;
  if (V.es) V.es.close(); V.esSid = V.sid;
  V.es = new EventSource(`/api/salons/${V.sid}/events?access_token=${encodeURIComponent(A.token)}`);
  V.es.onmessage = e => { try { toast('New booking', JSON.parse(e.data).text, 'salon'); } catch {} if (V.tab === 'salon' && V.stab === 'today') refresh(); };
}
async function loadSlots() {
  V.slot = null; const r = await api('GET', `/salons/${V.shop.salon.id}/slots?items=${itemsQuery()}&date=${V.date}&staff=${V.staffId}`); V.slots = r.slots;
}
function startSession(r) {
  A.token = r.token; A.user = r.user; localStorage.setItem('jt_token', r.token);
  V.tab = r.user.role === 'owner' ? 'salon' : r.user.role === 'admin' ? 'admin' : 'explore'; V.view = 'list';
}
function logout() { A.token = ''; A.user = null; localStorage.removeItem('jt_token'); if (V.es) { V.es.close(); V.es = null; V.esSid = null; } V.my = []; V.sid = null; render(); }
const doneToast = m => toast(m);

/* ---------- actions ---------- */
async function act(name, d, el, fd) {
  try {
    switch (name) {
      case 'mode': V.mode = V.mode === 'login' ? 'register' : 'login'; break;
      case 'login': startSession(await api('POST', '/auth/login', { email: fd.get('email'), password: fd.get('password') })); await refresh(true); return;
      case 'register': startSession(await api('POST', '/auth/register', { email: fd.get('email'), password: fd.get('password'), name: fd.get('name'), accountType: fd.get('accountType') })); toast('Welcome!', 'You got 20 welcome points.'); await refresh(true); return;
      case 'logout': logout(); return;
      case 'tab': V.tab = d.v; V.view = 'list'; V.modal = null; await refresh(true); return;
      case 'setType': V.type = d.v; break;
      case 'openShop': V.shop = await api('GET', '/salons/' + d.id); V.sel = []; V.staffId = 'any'; V.code = ''; V.pts = false; V.adv = true; V.view = 'shop'; TOP = true; break;
      case 'backList': V.view = 'list'; await refresh(true); return;
      case 'backShop': V.view = 'shop'; TOP = true; break;
      case 'togItem': { const i = V.sel.findIndex(x => x.t === d.t && x.id === d.id); if (i >= 0) V.sel.splice(i, 1); else V.sel.push({ t: d.t, id: d.id }); const st = V.shop.staff.find(x => x.id === V.staffId); if (st && !staffCan(st, selItems())) V.staffId = 'any'; break; }
      case 'pickStaff': { if (d.id !== 'any') { const st = V.shop.staff.find(x => x.id === d.id); if (selItems().length && !staffCan(st, selItems())) { toast("Can't pick " + st.name, "They don't do the selected service."); break; } } V.staffId = d.id; break; }
      case 'toBook': V.view = 'book'; V.date = TODAY; await loadSlots(); TOP = true; break;
      case 'pickStaff2': V.staffId = d.id; await loadSlots(); break;
      case 'pickDate': V.date = d.v; await loadSlots(); break;
      case 'pickSlot': { const x = V.slots.find(y => y.start === Number(d.t)); V.slot = x; break; }
      case 'applyCode': V.code = ($('#code').value || '').trim(); break;
      case 'confirmBook': {
        const r = await api('POST', '/bookings', { salonId: V.shop.salon.id, staffId: V.staffId === 'any' ? 'any' : V.staffId, date: V.date, start: V.slot.start, items: selItems().map(i => ({ t: i.t, id: i.id })), advance: V.adv && V.shop.settings.advanceAmount > 0, code: V.code, usePoints: V.pts });
        V.ticket = r.booking; V.view = 'ticket'; A.user = await api('GET', '/me'); TOP = true; break; }
      case 'joinQueue': {
        if (!selItems().length) { toast('Pick a service first', 'Select what you need, then join the queue.'); break; }
        const r = await api('POST', `/salons/${V.shop.salon.id}/walkin`, { items: selItems().map(i => ({ t: i.t, id: i.id })), staffId: V.staffId });
        V.ticket = r.booking; V.view = 'ticket'; TOP = true; break; }
      case 'cancelBk': if (!confirm('Cancel this booking? Free until 2 hours before your slot.')) return; await api('POST', `/bookings/${d.id}/cancel`); toast('Booking cancelled'); await refresh(); return;
      case 'rate': await api('POST', `/bookings/${d.id}/rate`, { rating: Number(d.n) }); toast('Thanks for rating'); await refresh(); return;
      /* salon */
      case 'sTab': V.stab = d.v; await refresh(); return;
      case 'sDate': V.sdate = d.v; await refresh(); return;
      case 'bkSet': await api('PATCH', `/bookings/${d.id}/status`, { status: d.s }); await refresh(); return;
      case 'regSave': {
        const r = await api('POST', '/salons', { name: fd.get('name'), area: fd.get('area'), address: fd.get('address'), type: fd.get('type'), openMin: Number(fd.get('openMin')), closeMin: Number(fd.get('closeMin')), staffCount: Number(fd.get('staffCount')), branchOf: V.modal ? V.sid : undefined });
        if (A.user.role === 'customer') A.user.role = 'owner'; V.sid = r.salon.id; V.stab = 'team'; V.modal = null; V.tab = 'salon'; toast('Salon created', 'Add your team, prices and payment details, then submit for approval.'); await refresh(true); return; }
      case 'branchAdd': V.modal = { type: 'branch' }; renderModal(); return;
      case 'walkinAdd': {
        const items = fd.getAll('it').map(p => { const [t, id] = p.split(':'); return { t, id }; });
        if (!items.length) { toast('Pick at least one service'); break; }
        const r = await api('POST', `/salons/${V.sid}/walkin`, { items, staffId: fd.get('staff'), name: fd.get('name') });
        toast('Token #' + r.booking.token + ' added', 'Starts in about ' + r.waitMin + ' min'); V.stab = 'today'; V.sdate = TODAY; await refresh(); return; }
      case 'staffAdd': V.modal = { type: 'staff', id: null, draft: sd(null) }; renderModal(); return;
      case 'staffEdit': V.modal = { type: 'staff', id: d.id, draft: sd(V.manage.staff.find(x => x.id === d.id)) }; renderModal(); return;
      case 'leaveAdd': { syncStaff(); const v = $('#leaveDate').value; if (v && !V.modal.draft.leave.includes(v)) V.modal.draft.leave.push(v); renderModal(); return; }
      case 'leaveDel': syncStaff(); V.modal.draft.leave = V.modal.draft.leave.filter(x => x !== d.v); renderModal(); return;
      case 'staffSave': {
        syncStaff(); const dr = V.modal.draft; if (!Object.keys(dr.svc).length) { toast('Pick at least one service'); return; }
        const body = { name: dr.name, spec: dr.spec, photo: dr.photo || null, leave: dr.leave, services: Object.entries(dr.svc).map(([serviceId, durMin]) => ({ serviceId, durMin })) };
        if (V.modal.id) await api('PUT', '/staff/' + V.modal.id, body); else await api('POST', `/salons/${V.sid}/staff`, body);
        V.modal = null; renderModal(); toast('Team updated'); await refresh(); return; }
      case 'staffDel': if (!confirm('Remove this team member? Past bookings are kept.')) return; await api('DELETE', '/staff/' + d.id); await refresh(); return;
      case 'svcAdd': V.modal = { type: 'svc', id: null }; renderModal(); return;
      case 'svcEdit': V.modal = { type: 'svc', id: d.id }; renderModal(); return;
      case 'svcSave': { const b = { name: fd.get('name'), price: Number(fd.get('price')), durMin: Number(fd.get('durMin')) }; if (V.modal.id) await api('PUT', '/services/' + V.modal.id, b); else await api('POST', `/salons/${V.sid}/services`, b); V.modal = null; renderModal(); await refresh(); return; }
      case 'svcDel': if (!confirm('Remove this service? Combos that include it are removed too.')) return; await api('DELETE', '/services/' + d.id); await refresh(); return;
      case 'comboAdd': V.modal = { type: 'combo' }; renderModal(); return;
      case 'comboSave': { const b = { name: fd.get('name'), price: Number(fd.get('price')), serviceIds: fd.getAll('cs') }; if (fd.get('durMin')) b.durMin = Number(fd.get('durMin'));
        if (V.modal.id) { b.active = !!fd.get('active'); await api('PUT', '/combos/' + V.modal.id, b); } else await api('POST', `/salons/${V.sid}/combos`, b);
        V.modal = null; renderModal(); toast('Combo saved'); await refresh(); return; }
      case 'comboEdit': V.modal = { type: 'combo', id: d.id }; renderModal(); return;
      case 'comboToggle': { const c = V.manage.combos.find(x => x.id === d.id); await api('PUT', '/combos/' + d.id, { active: !c.active }); await refresh(); return; }
      case 'svcInline': await api('PUT', '/services/' + d.id, { name: fd.get('name'), price: Number(fd.get('price')), durMin: Number(fd.get('durMin')) }); toast('Saved'); await refresh(); return;
      case 'billSave': await api('PUT', `/salons/${V.sid}/billing-details`, { name: fd.get('name'), email: fd.get('email'), gstin: fd.get('gstin'), agree: !!fd.get('agree') }); toast('Payment details saved'); await refresh(); return;
      case 'submitSalon': await api('POST', `/salons/${V.sid}/submit`); toast('Submitted', 'Super Admin will review your salon.'); await refresh(true); return;
      case 'comboDel': await api('DELETE', '/combos/' + d.id); await refresh(); return;
      case 'shopSave': { const oc = String(fd.get('ocode')).trim(), op = Number(fd.get('opct'));
        await api('PATCH', '/salons/' + V.sid, { name: fd.get('name'), area: fd.get('area'), address: fd.get('address'), type: fd.get('type'), openMin: Number(fd.get('openMin')), closeMin: Number(fd.get('closeMin')), offDays: fd.getAll('off').map(Number), offer: oc && op > 0 ? { code: oc, pct: op } : null });
        toast('Details saved'); await refresh(); return; }
      case 'holAdd': { const v = $('#hol').value; if (!v) break; await api('PATCH', '/salons/' + V.sid, { holidays: [...new Set([...V.manage.salon.holidays, v])] }); await refresh(); return; }
      case 'holDel': await api('PATCH', '/salons/' + V.sid, { holidays: V.manage.salon.holidays.filter(x => x !== d.v) }); await refresh(); return;
      case 'pay': {
        const r = await api('POST', `/salons/${V.sid}/billing/checkout`);
        if (r.dev) { toast('Payment recorded (test mode)'); V.stab = 'billing'; await refresh(); return; }
        await new Promise((ok, no) => { if (window.Razorpay) return ok(); const s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js'; s.onload = ok; s.onerror = () => no(new Error('Could not load the payment window')); document.head.appendChild(s); });
        new window.Razorpay({ key: r.keyId, order_id: r.orderId, amount: r.amount * 100, currency: 'INR', name: 'Just Trim', description: 'Monthly subscription', handler: () => { toast('Payment received', 'Your plan updates in a few seconds.'); setTimeout(() => refresh(), 3000); } }).open(); return; }
      /* admin */
      case 'aTab': V.atab = d.v; await refresh(); return;
      case 'aAct': await api('POST', `/admin/salons/${d.id}/${d.v}`); toast('Done'); await refresh(); return;
      case 'cfgSave': { const b = {}; for (const [k, v] of fd.entries()) b[k] = Number(v); V.settings = await api('PUT', '/admin/settings', b); toast('Settings saved'); break; }
      case 'resetPw': await api('POST', '/admin/users/reset-password', { email: fd.get('email'), password: fd.get('password') }); V.modal = null; renderModal(); toast('Password reset'); break;
      case 'userReset': V.modal = { type: 'reset', email: d.email }; renderModal(); return;
      case 'uSearch': V.uq = String(fd.get('q') || '').trim(); await refresh(); return;
      case 'aPrice': { const v = String(fd.get('price')).trim(); await api('POST', `/admin/salons/${d.id}/price`, { price: v === '' ? null : Number(v) }); toast('Price saved'); await refresh(); return; }
      case 'qNew': await api('POST', '/queries', { salonId: fd.get('salonId') || undefined, subject: fd.get('subject'), body: fd.get('body') }); toast('Sent to Super Admin'); await refresh(); return;
      case 'qReply': await api('POST', `/queries/${d.id}/messages`, { body: fd.get('body') }); await refresh(); return;
      case 'qStatus': await api('POST', `/admin/queries/${d.id}/status`, { status: d.v }); await refresh(); return;
      case 'tkSet': await api('POST', `/admin/tickets/${d.id}/resolve`, { status: d.v }); await refresh(); return;
    }
  } catch (e) { handleErr(e); }
  render();
}
async function change(name, el) {
  try {
    if (name === 'sPick') { V.sid = el.value; V.stab = 'today'; await loadTab(); }
    else if (name === 'adv') V.adv = el.checked; else if (name === 'pts') V.pts = el.checked;
    else if (name === 'photo') {
      const f = el.files && el.files[0]; if (!f) return; syncStaff();
      const rd = new FileReader(); rd.onload = () => { const im = new Image(); im.onload = () => { const cv = document.createElement('canvas'); cv.width = cv.height = 160; const s = Math.min(im.width, im.height); cv.getContext('2d').drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, 0, 0, 160, 160); V.modal.draft.photo = cv.toDataURL('image/jpeg', .8); renderModal(); }; im.src = rd.result; };
      rd.readAsDataURL(f); return;
    }
  } catch (e) { handleErr(e); }
  render();
}
document.addEventListener('click', e => {
  if (e.target.classList && e.target.classList.contains('ov')) { V.modal = null; renderModal(); return; }
  const el = e.target.closest('[data-a]'); if (!el || el.tagName === 'SELECT') return; act(el.dataset.a, el.dataset, el);
});
document.addEventListener('change', e => { const el = e.target.closest('[data-ch]'); if (el) change(el.dataset.ch, el); });
document.addEventListener('input', e => { const el = e.target.closest('[data-in]'); if (el && el.dataset.in === 'q') { V.q = el.value; $('#shoplist').innerHTML = listHtml(); } });
document.addEventListener('submit', e => { const f = e.target.closest('[data-submit]'); if (f) { e.preventDefault(); act(f.dataset.submit, f.dataset, f, new FormData(f)); } });

/* ---------- start ---------- */
(async () => {
  if (A.token) { try { A.user = await api('GET', '/me'); startSession({ token: A.token, user: A.user }); await loadTab(); } catch { A.token = ''; A.user = null; localStorage.removeItem('jt_token'); } }
  render();
})();
})();
