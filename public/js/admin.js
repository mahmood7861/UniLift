(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const msg = (t) => { $('message').textContent = t || ''; };
    const fmt = (ms) => new Date(ms).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
    const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

    // Builds an element with plain text only (nothing from the database is ever treated as HTML).
    function el(tag, cls, text, kids) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = text;
        (kids || []).forEach((k) => e.appendChild(k));
        return e;
    }
    const kv = (k, v) => el('div', 'kv', null, [el('b', '', k), el('span', '', v)]);

    async function api(path, opts) {
        const res = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}));
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Something went wrong.');
        return data;
    }

    let data = null, openDriver = null;

    function renderDrivers() {
        const body = $('drivers');
        body.replaceChildren();
        if (!data.drivers.length) { body.appendChild(el('tr', '', null, [el('td', 'empty', 'No drivers yet.')])); return; }
        data.drivers.forEach((d) => {
            const btn = el('button', 'act', 'View');
            btn.addEventListener('click', () => showDriver(d));
            body.appendChild(el('tr', '', null, [
                el('td', '', d.id),
                el('td', '', d.name),
                el('td', '', null, [el('span', 'pill ' + d.status, d.status === 'active' ? 'Active' : 'Suspended')]),
                el('td', '', null, [el('span', 'star', '★ '), document.createTextNode(d.rating === null ? 'No reviews' : d.rating.toFixed(1))]),
                el('td', '', null, [btn])
            ]));
        });
    }

    function renderStudent() {
        const box = $('student');
        box.replaceChildren();
        const s = data.students[$('student-select').selectedIndex];
        if (!s) { box.appendChild(el('p', 'empty', 'No students yet.')); return; }
        box.append(
            el('div', 'kv', null, [el('b', '', 'Name'), el('div', 'name', s.name)]),
            kv('Student number', s.studentNo), kv('Email', s.email), kv('Phone', s.phone),
            kv('Bookings', String(s.bookings)), kv('Joined', fmt(s.joined))
        );
    }

    function renderStudentList() {
        const sel = $('student-select');
        sel.replaceChildren();
        data.students.forEach((s) => sel.appendChild(el('option', '', s.name + ' (' + s.studentNo + ')')));
        renderStudent();
    }

    function renderReviews() {
        const box = $('reviews');
        box.replaceChildren();
        if (!data.reviews.length) box.appendChild(el('p', 'empty', 'No reviews yet.'));
        data.reviews.forEach((r) => box.appendChild(el('div', 'item', null, [
            el('div', '', null, [
                el('b', '', r.driver + ' '), el('span', 'star', stars(r.rating)),
                el('small', '', r.comment || 'No comment'), el('small', '', 'by ' + r.reviewer)
            ]),
            el('div', 'r', fmt(r.at))
        ])));
    }

    function renderWarnings() {
        const box = $('warnings');
        box.replaceChildren();
        if (!data.warnings.length) box.appendChild(el('p', 'empty', 'No warnings.'));
        data.warnings.forEach((w) => box.appendChild(el('div', 'item', null, [
            el('div', '', null, [el('b', '', w.title), el('small', '', w.name + ' - ' + w.detail)]),
            el('div', 'r', null, [el('span', 'pill role ' + w.role, w.role === 'driver' ? 'Driver' : 'Student'), el('small', '', fmt(w.at))])
        ])));
    }

    function showDriver(d) {
        openDriver = d;
        $('d-name').textContent = d.name + ' (' + d.id + ')';
        const body = $('d-body');
        body.replaceChildren(
            kv('Email', d.email), kv('Phone', d.phone), kv('Vehicle', d.car || 'Not registered'),
            kv('Rides posted', String(d.rides)),
            kv('Rating', d.rating === null ? 'No reviews' : d.rating.toFixed(1) + ' (' + d.reviews + ' reviews)'),
            kv('Low ratings', d.low + ' rated 1-2 stars'), kv('Warnings', String(d.warns)),
            kv('Status', d.status === 'active' ? 'Active' : 'Suspended'), kv('Joined', fmt(d.joined))
        );
        const t = $('d-toggle');
        t.textContent = d.status === 'active' ? 'Suspend driver' : 'Reactivate driver';
        t.className = d.status === 'active' ? '' : 're';
        $('d-note').value = '';
        $('d-warn').disabled = !d.reviews;
        $('driver-dialog').showModal();
    }

    async function load() {
        data = await api('/api/admin/overview');
        renderDrivers(); renderStudentList(); renderReviews(); renderWarnings();
    }

    $('student-select').addEventListener('change', renderStudent);
    $('d-close').addEventListener('click', () => $('driver-dialog').close());
    $('d-warn').addEventListener('click', async () => {
        if (!openDriver) return;
        try {
            await api('/api/admin/warnings', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: openDriver.email, note: $('d-note').value })
            });
            $('driver-dialog').close();
            msg('Warning sent to ' + openDriver.name + '.');
            await load();
        } catch (err) { msg(err.message); }
    });
    $('d-toggle').addEventListener('click', async () => {
        if (!openDriver) return;
        const next = openDriver.status === 'active' ? 'suspended' : 'active';
        try {
            await api('/api/admin/drivers/status', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: openDriver.email, status: next })
            });
            $('driver-dialog').close();
            msg(openDriver.name + (next === 'suspended' ? ' has been suspended.' : ' has been reactivated.'));
            await load();
        } catch (err) { msg(err.message); }
    });
    $('logout-btn').addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
        window.location.href = 'login.html';
    });

    fetch('/api/me', { credentials: 'same-origin' })
        .then((r) => r.json())
        .then((d) => {
            if (!d.user || d.user.role !== 'admin') return window.location.replace('login.html#admin');
            return load();
        })
        .catch(() => window.location.replace('login.html#admin'));
})();