(function () {
    'use strict';

    const LOGIN_URL = 'login.html';
    const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const BANKS = ['ABSA', 'African Bank', 'Capitec', 'Discovery Bank', 'FNB', 'Investec', 'Nedbank', 'Standard Bank', 'TymeBank'];
    const ACCOUNT_TYPES = ['Cheque / Current', 'Savings', 'Transmission'];
    const PAY = {
        card: ['Paid by card', 'ok'],
        eft_pending: ['Awaiting EFT', 'warn'],
        eft_sent: ['EFT sent, awaiting confirmation', 'info'],
        paid: ['Paid', 'ok']
    };
    // Tabs that hold no half-filled forms, so they can refresh themselves in the background.
    const AUTO_REFRESH_TABS = { driver: ['overview', 'rides'], student: ['find', 'bookings'] };

    /* ---------- data from the server ---------- */
    let DB = { me: null, users: {}, vehicles: {}, rides: [], bookings: [], cards: {}, timetables: {}, notifs: [] };
    let me = null;
    const users = () => DB.users;
    const vehicles = () => DB.vehicles;
    const rides = () => DB.rides;
    const bookings = () => DB.bookings;
    const cards = () => DB.cards;
    const timetables = () => DB.timetables;

    async function api(method, url, body) {
        try {
            const res = await fetch(url, {
                method: method,
                headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
                body: body !== undefined ? JSON.stringify(body) : undefined,
                credentials: 'same-origin'
            });
            if (res.status === 401) { location.replace(LOGIN_URL); return { ok: false, status: 401, data: {}, error: 'Please log in again.' }; }
            const data = await res.json().catch(() => ({}));
            return { ok: res.ok, status: res.status, data: data, error: data.error };
        } catch (e) {
            return { ok: false, status: 0, data: {}, error: 'Cannot reach the server. Check your connection and try again.' };
        }
    }

    async function refresh() {
        const res = await api('GET', '/api/state');
        if (res.ok) { DB = res.data; me = DB.me; }
        return res.ok;
    }

    /* ---------- helpers ---------- */
    const $ = (s, r) => (r || document).querySelector(s);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const pad = (n) => String(n).padStart(2, '0');
    const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
    const parseDate = (s) => { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
    const rideStart = (r) => { const t = r.time.split(':').map(Number); const d = parseDate(r.date); d.setHours(t[0], t[1], 0, 0); return d; };
    const fmtDate = (s) => parseDate(s).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
    const dayKey = (s) => DAY_NAMES[parseDate(s).getDay()];
    const money = (n) => 'R' + Number(n).toFixed(2).replace(/\.00$/, '');
    const firstName = (n) => String(n).split(' ')[0];
    const opts = (list, sel) => list.map((o) => '<option' + (o === sel ? ' selected' : '') + '>' + esc(o) + '</option>').join('');
    const activeBookings = (rideId) => bookings().filter((b) => b.rideId === rideId && !b.cancelled);
    const pill = (s) => { const p = PAY[s] || [s, 'info']; return '<span class="pill ' + p[1] + '">' + p[0] + '</span>'; };
    const userName = (email) => (users()[email] || {}).name || email;
    const timeAgo = (t) => new Date(t).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const seatsLeft = (r) => r.seats - (r.booked || 0);

    let toastTimer;
    function toast(text) {
        const el = $('#toast');
        el.textContent = text; el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
    }

    function setMsg(form, text, type) {
        const el = $('.msg', form);
        if (!el) return;
        el.textContent = text || '';
        el.className = 'msg' + (type ? ' ' + type : '');
    }
    function lock(form, on) { const b = $('button[type="submit"]', form); if (b) b.disabled = on; }

    /* ---------- state ---------- */
    const state = { tab: null, filter: { from: '', to: '', date: '' } };
    const app = $('#app');

    function tabsNav(list) {
        return '<nav class="tabs" aria-label="Dashboard sections">' + list.map((t) =>
            '<button class="tab" data-action="tab" data-tab="' + t[0] + '"' + (state.tab === t[0] ? ' aria-current="page"' : '') + '>' + t[1] + '</button>'
        ).join('') + '</nav>';
    }

    function render() {
        $('#who-name').textContent = me.name;
        $('#who-role').textContent = me.role === 'driver' ? 'Driver' : 'Passenger';
        renderBell();
        if (me.role === 'driver') renderDriver(); else renderPassenger();
        if (state.tab === 'map' && $('#map')) startMap(); else stopMap();
    }

    /* ---------- notifications ---------- */
    function renderBell() {
        const list = DB.notifs || [];
        const unread = list.filter((n) => !n.read).length;
        const badge = $('#bell-count');
        badge.textContent = unread; badge.hidden = unread === 0;
        $('#notif-panel').innerHTML = '<header>Notifications</header>' + (list.length
            ? list.map((n) => '<div class="notif' + (n.read ? '' : ' unread') + '">' + esc(n.text) + '<time>' + timeAgo(n.at) + '</time></div>').join('')
            : '<p class="notif-empty">Nothing yet. Booking updates and timetable changes will show up here.</p>');
    }

    const bellOpen = () => !$('#notif-panel').hidden;

    function openBell() {
        $('#notif-panel').hidden = false;
        $('#bell').setAttribute('aria-expanded', 'true');
        $('#bell-count').hidden = true;
        api('POST', '/api/notifications/read', {}); // the highlight stays visible until the panel closes
    }
    function closeBell() {
        $('#notif-panel').hidden = true;
        $('#bell').setAttribute('aria-expanded', 'false');
        (DB.notifs || []).forEach((n) => { n.read = true; });
        renderBell();
    }

    /* ---------- shared UI pieces ---------- */
    function vehicleFormHtml(v, isNew) {
        const b = v.bank || {};
        return '<form data-form="vehicle" data-new="' + (isNew ? 1 : 0) + '" novalidate>' +
            '<h2>Your vehicle</h2>' +
            '<div class="row2">' +
            '<div class="field"><label class="lbl" for="v-make">Make</label><input id="v-make" name="make" type="text" placeholder="Toyota" value="' + esc(v.make) + '"></div>' +
            '<div class="field"><label class="lbl" for="v-model">Model</label><input id="v-model" name="model" type="text" placeholder="Corolla" value="' + esc(v.model) + '"></div>' +
            '</div>' +
            '<div class="row3">' +
            '<div class="field"><label class="lbl" for="v-year">Year</label><input id="v-year" name="year" type="number" inputmode="numeric" placeholder="2018" value="' + esc(v.year) + '"></div>' +
            '<div class="field"><label class="lbl" for="v-colour">Colour</label><input id="v-colour" name="colour" type="text" placeholder="Silver" value="' + esc(v.colour) + '"></div>' +
            '<div class="field"><label class="lbl" for="v-plate">Number plate</label><input id="v-plate" name="plate" type="text" placeholder="ND 123-456" value="' + esc(v.plate) + '" autocapitalize="characters"></div>' +
            '</div>' +
            '<div class="field"><label class="lbl" for="v-seats">Passenger seats available</label>' +
            '<input id="v-seats" name="seats" type="number" min="1" max="6" inputmode="numeric" placeholder="3" value="' + esc(v.seats) + '">' +
            '<p class="hint">Not counting your own seat. Between 1 and 6.</p></div>' +
            '<h2 class="section-title">Where passengers pay you by EFT</h2>' +
            '<div class="row2">' +
            '<div class="field"><label class="lbl" for="b-bank">Bank</label><select id="b-bank" name="bank"><option value="">Choose your bank</option>' + opts(BANKS, b.bank) + '</select></div>' +
            '<div class="field"><label class="lbl" for="b-type">Account type</label><select id="b-type" name="type">' + opts(ACCOUNT_TYPES, b.type) + '</select></div>' +
            '</div>' +
            '<div class="field"><label class="lbl" for="b-holder">Account holder</label><input id="b-holder" name="holder" type="text" placeholder="Name on the account" value="' + esc(b.holder || (isNew ? me.name : '')) + '"></div>' +
            '<div class="row2">' +
            '<div class="field"><label class="lbl" for="b-number">Account number</label><input id="b-number" name="number" type="text" inputmode="numeric" placeholder="1234567890" value="' + esc(b.number) + '" autocomplete="off"></div>' +
            '<div class="field"><label class="lbl" for="b-branch">Branch code</label><input id="b-branch" name="branch" type="text" inputmode="numeric" placeholder="6 digits" value="' + esc(b.branch) + '" autocomplete="off"></div>' +
            '</div>' +
            '<p class="hint" style="margin-bottom:1rem">Passengers see these details only when they choose to pay by EFT.</p>' +
            (isNew ? '<label class="check"><input type="checkbox" name="confirm"> <span>I confirm this is my vehicle, I hold a valid driver\'s licence, and I agree to the campus safety guidelines.</span></label>' : '') +
            '<p class="msg" role="alert" aria-live="polite"></p>' +
            '<button class="btn gold" type="submit">' + (isNew ? 'Register vehicle' : 'Save changes') + '</button>' +
            '</form>';
    }

    function openModal(html) {
        $('#modal-content').innerHTML = html;
        const dlg = $('#modal');
        if (!dlg.open) dlg.showModal();
    }
    function closeModal() { const dlg = $('#modal'); if (dlg.open) dlg.close(); }

    function openFile(email) {
        window.open('/api/timetable/file/' + encodeURIComponent(email), '_blank', 'noopener');
    }

    /* =================================================================
       DRIVER
    ================================================================== */
    function renderDriver() {
        const v = vehicles()[me.email];

        // Step 1: a driver must register a vehicle before anything else.
        if (!v) {
            app.innerHTML =
                '<section class="narrow">' +
                '<h1>Register your vehicle</h1>' +
                '<p class="sub">Drivers register once, before publishing rides. Passengers who book with you see your car\'s make, colour and number plate so they can spot you on campus.</p>' +
                '<div class="card">' + vehicleFormHtml({}, true) + '</div>' +
                '</section>';
            return;
        }

        const tabs = [['overview', 'Overview'], ['publish', 'Publish a ride'], ['rides', 'My rides'], ['map', 'Rider map'], ['vehicle', 'Vehicle & payouts']];
        let body = '';
        if (state.tab === 'publish') body = driverPublish(v);
        else if (state.tab === 'rides') body = driverRides();
        else if (state.tab === 'map') body = driverMapHtml();
        else if (state.tab === 'vehicle') body = driverVehicle(v);
        else body = driverOverview(v);
        app.innerHTML = tabsNav(tabs) + body;
    }

    function myRides() { return rides().filter((r) => r.driver === me.email); }

    function driverOverview(v) {
        const t = todayStr();
        const mine = myRides();
        const upcoming = mine.filter((r) => r.date >= t);
        let seatsBooked = 0, expected = 0, awaiting = 0;
        upcoming.forEach((r) => {
            activeBookings(r.id).forEach((b) => {
                seatsBooked++; expected += Number(b.price);
                if (b.status === 'eft_pending' || b.status === 'eft_sent') awaiting++;
            });
        });
        const today = upcoming.filter((r) => r.date === t).sort((a, b) => a.time.localeCompare(b.time));
        const next = upcoming.filter((r) => r.date > t).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).slice(0, 3);

        return '<div class="greeting"><h1>Hi ' + esc(firstName(me.name)) + '</h1><p class="sub" style="margin-bottom:0">Here is what is happening on your rides.</p></div>' +
            '<div class="card vehicle-strip"><div><h3>' + esc(v.colour + ' ' + v.make + ' ' + v.model) + '</h3><p class="meta">' + esc(v.year) + ' &middot; ' + esc(v.seats) + ' passenger seats</p></div>' +
            '<span class="plate">' + esc(v.plate) + '</span></div>' +
            '<div class="stats">' +
            '<div class="stat"><b>' + upcoming.length + '</b><span>Upcoming rides</span></div>' +
            '<div class="stat"><b>' + seatsBooked + '</b><span>Seats booked</span></div>' +
            '<div class="stat"><b>' + money(expected) + '</b><span>Expected earnings</span></div>' +
            '<div class="stat"><b>' + awaiting + '</b><span>Payments to confirm</span></div>' +
            '</div>' +
            '<h2 class="section-title" style="margin-top:0">Today</h2>' +
            (today.length ? today.map(driverRideCard).join('') :
                '<div class="empty">No rides today.<br><button class="btn-sm" data-action="tab" data-tab="publish">Publish a ride</button></div>') +
            (next.length ? '<h2 class="section-title">Coming up</h2>' + next.map(driverRideCard).join('') : '');
    }

    function driverRideCard(r) {
        const bs = activeBookings(r.id);
        const past = r.date < todayStr();
        const day = dayKey(r.date);
        const weekend = DAYS.indexOf(day) === -1;
        const ends = [];
        let missing = 0;

        const rows = bs.map((b) => {
            const u = users()[b.passenger] || {};
            const t = timetables()[b.passenger];
            const slot = t && t.days && t.days[day];
            const has = slot && (slot.start || slot.end);
            if (slot && slot.end) ends.push(slot.end);
            if (!has && !weekend) missing++;
            const eftOpen = b.status === 'eft_pending' || b.status === 'eft_sent';
            return '<div class="pax">' +
                '<div><strong>' + esc(u.name || b.passenger) + '</strong>' +
                '<small>' + esc(b.phone || u.phone || '') + (b.address ? ' &middot; Pickup: ' + esc(b.address) : '') + '</small>' +
                '<small>' + (has ? esc(day) + ' classes: ' + esc(slot.start || '?') + ' to ' + esc(slot.end || '?') : (weekend ? 'Weekend ride, no class times' : 'No timetable shared for ' + esc(day))) + '</small></div>' +
                '<div class="pax-actions">' + pill(b.status) +
                (t && t.file ? '<button class="btn-sm" data-action="open-tt" data-email="' + esc(b.passenger) + '">View timetable</button>' : '') +
                (eftOpen ? '<button class="btn-sm" data-action="confirm-pay" data-id="' + esc(b.id) + '">Confirm EFT received</button>' : '') +
                '</div></div>';
        }).join('');

        const latest = ends.length ? ends.slice().sort().pop() : '';
        let ret = '';
        if (bs.length && !past) {
            ret = '<div class="return-box">' +
                '<p>' + (latest ? '<strong>Everyone is finished by ' + esc(latest) + '.</strong> ' : (weekend ? '<strong>Weekend ride.</strong> ' : '<strong>No finish times shared yet.</strong> ')) +
                (missing && latest ? missing + ' passenger' + (missing > 1 ? 's have' : ' has') + ' not shared ' + esc(day) + ' times. ' : '') +
                'Pick a time for the afternoon trip home and passengers will be notified.</p>' +
                '<form class="return-form" data-form="return" data-id="' + esc(r.id) + '">' +
                '<div class="field"><label class="lbl" for="ret-' + esc(r.id) + '">Afternoon pick-up</label><input id="ret-' + esc(r.id) + '" type="time" name="time" value="' + esc(r.returnTime || latest) + '"></div>' +
                '<button class="btn-sm" type="submit">Send to passengers</button>' +
                '</form>' +
                (r.returnTime ? '<p class="hint">Sent: pick-up at ' + esc(r.returnTime) + '.</p>' : '') +
                '</div>';
        }

        return '<article class="card">' +
            '<div class="ride-head"><div>' +
            '<h3>' + esc(r.from) + '<span class="arrow">&rarr;</span>' + esc(r.to) + '</h3>' +
            '<p class="meta">' + esc(fmtDate(r.date)) + ' at ' + esc(r.time) + ' &middot; ' + bs.length + ' of ' + esc(r.seats) + ' seats booked' +
            (r.date === todayStr() ? ' &nbsp;<span class="pill warn">Today</span>' : '') + (past ? ' &nbsp;<span class="pill grey">Past</span>' : '') + '</p>' +
            (r.notes ? '<p class="meta">' + esc(r.notes) + '</p>' : '') +
            '</div><div class="price">' + money(r.price) + '<small>per seat</small></div></div>' +
            (bs.length ? '<div class="pax-list">' + rows + '</div>' + ret : '<p class="meta" style="margin-top:0.8rem">No passengers yet.</p>') +
            (!bs.length ? '<div style="margin-top:0.8rem"><button class="btn-sm danger" data-action="delete-ride" data-id="' + esc(r.id) + '">Remove ride</button></div>' : '') +
            '</article>';
    }

    function driverPublish(v) {
        return '<div class="narrow" style="margin:0"><div class="card">' +
            '<h2>Publish a ride</h2>' +
            '<p class="sub">Already driving to campus? Fill your empty seats and get paid for a trip you were making anyway.</p>' +
            '<form data-form="publish" novalidate>' +
            '<div class="row2">' +
            '<div class="field"><label class="lbl" for="p-from">From</label><input id="p-from" name="from" type="text" list="places" placeholder="Where you leave from"></div>' +
            '<div class="field"><label class="lbl" for="p-to">To</label><input id="p-to" name="to" type="text" list="places" placeholder="Campus or landmark"></div>' +
            '</div>' +
            '<div class="row2">' +
            '<div class="field"><label class="lbl" for="p-date">Date</label><input id="p-date" name="date" type="date" min="' + todayStr() + '"></div>' +
            '<div class="field"><label class="lbl" for="p-time">Departure time</label><input id="p-time" name="time" type="time"></div>' +
            '</div>' +
            '<div class="row2">' +
            '<div class="field"><label class="lbl" for="p-seats">Seats on offer</label><input id="p-seats" name="seats" type="number" min="1" max="' + esc(v.seats) + '" value="' + esc(v.seats) + '" inputmode="numeric"><p class="hint">Your car has ' + esc(v.seats) + '.</p></div>' +
            '<div class="field"><label class="lbl" for="p-price">Price per seat (Rand)</label><input id="p-price" name="price" type="number" min="1" step="1" inputmode="numeric" placeholder="25"></div>' +
            '</div>' +
            '<div class="field"><label class="lbl" for="p-notes">Notes (optional)</label><input id="p-notes" name="notes" type="text" placeholder="Pick-up spot, luggage space, music…" maxlength="120"></div>' +
            '<p class="hint" style="margin-bottom:1rem">Each ride is a trip to campus. You will set the afternoon pick-up time once passengers share their timetables.</p>' +
            '<p class="msg" role="alert" aria-live="polite"></p>' +
            '<button class="btn gold" type="submit">Publish ride</button>' +
            '</form></div></div>';
    }

    function driverRides() {
        const t = todayStr();
        const mine = myRides();
        const up = mine.filter((r) => r.date >= t).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
        const past = mine.filter((r) => r.date < t).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
        return '<h2>Upcoming rides</h2>' +
            (up.length ? up.map(driverRideCard).join('') : '<div class="empty">You have no upcoming rides.<br><button class="btn-sm" data-action="tab" data-tab="publish">Publish a ride</button></div>') +
            (past.length ? '<h2 class="section-title">Past rides</h2>' + past.map(driverRideCard).join('') : '');
    }

    function driverVehicle(v) {
        return '<div class="narrow" style="margin:0"><div class="card">' +
            '<div class="vehicle-strip" style="margin-bottom:1rem"><h2 style="margin:0">Vehicle &amp; payouts</h2><span class="plate">' + esc(v.plate) + '</span></div>' +
            vehicleFormHtml(v, false) + '</div></div>';
    }

    /* =================================================================
       PASSENGER
    ================================================================== */
    function renderPassenger() {
        const tabs = [['find', 'Find a ride'], ['map', 'Driver map'], ['bookings', 'My bookings'], ['timetable', 'My timetable'], ['payment', 'Payment']];
        let body = '';
        if (state.tab === 'map') body = studentMapHtml();
        else if (state.tab === 'bookings') body = passengerBookings();
        else if (state.tab === 'timetable') body = passengerTimetable();
        else if (state.tab === 'payment') body = passengerPayment();
        else body = passengerFind();
        app.innerHTML = tabsNav(tabs) + body;
    }

    function passengerFind() {
        const hasTT = !!timetables()[me.email];
        return '<div class="greeting"><h1>Hi ' + esc(firstName(me.name)) + ', where to?</h1><p class="sub" style="margin-bottom:0">Book a seat with a verified DUT driver heading your way.</p></div>' +
            offersHtml() +
            (hasTT ? '' : '<div class="card" style="border-left:4px solid var(--gold)"><strong>Upload your timetable</strong><p class="meta">Drivers use it to plan the trip home so you travel back together. <button class="btn-sm" data-action="tab" data-tab="timetable">Add timetable</button></p></div>') +
            '<div class="card"><div class="filters">' +
            '<div class="field" style="margin:0"><label class="lbl" for="f-from">From</label><input id="f-from" name="from" type="text" list="places" data-filter placeholder="Anywhere" value="' + esc(state.filter.from) + '"></div>' +
            '<div class="field" style="margin:0"><label class="lbl" for="f-to">To</label><input id="f-to" name="to" type="text" list="places" data-filter placeholder="Anywhere" value="' + esc(state.filter.to) + '"></div>' +
            '<div class="field" style="margin:0"><label class="lbl" for="f-date">Date</label><input id="f-date" name="date" type="date" data-filter min="' + todayStr() + '" value="' + esc(state.filter.date) + '"></div>' +
            '</div></div>' +
            '<div id="ride-list">' + rideListHtml() + '</div>';
    }

    function rideListHtml() {
        const f = state.filter;
        const now = new Date();
        const list = rides().filter((r) => {
            if (rideStart(r) <= now) return false;
            if (f.from && r.from.toLowerCase().indexOf(f.from.trim().toLowerCase()) === -1) return false;
            if (f.to && r.to.toLowerCase().indexOf(f.to.trim().toLowerCase()) === -1) return false;
            if (f.date && r.date !== f.date) return false;
            return true;
        }).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

        if (!list.length) return '<div class="empty">No rides match yet. Try a different route or date, or check back soon.</div>';

        return list.map((r) => {
            const v = vehicles()[r.driver];
            const left = seatsLeft(r);
            const mine = bookings().find((b) => b.rideId === r.id && b.passenger === me.email && !b.cancelled);
            let action;
            if (mine) action = '<span class="pill ok">Booked</span>';
            else if (left <= 0) action = '<span class="pill grey">Full</span>';
            else action = '<button class="btn gold" data-action="book-open" data-id="' + esc(r.id) + '">Book a seat</button>';
            return '<article class="card"><div class="ride-head"><div>' +
                '<h3>' + esc(r.from) + '<span class="arrow">&rarr;</span>' + esc(r.to) + '</h3>' +
                '<p class="meta">' + esc(fmtDate(r.date)) + ' at ' + esc(r.time) + ' &middot; ' + left + ' seat' + (left === 1 ? '' : 's') + ' left</p>' +
                '<p class="meta">Driver: ' + esc(userName(r.driver)) + (v ? ' &middot; ' + esc(v.colour + ' ' + v.make + ' ' + v.model) + ' &middot; ' + esc(v.plate) : '') + '</p>' +
                (r.notes ? '<p class="meta">' + esc(r.notes) + '</p>' : '') +
                '</div><div class="price">' + money(r.price) + '<small>per seat</small><div style="margin-top:0.6rem">' + action + '</div></div></div></article>';
        }).join('');
    }

    function bookModal(r) {
        const c = cards()[me.email];
        const cardOk = c && c.auto;
        const hasTT = !!timetables()[me.email];
        const v = vehicles()[r.driver];
        return '<h2>Book your seat</h2>' +
            '<p><strong>' + esc(r.from) + ' &rarr; ' + esc(r.to) + '</strong></p>' +
            '<p class="meta">' + esc(fmtDate(r.date)) + ' at ' + esc(r.time) + ' with ' + esc(userName(r.driver)) + '</p>' +
            '<p class="meta" style="margin-bottom:1rem">' + esc(money(r.price)) + ' per seat' + (v ? ' &middot; ' + esc(v.colour + ' ' + v.make) : '') + '</p>' +
            '<form data-form="book" data-id="' + esc(r.id) + '">' +
            '<p class="lbl">How would you like to pay?</p>' +
            '<label class="method-opt' + (cardOk ? '' : ' disabled') + '"><input type="radio" name="method" value="card"' + (cardOk ? ' checked' : ' disabled') + '>' +
            '<div><strong>Card, paid automatically</strong><span>' + (cardOk ? esc(c.brand) + ' ending ' + esc(c.last4) + '. Charged when you book.' : (c ? 'Automatic payment is switched off.' : 'No card saved yet.') + ' <a href="#" data-action="go-payment">Set up a card</a>') + '</span></div></label>' +
            '<label class="method-opt"><input type="radio" name="method" value="eft"' + (cardOk ? '' : ' checked') + '>' +
            '<div><strong>EFT</strong><span>You will see the driver\'s account number and a payment reference.</span></div></label>' +
            '<h2 class="section-title">Where should the driver pick you up?</h2>' +
            '<div class="field"><label class="lbl" for="bk-phone">Cellphone number</label>' +
            '<input id="bk-phone" name="phone" type="tel" inputmode="tel" placeholder="082 000 0000" value="' + esc(me.phone || '') + '"></div>' +
            '<div class="field"><label class="lbl" for="bk-address">Pickup address</label>' +
            '<textarea id="bk-address" name="address" placeholder="Street, suburb, and a landmark if it helps"></textarea></div>' +
            (hasTT ? '' : '<p class="hint" style="margin:0.6rem 0">You have not uploaded a timetable yet. Add one so your driver can plan the trip home.</p>') +
            '<p class="msg" role="alert" aria-live="polite"></p>' +
            '<button class="btn gold block" type="submit">Confirm booking &amp; pay</button>' +
            '</form>';
    }

    function eftModal(b) {
        const r = rides().find((x) => x.id === b.rideId) || {};
        const v = vehicles()[b.driver];
        const bank = (v && v.bank) || {};
        const ref = 'UL' + b.id.slice(0, 6).toUpperCase();
        return '<h2>Pay by EFT</h2>' +
            '<p class="meta">Pay ' + esc(userName(b.driver)) + ' ' + esc(money(b.price)) + ' for ' + esc(r.from || '') + ' &rarr; ' + esc(r.to || '') + '.</p>' +
            '<dl class="bank">' +
            '<dt>Account holder</dt><dd>' + esc(bank.holder) + '</dd>' +
            '<dt>Bank</dt><dd>' + esc(bank.bank) + '</dd>' +
            '<dt>Account number</dt><dd>' + esc(bank.number) + '</dd>' +
            '<dt>Branch code</dt><dd>' + esc(bank.branch) + '</dd>' +
            '<dt>Account type</dt><dd>' + esc(bank.type) + '</dd>' +
            '<dt>Amount</dt><dd>' + esc(money(b.price)) + '</dd>' +
            '<dt>Reference</dt><dd>' + esc(ref) + '</dd>' +
            '</dl>' +
            '<p class="hint" style="margin-bottom:1rem">Use the reference so the driver can match your payment. Tap the button below once you have paid.</p>' +
            (b.status === 'eft_pending'
                ? '<button class="btn gold block" data-action="eft-sent" data-id="' + esc(b.id) + '">I\'ve made the EFT</button>'
                : '<p>' + pill(b.status) + '</p>');
    }

    function passengerBookings() {
        const list = bookings().filter((b) => b.passenger === me.email && !b.cancelled).map((b) => ({ b: b, r: rides().find((x) => x.id === b.rideId) })).filter((x) => x.r);
        const t = todayStr();
        list.sort((x, y) => (x.r.date + x.r.time).localeCompare(y.r.date + y.r.time));
        if (!list.length) return '<div class="empty">You have not booked a ride yet.<br><button class="btn-sm" data-action="tab" data-tab="find">Find a ride</button></div>';

        return '<h2>My bookings</h2>' + list.map((x) => {
            const b = x.b, r = x.r, v = vehicles()[r.driver], past = r.date < t;
            const eft = b.method === 'eft';
            return '<article class="card"><div class="ride-head"><div>' +
                '<h3>' + esc(r.from) + '<span class="arrow">&rarr;</span>' + esc(r.to) + '</h3>' +
                '<p class="meta">' + esc(fmtDate(r.date)) + ' at ' + esc(r.time) + (past ? ' &nbsp;<span class="pill grey">Past</span>' : '') + '</p>' +
                '<p class="meta">Driver: ' + esc(userName(r.driver)) + (v ? ' &middot; ' + esc(v.colour + ' ' + v.make + ' ' + v.model) + ' &middot; ' + esc(v.plate) : '') + '</p>' +
                '<p class="meta">' + (r.returnTime ? '<strong>Afternoon pick-up: ' + esc(r.returnTime) + '</strong>' : 'Afternoon pick-up time not set yet. Your driver will confirm it once timetables are in.') + '</p>' +
                (b.address ? '<p class="meta">Morning pickup: ' + esc(b.address) + ' &middot; ' + esc(b.phone) + '</p>' : '') +
                '</div><div class="price">' + money(b.price) + '<small>' + (eft ? 'EFT' : 'Card') + '</small><div style="margin-top:0.5rem">' + pill(b.status) + '</div></div></div>' +
                (past ? '' : '<div class="pax-actions" style="margin-top:0.9rem">' +
                    (eft && b.status !== 'paid' ? '<button class="btn-sm" data-action="eft-show" data-id="' + esc(b.id) + '">View EFT details</button>' : '') +
                    '<button class="btn-sm danger" data-action="cancel-booking" data-id="' + esc(b.id) + '">Cancel booking</button></div>') +
                '</article>';
        }).join('');
    }

    function passengerTimetable() {
        const t = timetables()[me.email] || { days: {}, file: null };
        const rowsHtml = DAYS.map((d) => {
            const s = (t.days && t.days[d]) || {};
            return '<span class="day">' + d + '</span>' +
                '<input type="time" name="' + d + '-start" aria-label="' + d + ' first class starts" value="' + esc(s.start) + '">' +
                '<input type="time" name="' + d + '-end" aria-label="' + d + ' last class ends" value="' + esc(s.end) + '">';
        }).join('');
        return '<div class="narrow" style="margin:0"><div class="card">' +
            '<h2>My timetable</h2>' +
            '<p class="sub">Your driver is notified when you add or change this, so you can plan the trip home together. Leave a day blank if you have no classes.</p>' +
            '<form data-form="timetable" novalidate>' +
            '<div class="tt-grid"><span></span><span class="head">First class starts</span><span class="head">Last class ends</span>' + rowsHtml + '</div>' +
            '<div class="field"><label class="lbl" for="tt-file">Upload your timetable (PDF, PNG or JPG, up to 1.5 MB)</label>' +
            '<input id="tt-file" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg">' +
            (t.file ? '<p class="hint">Current file: <strong>' + esc(t.file.name) + '</strong> <button type="button" class="btn-sm" data-action="open-tt" data-email="' + esc(me.email) + '">View</button> <button type="button" class="btn-sm danger" data-action="remove-file">Remove</button></p>' : '') +
            '</div>' +
            '<p class="msg" role="alert" aria-live="polite"></p>' +
            '<button class="btn gold" type="submit">Save and notify my driver</button>' +
            '</form></div></div>';
    }

    function passengerPayment() {
        const c = cards()[me.email];
        return '<div class="narrow" style="margin:0">' +
            '<div class="card"><h2>Card for automatic payment</h2>' +
            (c
                ? '<div class="credit"><div class="row"><span>' + esc(c.brand) + '</span><span>' + (c.auto ? 'Auto-pay on' : 'Auto-pay off') + '</span></div>' +
                '<div class="num">&bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; ' + esc(c.last4) + '</div>' +
                '<div class="row"><span>' + esc(c.holder) + '</span><span>' + esc(c.exp) + '</span></div></div>' +
                '<div class="pax-actions"><button class="btn-sm" data-action="toggle-auto">' + (c.auto ? 'Turn off automatic payment' : 'Turn on automatic payment') + '</button>' +
                '<button class="btn-sm danger" data-action="remove-card">Remove card</button></div>' +
                '<p class="hint" style="margin-top:0.8rem">To change cards, remove this one and add another.</p>'
                : '<p class="sub">Add a card and your seat is paid for automatically when you book.</p>' + cardFormHtml()) +
            '</div>' +
            '<div class="card"><h2>Pay by EFT instead</h2>' +
            '<p class="meta">Choose EFT when you book a ride. You will see the driver\'s account number and a payment reference to use, and the driver confirms once the money arrives.</p></div>' +
            '</div>';
    }

    function cardFormHtml() {
        return '<form data-form="card" novalidate autocomplete="off">' +
            '<div class="field"><label class="lbl" for="c-name">Name on card</label><input id="c-name" name="holder" type="text" autocomplete="cc-name"></div>' +
            '<div class="field"><label class="lbl" for="c-num">Card number</label><input id="c-num" name="number" type="text" inputmode="numeric" data-format="card" placeholder="1234 5678 9012 3456" autocomplete="cc-number" maxlength="23"></div>' +
            '<div class="row2">' +
            '<div class="field"><label class="lbl" for="c-exp">Expiry (MM/YY)</label><input id="c-exp" name="exp" type="text" inputmode="numeric" data-format="exp" placeholder="MM/YY" autocomplete="cc-exp" maxlength="5"></div>' +
            '<div class="field"><label class="lbl" for="c-cvv">CVV</label><input id="c-cvv" name="cvv" type="password" inputmode="numeric" placeholder="123" autocomplete="cc-csc" maxlength="4"></div>' +
            '</div>' +
            '<p class="hint" style="margin-bottom:1rem">Only the card brand, last four digits and expiry are sent to our server. The full number and CVV are never saved.</p>' +
            '<p class="msg" role="alert" aria-live="polite"></p>' +
            '<button class="btn gold" type="submit">Save card</button></form>';
    }

    /* =================================================================
       MAPS
    ================================================================== */
    const DURBAN = [-29.8587, 31.0218];
    const RADII = [2, 5, 10, 20, 30];
    // Kept between tab switches so the map does not start over every time.
    const mapState = { center: null, radius: 10, date: '', area: '', rides: null, rideId: '', dRadius: 5, students: null, dRides: [] };
    let map = null, mapLayer = null;

    const kmText = (n) => (Math.round(n * 10) / 10).toFixed(1) + ' km';
    const radiusOpts = (sel) => RADII.map((n) => '<option value="' + n + '"' + (n === sel ? ' selected' : '') + '>' + n + ' km</option>').join('');
    const seatsText = (n) => n + ' seat' + (n === 1 ? '' : 's') + ' left';

    function pinIcon(text, cls) {
        return L.divIcon({ className: '', html: '<div class="pin ' + (cls || '') + '">' + esc(text) + '</div>', iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -16] });
    }

    function stopMap() { if (map) { map.remove(); map = null; mapLayer = null; } }

    function startMap() {
        stopMap();
        const el = $('#map');
        if (!el) return;
        if (!window.L) {
            el.innerHTML = '<div class="empty" style="margin:1rem">The map could not load. Check your internet connection and refresh the page.</div>';
            return;
        }
        map = L.map(el, { scrollWheelZoom: false }).setView(DURBAN, 11);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
        }).addTo(map);
        mapLayer = L.layerGroup().addTo(map);
        setTimeout(() => { if (map) map.invalidateSize(); }, 0);
        if (me.role === 'driver') { if (mapState.students) drawDriverMap(); else loadDriverMap(); }
        else if (mapState.rides) drawStudentMap();
    }

    // Invitations from drivers. Shown on the passenger's Find a ride and Driver map tabs.
    function offersHtml() {
        const now = new Date();
        const list = (DB.offers || []).map((o) => ({ o: o, r: rides().find((x) => x.id === o.rideId) }))
            .filter((x) => x.r && rideStart(x.r) > now && !bookings().some((b) => b.rideId === x.r.id && b.passenger === me.email && !b.cancelled));
        if (!list.length) return '';
        return '<h2>Ride invitations</h2>' + list.map((x) => {
            const r = x.r, v = vehicles()[r.driver];
            return '<article class="card" style="border-left:4px solid var(--gold)"><div class="ride-head"><div>' +
                '<h3>' + esc(userName(r.driver)) + ' invited you</h3>' +
                '<p class="meta">' + esc(r.from) + ' to ' + esc(r.to) + ' &middot; ' + esc(fmtDate(r.date)) + ' at ' + esc(r.time) + ' &middot; ' + seatsText(seatsLeft(r)) + '</p>' +
                (v ? '<p class="meta">' + esc(v.colour + ' ' + v.make + ' ' + v.model) + ' &middot; ' + esc(v.plate) + '</p>' : '') +
                (x.o.note ? '<p class="meta">&ldquo;' + esc(x.o.note) + '&rdquo;</p>' : '') +
                '</div><div class="price">' + money(r.price) + '<small>per seat</small></div></div>' +
                '<div class="pax-actions" style="margin-top:0.8rem"><button class="btn gold" data-action="book-open" data-id="' + esc(r.id) + '">Book this ride</button>' +
                '<button class="btn-sm" data-action="offer-decline" data-id="' + esc(x.o.id) + '">Not now</button></div></article>';
        }).join('');
    }

    /* ---------- passenger: drivers near the area I typed ---------- */
    function studentMapHtml() {
        return '<div class="greeting"><h1>Drivers near you</h1><p class="sub" style="margin-bottom:0">Enter the area you leave from and see drivers with free seats who start nearby.</p></div>' +
            offersHtml() +
            '<div class="card"><form data-form="map-search" novalidate>' +
            '<div class="map-controls">' +
            '<div class="field"><label class="lbl" for="ms-area">Your area</label><input id="ms-area" name="area" type="text" list="places" placeholder="Suburb, street or campus" value="' + esc(mapState.area) + '"></div>' +
            '<div class="field"><label class="lbl" for="ms-radius">Within</label><select id="ms-radius" name="radius">' + radiusOpts(mapState.radius) + '</select></div>' +
            '<div class="field"><label class="lbl" for="ms-date">Date (optional)</label><input id="ms-date" name="date" type="date" min="' + todayStr() + '" value="' + esc(mapState.date) + '"></div>' +
            '</div>' +
            '<div class="pax-actions"><button class="btn gold" type="submit">Show drivers</button><button class="btn-sm" type="button" data-action="map-locate">Use my location</button></div>' +
            '<p class="msg" role="alert" aria-live="polite" style="margin-top:0.6rem"></p>' +
            '</form>' +
            '<label class="check"><input type="checkbox" data-toggle="discoverable"' + (me.discoverable === false ? '' : ' checked') + '> <span>Let drivers who start near my pick-up spots message me a ride offer. They only see my first name and an approximate area, never my address or phone number.</span></label></div>' +
            '<div class="map-wrap"><div id="map"></div></div>' +
            '<div id="map-list">' + studentMapListHtml() + '</div>';
    }

    function mapRideCard(r) {
        return '<article class="card"><div class="ride-head"><div>' +
            '<h3>' + esc(r.from) + '<span class="arrow">&rarr;</span>' + esc(r.to) + '</h3>' +
            '<p class="meta">' + esc(fmtDate(r.date)) + ' at ' + esc(r.time) + ' &middot; <strong>' + seatsText(r.left) + '</strong> of ' + esc(r.seats) + '</p>' +
            '<p class="meta">Driver: ' + esc(r.driverName) + ' &middot; ' + esc(r.car) + '</p>' +
            '<p class="meta">Starts ' + kmText(r.km) + ' from ' + esc(mapState.center && mapState.center.label ? mapState.center.label : 'you') + '</p>' +
            (r.notes ? '<p class="meta">' + esc(r.notes) + '</p>' : '') +
            '</div><div class="price">' + money(r.price) + '<small>per seat</small><div style="margin-top:0.6rem">' +
            (r.booked ? '<span class="pill ok">Booked</span>' : '<button class="btn gold" data-action="book-open" data-id="' + esc(r.id) + '">Book a seat</button>') +
            '</div></div></div></article>';
    }

    function studentMapListHtml() {
        if (!mapState.rides) return '<div class="empty">Enter your area above to see drivers with free seats near you.</div>';
        if (!mapState.rides.length) return '<div class="empty">No drivers with free seats start within ' + mapState.radius + ' km yet. Try a wider distance or a different date, or check back soon.</div>';
        return '<h2>' + mapState.rides.length + ' ride' + (mapState.rides.length === 1 ? '' : 's') + ' near you</h2>' + mapState.rides.map(mapRideCard).join('');
    }

    function drawStudentMap() {
        const list = $('#map-list');
        if (list) list.innerHTML = studentMapListHtml();
        if (!map) return;
        mapLayer.clearLayers();
        const c = mapState.center;
        let bounds = null;
        if (c) {
            const circle = L.circle([c.lat, c.lng], { radius: mapState.radius * 1000, color: '#14285a', weight: 1, fillOpacity: 0.06 }).addTo(mapLayer);
            L.marker([c.lat, c.lng], { icon: pinIcon('You', 'me'), zIndexOffset: 500, keyboard: false }).addTo(mapLayer);
            bounds = circle.getBounds();
        }
        const groups = {};
        (mapState.rides || []).forEach((r) => { const k = r.lat.toFixed(4) + ',' + r.lng.toFixed(4); (groups[k] = groups[k] || []).push(r); });
        Object.keys(groups).forEach((k) => {
            const g = groups[k];
            const html = '<div class="map-pop">' + g.map((r) =>
                '<div class="map-pop-item"><strong>' + esc(r.from) + ' to ' + esc(r.to) + '</strong><br>' +
                esc(fmtDate(r.date)) + ' at ' + esc(r.time) + '<br>' + esc(r.driverName) + ' &middot; ' + seatsText(r.left) + ' &middot; ' + money(r.price) + '<br>' +
                (r.booked ? '<span class="pill ok">Booked</span>' : '<button class="btn-sm" data-action="book-open" data-id="' + esc(r.id) + '">Book a seat</button>') + '</div>').join('') + '</div>';
            const m = L.marker([g[0].lat, g[0].lng], { icon: pinIcon(g.length) }).bindPopup(html, { maxWidth: 280 }).addTo(mapLayer);
            bounds = bounds ? bounds.extend(m.getLatLng()) : L.latLngBounds([m.getLatLng()]);
        });
        if (bounds) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
    }

    async function findRidesNear(lat, lng, label, radius, date) {
        const qs = new URLSearchParams({ lat: lat, lng: lng, radius: radius });
        if (date) qs.set('date', date);
        const res = await api('GET', '/api/map/rides?' + qs.toString());
        if (!res.ok) return res;
        mapState.center = { lat: lat, lng: lng, label: label };
        mapState.radius = radius; mapState.date = date || ''; mapState.rides = res.data.rides;
        return res;
    }

    /* ---------- driver: students who used pick-up spots near where I start ---------- */
    function driverMapHtml() {
        const now = new Date();
        const up = myRides().filter((r) => rideStart(r) > now).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
        if (!up.length) return '<div class="empty">Publish a ride first, so we know where you start and can show students nearby.<br><button class="btn-sm" data-action="tab" data-tab="publish">Publish a ride</button></div>';
        if (mapState.rideId && !up.some((r) => r.id === mapState.rideId)) mapState.rideId = '';
        return '<div class="greeting"><h1>Riders near your route</h1><p class="sub" style="margin-bottom:0">Students whose earlier pick-up spots are close to where you start. Message them to offer a seat.</p></div>' +
            '<div class="card"><div class="map-controls two">' +
            '<div class="field" style="margin:0"><label class="lbl" for="md-ride">Ride</label><select id="md-ride" data-map-driver><option value="">All my upcoming rides</option>' +
            up.map((r) => '<option value="' + esc(r.id) + '"' + (r.id === mapState.rideId ? ' selected' : '') + '>' + esc(r.from + ' to ' + r.to + ', ' + fmtDate(r.date) + ' ' + r.time) + '</option>').join('') + '</select></div>' +
            '<div class="field" style="margin:0"><label class="lbl" for="md-radius">Students within</label><select id="md-radius" data-map-driver>' + radiusOpts(mapState.dRadius) + '</select></div>' +
            '</div><p class="hint">Only a first name and an approximate area are shown. Students can switch this off in their own settings.</p></div>' +
            '<div class="map-wrap"><div id="map"></div></div>' +
            '<div id="map-list"><div class="empty">Looking for riders&hellip;</div></div>';
    }

    async function loadDriverMap() {
        const qs = new URLSearchParams({ radius: mapState.dRadius });
        if (mapState.rideId) qs.set('rideId', mapState.rideId);
        const res = await api('GET', '/api/map/students?' + qs.toString());
        if (state.tab !== 'map') return;
        if (!res.ok) { const box = $('#map-list'); if (box) box.innerHTML = '<div class="empty">' + esc(res.error || 'Could not load riders.') + '</div>'; return; }
        mapState.students = res.data.students; mapState.dRides = res.data.rides;
        drawDriverMap();
    }

    const eligibleRides = (s) => mapState.dRides.filter((r) => r.left > 0 && s.near.indexOf(r.id) !== -1 && s.blocked.indexOf(r.id) === -1);

    function studentCard(s) {
        const can = eligibleRides(s).length > 0;
        return '<article class="card"><div class="ride-head"><div>' +
            '<h3>' + esc(s.name) + '</h3>' +
            '<p class="meta">Pick-up spot about ' + kmText(s.km) + ' from where you start</p>' +
            '<p class="meta">' + s.trips + ' earlier pick-up' + (s.trips === 1 ? '' : 's') + ' nearby &middot; last on ' + esc(new Date(s.last).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })) + '</p>' +
            '</div><div>' + (can ? '<button class="btn gold" data-action="offer-open" data-id="' + esc(s.id) + '">Message ' + esc(s.name) + '</button>' : '<span class="pill grey">Already invited or booked</span>') + '</div></div></article>';
    }

    function drawDriverMap() {
        const list = $('#map-list');
        const students = mapState.students || [];
        const anchors = mapState.dRides.filter((r) => r.lat != null && (!mapState.rideId || r.id === mapState.rideId));
        if (list) {
            list.innerHTML = students.length
                ? '<h2>' + students.length + ' student' + (students.length === 1 ? '' : 's') + ' near you</h2>' + students.map(studentCard).join('')
                : '<div class="empty">No students have used pick-up spots within ' + mapState.dRadius + ' km of your start yet. Try a wider distance.' +
                (anchors.length ? '' : '<br>We could not place your ride on the map. Republish it with a clearer starting point.') + '</div>';
        }
        if (!map) return;
        mapLayer.clearLayers();
        let bounds = null;
        anchors.forEach((r) => {
            const circle = L.circle([r.lat, r.lng], { radius: mapState.dRadius * 1000, color: '#14285a', weight: 1, fillOpacity: 0.05 }).addTo(mapLayer);
            L.marker([r.lat, r.lng], { icon: pinIcon('Go', 'me'), zIndexOffset: 500 })
                .bindPopup('<strong>' + esc(r.from) + ' to ' + esc(r.to) + '</strong><br>' + esc(fmtDate(r.date)) + ' at ' + esc(r.time) + '<br>' + seatsText(r.left) + ' &middot; ' + money(r.price)).addTo(mapLayer);
            bounds = bounds ? bounds.extend(circle.getBounds()) : circle.getBounds();
        });
        students.forEach((s) => {
            const can = eligibleRides(s).length > 0;
            L.marker([s.lat, s.lng], { icon: pinIcon(s.name.charAt(0).toUpperCase(), 'student') })
                .bindPopup('<strong>' + esc(s.name) + '</strong><br>About ' + kmText(s.km) + ' from your start<br>' + s.trips + ' earlier pick-up' + (s.trips === 1 ? '' : 's') + ' nearby<br>' +
                    (can ? '<button class="btn-sm" data-action="offer-open" data-id="' + esc(s.id) + '">Message ' + esc(s.name) + '</button>' : '<span class="pill grey">Already invited or booked</span>')).addTo(mapLayer);
        });
        if (bounds) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
    }

    function offerModal(s) {
        const list = eligibleRides(s);
        return '<h2>Message ' + esc(s.name) + '</h2>' +
            '<p class="meta" style="margin-bottom:1rem">' + esc(s.name) + ' will get a notification with your ride details and can book straight away. They do not see your phone number until they book.</p>' +
            '<form data-form="offer" data-id="' + esc(s.id) + '" novalidate>' +
            '<div class="field"><label class="lbl" for="of-ride">Which ride?</label><select id="of-ride" name="rideId">' +
            list.map((r) => '<option value="' + esc(r.id) + '"' + (r.id === s.ride ? ' selected' : '') + '>' + esc(r.from + ' to ' + r.to + ', ' + fmtDate(r.date) + ' ' + r.time + ', ' + money(r.price)) + '</option>').join('') + '</select></div>' +
            '<div class="field"><label class="lbl" for="of-note">Add a note (optional)</label><textarea id="of-note" name="note" maxlength="150" placeholder="Hi ' + esc(s.name) + ', I pass your area every morning. Want a ride?"></textarea></div>' +
            '<p class="msg" role="alert" aria-live="polite"></p>' +
            '<button class="btn gold block" type="submit">Send invitation</button>' +
            '</form>';
    }

    const mapActions = {
        'map-locate': () => {
            if (!navigator.geolocation) return toast('Your browser cannot share your location. Type your area instead.');
            navigator.geolocation.getCurrentPosition(async (pos) => {
                const radius = Number(($('#ms-radius') || {}).value) || mapState.radius;
                const res = await findRidesNear(pos.coords.latitude, pos.coords.longitude, 'you', radius, ($('#ms-date') || {}).value || '');
                if (!res.ok) return toast(res.error || 'Could not search from your location.');
                mapState.area = '';
                drawStudentMap();
            }, () => toast('Could not get your location. Type your area instead.'), { timeout: 10000 });
        },
        'offer-open': (el) => {
            const s = (mapState.students || []).find((x) => x.id === el.dataset.id);
            if (s) openModal(offerModal(s));
        },
        'offer-decline': (el) => act('POST', '/api/offers/' + encodeURIComponent(el.dataset.id) + '/decline', {}, () => toast('Invitation dismissed.'))
    };

    /* =================================================================
       FORM HANDLERS
    ================================================================== */
    const luhn = (num) => {
        let sum = 0, alt = false;
        for (let i = num.length - 1; i >= 0; i--) {
            let n = parseInt(num[i], 10);
            if (alt) { n *= 2; if (n > 9) n -= 9; }
            sum += n; alt = !alt;
        }
        return sum % 10 === 0;
    };
    const brandOf = (n) => /^4/.test(n) ? 'Visa' : (/^(5[1-5]|2(2[2-9]|[3-6]|7[01]|720))/.test(n) ? 'Mastercard' : (/^3[47]/.test(n) ? 'Amex' : 'Card'));
    const readFile = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });

    // Runs an API call for a form: disables the button, shows server errors, and refreshes the data on success.
    async function submitToServer(f, method, url, payload) {
        lock(f, true);
        const res = await api(method, url, payload);
        lock(f, false);
        if (!res.ok) { setMsg(f, res.error || 'Something went wrong. Please try again.', 'error'); return null; }
        await refresh();
        return res;
    }

    const forms = {
        'map-search': async (f) => {
            const fd = new FormData(f);
            const area = (fd.get('area') || '').trim(), radius = Number(fd.get('radius')) || 10, date = fd.get('date') || '';
            if (area.length < 2) return setMsg(f, 'Type your area first, like Overport or Umlazi.', 'error');
            lock(f, true); setMsg(f, 'Searching...');
            const g = await api('GET', '/api/geocode?q=' + encodeURIComponent(area));
            if (!g.ok) { lock(f, false); return setMsg(f, g.error || 'Could not find that place.', 'error'); }
            const res = await findRidesNear(g.data.lat, g.data.lng, area, radius, date);
            lock(f, false);
            if (!res.ok) return setMsg(f, res.error || 'Could not search for rides. Please try again.', 'error');
            mapState.area = area;
            drawStudentMap();
            const n = mapState.rides.length;
            setMsg(f, n ? n + ' ride' + (n === 1 ? '' : 's') + ' with free seats within ' + radius + ' km.' : 'No rides with free seats within ' + radius + ' km yet.', n ? 'ok' : '');
        },

        offer: async (f) => {
            const fd = new FormData(f);
            const s = (mapState.students || []).find((x) => x.id === f.dataset.id);
            if (!s) return setMsg(f, 'That rider is no longer on the map.', 'error');
            if (!fd.get('rideId')) return setMsg(f, 'Choose which ride to offer.', 'error');
            const res = await submitToServer(f, 'POST', '/api/offers', { studentId: s.id, rideId: fd.get('rideId'), radius: mapState.dRadius, note: (fd.get('note') || '').trim() });
            if (!res) return;
            s.blocked.push(fd.get('rideId'));
            closeModal(); drawDriverMap(); toast('Invitation sent to ' + s.name + '.');
        },

        vehicle: async (f) => {
            const fd = Object.fromEntries(new FormData(f));
            const isNew = f.dataset.new === '1';
            const year = parseInt(fd.year, 10), seats = parseInt(fd.seats, 10);
            const plate = (fd.plate || '').toUpperCase().replace(/\s+/g, ' ').trim();
            const number = (fd.number || '').replace(/\s+/g, '');
            const branch = (fd.branch || '').replace(/\s+/g, '');
            const err = (t) => setMsg(f, t, 'error');

            if (!(fd.make || '').trim()) return err('Enter your vehicle\'s make.');
            if (!(fd.model || '').trim()) return err('Enter your vehicle\'s model.');
            if (!(year >= 1990 && year <= new Date().getFullYear() + 1)) return err('Enter a valid year.');
            if (!(fd.colour || '').trim()) return err('Enter your vehicle\'s colour.');
            if (plate.replace(/[^A-Z0-9]/g, '').length < 4) return err('Enter your number plate.');
            if (!(seats >= 1 && seats <= 6)) return err('Passenger seats must be between 1 and 6.');
            if (!fd.bank) return err('Choose your bank.');
            if (!(fd.holder || '').trim()) return err('Enter the account holder\'s name.');
            if (!/^\d{6,13}$/.test(number)) return err('Account number must be 6 to 13 digits.');
            if (!/^\d{6}$/.test(branch)) return err('Branch code must be 6 digits.');
            if (isNew && !fd.confirm) return err('Confirm the vehicle declaration to continue.');

            const res = await submitToServer(f, 'PUT', '/api/vehicle', {
                make: fd.make.trim(), model: fd.model.trim(), year: year, colour: fd.colour.trim(), plate: plate, seats: seats,
                bank: { bank: fd.bank, type: fd.type, holder: fd.holder.trim(), number: number, branch: branch }
            });
            if (!res) return;
            state.tab = 'overview'; render();
            toast(isNew ? 'Vehicle registered. You can now publish rides.' : 'Vehicle details saved.');
        },

        publish: async (f) => {
            const fd = Object.fromEntries(new FormData(f));
            const v = vehicles()[me.email];
            const seats = parseInt(fd.seats, 10), price = Number(fd.price);
            const err = (t) => setMsg(f, t, 'error');
            if (!(fd.from || '').trim() || !(fd.to || '').trim()) return err('Enter where you are leaving from and going to.');
            if (fd.from.trim().toLowerCase() === fd.to.trim().toLowerCase()) return err('Start and destination must be different.');
            if (!fd.date || fd.date < todayStr()) return err('Choose today or a future date.');
            if (!fd.time) return err('Choose a departure time.');
            if (rideStart({ date: fd.date, time: fd.time }) <= new Date()) return err('That departure time has already passed.');
            if (!(seats >= 1 && seats <= v.seats)) return err('Seats on offer must be between 1 and ' + v.seats + '.');
            if (!(price >= 1)) return err('Enter a price per seat.');

            const res = await submitToServer(f, 'POST', '/api/rides', {
                from: fd.from.trim(), to: fd.to.trim(), date: fd.date, time: fd.time, seats: seats, price: price, notes: (fd.notes || '').trim()
            });
            if (!res) return;
            state.tab = 'rides'; render(); toast('Ride published.');
        },

        return: async (f) => {
            const time = new FormData(f).get('time');
            if (!time) return toast('Choose a pick-up time first.');
            lock(f, true);
            const res = await api('POST', '/api/rides/' + encodeURIComponent(f.dataset.id) + '/return', { time: time });
            lock(f, false);
            if (!res.ok) return toast(res.error || 'Could not send the pick-up time.');
            await refresh(); render(); toast('Pick-up time sent to passengers.');
        },

        book: async (f) => {
            const fd = new FormData(f);
            const method = fd.get('method');
            const phone = (fd.get('phone') || '').replace(/\s+/g, '');
            const address = (fd.get('address') || '').trim();
            if (!method) return setMsg(f, 'Choose how you would like to pay.', 'error');
            if (!/^0\d{9}$/.test(phone)) return setMsg(f, 'Enter a 10-digit cellphone number, like 082 000 0000.', 'error');
            if (address.length < 5) return setMsg(f, 'Enter the address where you should be picked up.', 'error');
            const res = await submitToServer(f, 'POST', '/api/bookings', { rideId: f.dataset.id, method: method, phone: phone, address: address });
            if (!res) return;
            const booking = DB.bookings.find((x) => x.id === res.data.booking.id) || res.data.booking;
            state.tab = 'bookings';
            render();
            if (method === 'eft') openModal(eftModal(booking)); else { closeModal(); toast('Seat booked. Card payment made automatically.'); }
        },

        timetable: async (f) => {
            const fd = new FormData(f);
            const days = {};
            for (const d of DAYS) {
                const s = fd.get(d + '-start') || '', e = fd.get(d + '-end') || '';
                if ((s && !e) || (!s && e)) return setMsg(f, d + ': enter both a start and an end time, or leave both blank.', 'error');
                if (s && e && e <= s) return setMsg(f, d + ': the last class must end after the first one starts.', 'error');
                days[d] = { start: s, end: e };
            }
            const payload = { days: days };
            const chosen = $('input[type="file"]', f).files[0];
            if (chosen) {
                if (!/^(application\/pdf|image\/png|image\/jpeg)$/.test(chosen.type)) return setMsg(f, 'Upload a PDF, PNG or JPG file.', 'error');
                if (chosen.size > 1.5 * 1024 * 1024) return setMsg(f, 'That file is over 1.5 MB. Upload a smaller one.', 'error');
                try { payload.file = { name: chosen.name, data: await readFile(chosen) }; }
                catch (e) { return setMsg(f, 'Could not read that file.', 'error'); }
            }
            const hasTimes = DAYS.some((d) => days[d].start);
            const hadFile = (timetables()[me.email] || {}).file;
            if (!hasTimes && !chosen && !hadFile) return setMsg(f, 'Add your class times or upload your timetable.', 'error');

            const res = await submitToServer(f, 'PUT', '/api/timetable', payload);
            if (!res) return;
            render();
            toast(res.data.notified ? 'Timetable saved. Your driver has been notified.' : 'Timetable saved. Drivers you book with will see it.');
        },

        card: async (f) => {
            const fd = Object.fromEntries(new FormData(f));
            const num = (fd.number || '').replace(/\D/g, '');
            const err = (t) => setMsg(f, t, 'error');
            if (!(fd.holder || '').trim()) return err('Enter the name on the card.');
            if (num.length < 13 || num.length > 19 || !luhn(num)) return err('That card number does not look right. Check it and try again.');
            const m = /^(\d{2})\/(\d{2})$/.exec(fd.exp || '');
            if (!m || +m[1] < 1 || +m[1] > 12) return err('Enter the expiry as MM/YY.');
            const now = new Date();
            if (2000 + +m[2] < now.getFullYear() || (2000 + +m[2] === now.getFullYear() && +m[1] < now.getMonth() + 1)) return err('That card has expired.');
            if (!/^\d{3,4}$/.test(fd.cvv || '')) return err('Enter the 3 or 4 digit CVV.');

            // Only non-sensitive details leave the browser. The full number and CVV are discarded here.
            const res = await submitToServer(f, 'PUT', '/api/card', { brand: brandOf(num), last4: num.slice(-4), exp: fd.exp, holder: fd.holder.trim() });
            if (!res) return;
            render(); toast('Card saved. Automatic payment is on.');
        }
    };

    /* =================================================================
       ACTIONS
    ================================================================== */
    // Runs a one-tap action, then refreshes and redraws.
    async function act(method, url, payload, done) {
        const res = await api(method, url, payload);
        if (!res.ok) return toast(res.error || 'Something went wrong. Please try again.');
        await refresh();
        render();
        if (done) done(res);
    }

    const actions = {
        ...mapActions,
        tab: (el) => { state.tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
        bell: () => { if (bellOpen()) closeBell(); else openBell(); },
        logout: async () => { await api('POST', '/api/auth/logout', {}); location.href = LOGIN_URL; },
        reload: () => location.reload(),
        'close-modal': () => closeModal(),
        'go-payment': (el, e) => { e.preventDefault(); closeModal(); state.tab = 'payment'; render(); },

        'open-tt': (el) => openFile(el.dataset.email),

        'confirm-pay': (el) => act('POST', '/api/bookings/' + encodeURIComponent(el.dataset.id) + '/confirm', {}, () => toast('Payment confirmed.')),

        'delete-ride': (el) => {
            if (!confirm('Remove this ride?')) return;
            act('DELETE', '/api/rides/' + encodeURIComponent(el.dataset.id), undefined, () => toast('Ride removed.'));
        },

        'book-open': async (el) => {
            let r = rides().find((x) => x.id === el.dataset.id);
            if (!r) { await refresh(); r = rides().find((x) => x.id === el.dataset.id); } // a ride published in the last few seconds
            if (r) openModal(bookModal(r)); else toast('That ride is no longer available.');
        },

        'eft-show': (el) => {
            const b = bookings().find((x) => x.id === el.dataset.id);
            if (b) openModal(eftModal(b));
        },

        'eft-sent': (el) => {
            closeModal();
            act('POST', '/api/bookings/' + encodeURIComponent(el.dataset.id) + '/eft-sent', {}, () => toast('Thanks. Your driver has been told.'));
        },

        'cancel-booking': (el) => {
            if (!confirm('Cancel this booking? If you already paid by EFT, sort out any refund with the driver directly.')) return;
            act('POST', '/api/bookings/' + encodeURIComponent(el.dataset.id) + '/cancel', {}, () => toast('Booking cancelled.'));
        },

        'remove-file': () => {
            const t = timetables()[me.email] || { days: {} };
            act('PUT', '/api/timetable', { days: t.days, file: null }, () => toast('File removed.'));
        },

        'toggle-auto': () => {
            const c = cards()[me.email];
            if (c) act('PATCH', '/api/card', { auto: !c.auto });
        },

        'remove-card': () => {
            if (!confirm('Remove your saved card?')) return;
            act('DELETE', '/api/card', undefined, () => toast('Card removed.'));
        }
    };

    /* ---------- events ---------- */
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
        if (bellOpen() && !e.target.closest('#notif-panel') && !e.target.closest('#bell')) closeBell();
    });

    document.addEventListener('submit', (e) => {
        const f = e.target.closest('form[data-form]');
        if (!f) return;
        e.preventDefault();
        if (forms[f.dataset.form]) forms[f.dataset.form](f);
    });

    document.addEventListener('input', (e) => {
        const t = e.target;
        if (t.matches('[data-filter]')) {
            state.filter[t.name] = t.value;
            $('#ride-list').innerHTML = rideListHtml();
        } else if (t.matches('[data-format="card"]')) {
            t.value = t.value.replace(/\D/g, '').slice(0, 19).replace(/(.{4})/g, '$1 ').trim();
        } else if (t.matches('[data-format="exp"]')) {
            let d = t.value.replace(/\D/g, '').slice(0, 4);
            if (d.length > 2) d = d.slice(0, 2) + '/' + d.slice(2);
            t.value = d;
        }
    });

    document.addEventListener('change', async (e) => {
        const t = e.target;
        if (t.matches('[data-toggle="discoverable"]')) {
            const res = await api('PUT', '/api/discoverable', { on: t.checked });
            if (!res.ok) { t.checked = !t.checked; return toast(res.error || 'Could not save that setting.'); }
            me.discoverable = t.checked;
            toast(t.checked ? 'Nearby drivers can now message you.' : 'Drivers can no longer find you on their map.');
        } else if (t.matches('[data-map-driver]')) {
            mapState.rideId = $('#md-ride').value; mapState.dRadius = Number($('#md-radius').value) || 5;
            loadDriverMap();
        }
    });

    $('#modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && bellOpen()) closeBell(); });

    /* ---------- keep the dashboard fresh ---------- */
    // Every 20 seconds, pick up new bookings, payments and notifications.
    // Screens with forms are left alone so nothing you are typing gets wiped.
    setInterval(async () => {
        if (document.hidden || !me) return;
        if (!(await refresh())) return;
        const el = document.activeElement;
        const typing = el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
        if ($('#modal').open) return;
        if (AUTO_REFRESH_TABS[me.role].includes(state.tab) && !typing) render();
        else if (!bellOpen()) renderBell();
    }, 20000);

    /* ---------- start ---------- */
    (async function init() {
        if (!(await refresh())) {
            app.innerHTML = '<div class="empty">We could not load your dashboard.<br><button class="btn-sm" data-action="reload">Try again</button></div>';
            return;
        }
        state.tab = me.role === 'driver' ? 'overview' : 'find';
        render();
    })();
})();
