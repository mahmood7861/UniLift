'use strict';

/* ---------------------------------------------------------------------
   UniLift server
   - Serves the website from /public and the JSON API under /api.
   - Stores everything in MySQL (see db.js and schema.sql).
   - The only package needed is "mysql2" (run: npm install).
--------------------------------------------------------------------- */

// Rides are stored as plain "date + time" text, so the server must use
// the same timezone as your students. Override with the TZ environment variable.
require('./env');
process.env.TZ = process.env.TZ || 'Africa/Johannesburg';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'ul_session';
const TRUST_PROXY = !!process.env.TRUST_PROXY;
const { q, q1, run, tx } = db;

/* ---------- shared rules (mirrors the website) ---------- */
const EMAIL_RE = /^\d{8}@dut4life\.ac\.za$/;
const PHONE_RE = /^0\d{9}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const QUESTIONS = [
    'What was the name of your first pet?',
    "What is your mother's maiden name?",
    'What was the name of your primary school?',
    'In which town or city were you born?',
    'What was your childhood nickname?',
    'What is the name of your favourite teacher?'
];
const BANKS = ['ABSA', 'African Bank', 'Capitec', 'Discovery Bank', 'FNB', 'Investec', 'Nedbank', 'Standard Bank', 'TymeBank'];
const ACCOUNT_TYPES = ['Cheque / Current', 'Savings', 'Transmission'];
const CARD_BRANDS = ['Visa', 'Mastercard', 'Amex', 'Card'];
const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
const TOO_MANY = 'Too many attempts. Please wait a few minutes and try again.';

/* ---------- errors ---------- */
class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

/* ---------- small helpers ---------- */
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const validDate = (s) => {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
};
const rideStart = (r) => { const [h, m] = r.time.split(':').map(Number); const [y, mo, d] = r.date.split('-').map(Number); return new Date(y, mo - 1, d, h, m, 0, 0); };
const fmtDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' }); };
const money = (n) => 'R' + Number(n).toFixed(2).replace(/\.00$/, '');
const uid = () => crypto.randomBytes(8).toString('hex'); // 16 characters
const str = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max;
const clean = (v) => String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
const normAnswer = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

/* ---------- database rows -> the shapes the website expects ---------- */
const mapUser = (r) => r && ({
    email: r.email, name: r.name, phone: r.phone, role: r.role, passHash: r.pass_hash,
    question: r.question, answerHash: r.answer_hash, tokenVersion: Number(r.token_version), status: r.status || 'active',
    discoverable: r.discoverable === undefined || r.discoverable === null ? true : !!r.discoverable
});
const mapRide = (r) => ({
    id: r.id, driver: r.driver_email, from: r.from_place, to: r.to_place, date: r.ride_date, time: r.ride_time,
    seats: Number(r.seats), price: Number(r.price), notes: r.notes, returnTime: r.return_time, createdAt: Number(r.created_at)
});
const mapBooking = (r) => ({
    id: r.id, rideId: r.ride_id, passenger: r.passenger_email, driver: r.driver_email, method: r.method,
    status: r.status, price: Number(r.price), phone: r.pickup_phone || '', address: r.pickup_address || '',
    cancelled: !!r.cancelled, createdAt: Number(r.created_at)
});
const mapVehicle = (r, withBank) => {
    const v = { make: r.make, model: r.model, year: Number(r.vehicle_year), colour: r.colour, plate: r.plate, seats: Number(r.seats), registeredAt: Number(r.registered_at) };
    if (withBank) v.bank = { bank: r.bank_name, type: r.account_type, holder: r.account_holder, number: r.account_number, branch: r.branch_code };
    return v;
};
const mapCard = (r) => ({ brand: r.brand, last4: r.last4, exp: r.expiry, holder: r.holder, auto: !!r.auto_pay });
const mapTimetable = (r) => ({
    days: JSON.parse(r.days_json),
    file: r.file_name ? { name: r.file_name, type: r.file_type, size: Number(r.file_size) } : null,
    updatedAt: Number(r.updated_at)
});

const getUser = async (email) => mapUser(await q1('SELECT * FROM users WHERE email = ?', [email]));

// conn is either the pool or a transaction connection.
async function notify(conn, email, text) {
    await run('INSERT INTO notifications (id, email, message, created_at, is_read) VALUES (?, ?, ?, ?, 0)',
        [uid(), email, String(text).slice(0, 500), Date.now()], conn);
    // keep only each person's 50 newest notifications
    await run('DELETE FROM notifications WHERE email = ? AND id NOT IN ' +
        '(SELECT id FROM (SELECT id FROM notifications WHERE email = ? ORDER BY created_at DESC, id DESC LIMIT 50) AS keep)',
        [email, email], conn);
}

/* ---------- passwords and answers: scrypt with a random salt ---------- */
const scrypt = (value, salt) => new Promise((resolve, reject) =>
    crypto.scrypt(value, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))));

async function hashSecret(value) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(value, salt);
    return salt.toString('hex') + ':' + key.toString('hex');
}
async function checkSecret(value, stored) {
    const [salt, hash] = stored.split(':');
    const key = await scrypt(value, Buffer.from(salt, 'hex'));
    const expected = Buffer.from(hash, 'hex');
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}
let dummyHash;
async function burnTime(value) { // keeps timing similar whether or not an account exists
    dummyHash = dummyHash || (await hashSecret('unilift-dummy'));
    await checkSecret(value, dummyHash);
}

/* ---------- sessions: signed cookie ---------- */
let SECRET = null; // loaded at start-up (see loadSecret)

async function loadSecret() {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
    const row = await q1("SELECT setting_value FROM settings WHERE setting_key = 'session_secret'");
    if (row) return row.setting_value;
    const secret = crypto.randomBytes(48).toString('hex');
    try {
        await run("INSERT INTO settings (setting_key, setting_value) VALUES ('session_secret', ?)", [secret]);
        return secret;
    } catch (e) { // another copy of the server saved one first
        return (await q1("SELECT setting_value FROM settings WHERE setting_key = 'session_secret'")).setting_value;
    }
}

function signToken(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
    return body + '.' + sig;
}
function readToken(token) {
    const parts = String(token).split('.');
    if (parts.length !== 2) return null;
    const expected = crypto.createHmac('sha256', SECRET).update(parts[0]).digest();
    let given;
    try { given = Buffer.from(parts[1], 'base64url'); } catch (e) { return null; }
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    try {
        const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        return p.x > Date.now() ? p : null;
    } catch (e) { return null; }
}
function parseCookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach((pair) => {
        const i = pair.indexOf('=');
        if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
    });
    return out;
}
function isHttps(req) { return !!req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https'); }
function setSession(req, res, user, remember) {
    const life = remember ? 30 * 24 * 3600 * 1000 : 12 * 3600 * 1000;
    const token = signToken({ e: user.email, v: user.tokenVersion || 0, x: Date.now() + life });
    res.setHeader('Set-Cookie', COOKIE + '=' + token + '; HttpOnly; SameSite=Lax; Path=/' +
        (remember ? '; Max-Age=' + Math.floor(life / 1000) : '') + (isHttps(req) ? '; Secure' : ''));
}
function clearSession(req, res) {
    res.setHeader('Set-Cookie', COOKIE + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' + (isHttps(req) ? '; Secure' : ''));
}
async function userFromRequest(req) {
    const token = parseCookies(req)[COOKIE];
    const p = token && readToken(token);
    if (!p || typeof p.e !== 'string') return null;
    const u = await getUser(p.e);
    return u && u.tokenVersion === p.v ? u : null;
}

/* ---------- rate limiting ---------- */
const hits = new Map();
function limited(key, max, windowMs) {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    h.n++;
    return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); }, 60000).unref();
const clientIp = (req) => (TRUST_PROXY && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';

/* ---------- what each person is allowed to see ---------- */
async function buildState(user) {
    const email = user.email;
    const today = todayStr();

    const mine = (await q('SELECT * FROM bookings WHERE passenger_email = ? OR driver_email = ?', [email, email])).map(mapBooking);

    const rides = (await q(
        'SELECT r.*, (SELECT COUNT(*) FROM bookings b WHERE b.ride_id = r.id AND b.cancelled = 0) AS booked ' +
        'FROM rides r WHERE r.ride_date >= ? OR r.driver_email = ? ' +
        'OR r.id IN (SELECT ride_id FROM bookings WHERE passenger_email = ? OR driver_email = ?) ' +
        'ORDER BY r.ride_date, r.ride_time', [today, email, email, email]
    )).map((r) => Object.assign(mapRide(r), { booked: Number(r.booked) }));

    // people: names for everyone shown, phone numbers only for a driver's own passengers
    const nameOnly = new Set([email]);
    const withPhone = new Set([email]);
    rides.forEach((r) => nameOnly.add(r.driver));
    mine.forEach((b) => { if (b.driver === email) withPhone.add(b.passenger); else nameOnly.add(b.driver); });
    const userRows = await q('SELECT email, name, phone FROM users WHERE email IN (?)', [[...new Set([...nameOnly, ...withPhone])]]);
    const users = {};
    userRows.forEach((u) => { users[u.email] = withPhone.has(u.email) ? { name: u.name, phone: u.phone } : { name: u.name }; });

    // A driver's bank details are shared only with passengers who chose EFT for one of their rides.
    const bankVisible = new Set(mine.filter((b) => b.passenger === email && !b.cancelled && b.method === 'eft').map((b) => b.driver));
    const driverEmails = new Set(rides.map((r) => r.driver));
    driverEmails.add(email);
    const vehicles = {};
    (await q('SELECT * FROM vehicles WHERE email IN (?)', [[...driverEmails]])).forEach((v) => {
        vehicles[v.email] = mapVehicle(v, v.email === email || bankVisible.has(v.email));
    });

    // Drivers see the timetables of passengers booked on their rides. Passengers see only their own.
    const ttEmails = new Set([email]);
    mine.forEach((b) => { if (b.driver === email && !b.cancelled) ttEmails.add(b.passenger); });
    const timetables = {};
    (await q('SELECT email, days_json, file_name, file_type, file_size, updated_at FROM timetables WHERE email IN (?)', [[...ttEmails]]))
        .forEach((t) => { timetables[t.email] = mapTimetable(t); });

    const cardRow = await q1('SELECT * FROM cards WHERE email = ?', [email]);
    // ride invitations from drivers (students only)
    const offers = user.role !== 'student' ? [] : (await q("SELECT o.id, o.ride_id, o.driver_email, o.message, o.created_at FROM ride_offers o JOIN rides r ON r.id = o.ride_id " +
        "WHERE o.student_email = ? AND o.status = 'pending' AND r.ride_date >= ? ORDER BY o.created_at DESC", [email, today]))
        .map((o) => ({ id: o.id, rideId: o.ride_id, driver: o.driver_email, note: o.message, at: Number(o.created_at) }));
    const notifs = (await q('SELECT id, message, created_at, is_read FROM notifications WHERE email = ? ORDER BY created_at DESC, id DESC LIMIT 50', [email]))
        .map((n) => ({ id: n.id, text: n.message, at: Number(n.created_at), read: !!n.is_read }));

    return {
        me: { email: email, name: user.name, role: user.role, phone: user.phone, discoverable: user.discoverable },
        users: users, vehicles: vehicles, rides: rides, bookings: mine,
        cards: cardRow ? { [email]: mapCard(cardRow) } : {},
        timetables: timetables,
        notifs: notifs,
        offers: offers
    };
}

/* ---------- maps: place lookup and distance ---------- */
// Well-known DUT campuses and Durban suburbs are answered instantly (approximate centre points, adjust if you like).
// Anything else is looked up on OpenStreetMap's Nominatim service, one request at a time, and cached in the database.
const KNOWN_PLACES = {
    'steve biko campus': [-29.8531, 30.9791], 'ml sultan campus': [-29.8578, 31.0105], 'ritson campus': [-29.8536, 30.9891],
    'brickfield campus': [-29.8535, 30.9797], 'city campus': [-29.8570, 31.0000], 'riverside campus': [-29.7930, 31.0100],
    'indumiso campus (pietermaritzburg)': [-29.6047, 30.3939], 'berea': [-29.8500, 30.9950], 'overport': [-29.8367, 30.9900],
    'glenwood': [-29.8730, 30.9800], 'umlazi': [-29.9700, 30.8850], 'chatsworth': [-29.9200, 30.8830], 'pinetown': [-29.8100, 30.8600],
    'phoenix': [-29.7010, 31.0130], 'umhlanga': [-29.7270, 31.0850], 'isipingo': [-29.9990, 30.9300],
    'amanzimtoti': [-30.0530, 30.8790], 'kwamashu': [-29.7500, 30.9800]
};
const normPlace = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 150);
const inSA = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat < -22 && lat > -35 && lng > 16 && lng < 33;
const clampKm = (v, def) => { const n = Number(v); return n >= 1 && n <= 50 ? n : def; };
function distKm(aLat, aLng, bLat, bLng) {
    const rad = Math.PI / 180, dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
}
const approx = (n) => Math.round(n * 100) / 100; // about 1 km: what other people get to see of a student's pick-up spot

// Nominatim allows one request per second, so lookups wait in a single line.
let geoQueue = Promise.resolve();
function nominatim(text) {
    const job = geoQueue.then(async () => {
        try {
            const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=za&viewbox=29.0,-28.0,32.5,-31.5&q=' + encodeURIComponent(text);
            const res = await fetch(url, {
                headers: { 'User-Agent': 'UniLift/2.0 (student ride sharing; ' + (process.env.CONTACT_EMAIL || 'set-CONTACT_EMAIL-in-env') + ')', 'Accept-Language': 'en' },
                signal: AbortSignal.timeout(6000)
            });
            if (!res.ok) return undefined;
            const list = await res.json();
            const hit = Array.isArray(list) && list[0];
            return hit ? { lat: Number(hit.lat), lng: Number(hit.lon), label: String(hit.display_name || text).slice(0, 200) } : null;
        } catch (e) { return undefined; } // undefined = could not ask, null = asked and found nothing
    });
    geoQueue = job.then(() => new Promise((resolve) => setTimeout(resolve, 1100)));
    return job;
}

async function geocode(text) {
    const key = normPlace(text);
    if (key.length < 2) return null;
    if (KNOWN_PLACES[key]) return { lat: KNOWN_PLACES[key][0], lng: KNOWN_PLACES[key][1], label: String(text).trim() };
    const cached = await q1('SELECT lat, lng, label, created_at FROM geocode_cache WHERE query_key = ?', [key]);
    if (cached && cached.lat !== null) return { lat: cached.lat, lng: cached.lng, label: cached.label };
    if (cached && Date.now() - Number(cached.created_at) < 86400e3) return null; // a miss is remembered for a day
    const found = await nominatim(key);
    if (found === undefined) return null;
    await run('REPLACE INTO geocode_cache (query_key, lat, lng, label, created_at) VALUES (?, ?, ?, ?, ?)',
        [key, found ? found.lat : null, found ? found.lng : null, found ? found.label : '', Date.now()]);
    return found;
}
// "12 Some Street, Overport" often is not found as a whole, so the street part is dropped and the suburb tried next.
async function geocodeAddress(text, maxTries) {
    const parts = String(text).split(',').map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < Math.min(parts.length, maxTries || 3); i++) {
        const hit = await geocode(parts.slice(i).join(', '));
        if (hit && inSA(hit.lat, hit.lng)) return hit;
    }
    return null;
}

// Rides and bookings made before maps existed have no coordinates yet. A few are filled in each time the map is opened.
async function fillRideCoords(rows) {
    let n = 0;
    for (const r of rows) {
        if (r.from_lat != null || r.geo_tried || n >= 3) continue;
        n++;
        const a = await geocodeAddress(r.from_place, 2), b = await geocodeAddress(r.to_place, 2);
        r.from_lat = a ? a.lat : null; r.from_lng = a ? a.lng : null;
        await run('UPDATE rides SET from_lat = ?, from_lng = ?, to_lat = ?, to_lng = ?, geo_tried = 1 WHERE id = ?',
            [r.from_lat, r.from_lng, b ? b.lat : null, b ? b.lng : null, r.id]);
    }
}
async function fillBookingCoords(rows) {
    let n = 0;
    for (const b of rows) {
        if (b.pickup_lat != null || b.pickup_geo || !b.pickup_address || n >= 4) continue;
        n++;
        const hit = await geocodeAddress(b.pickup_address, 2);
        b.pickup_lat = hit ? hit.lat : null; b.pickup_lng = hit ? hit.lng : null;
        await run('UPDATE bookings SET pickup_lat = ?, pickup_lng = ?, pickup_geo = 1 WHERE id = ?', [b.pickup_lat, b.pickup_lng, b.id]);
    }
}

// Students get an opaque id, so a driver can message someone without ever learning their student number.
const studentId = (email) => crypto.createHmac('sha256', SECRET).update('student:' + email).digest('hex').slice(0, 16);

// Students whose earlier pick-up spots are within `radius` km of any of the driver's start points.
// Only a first name, an approximate spot (about 1 km) and counts are returned: never an address, email or phone number.
async function nearbyStudents(driverEmail, anchors, radius) {
    if (!anchors.length) return [];
    const rows = await q("SELECT b.id, b.passenger_email, b.pickup_address, b.pickup_lat, b.pickup_lng, b.pickup_geo, b.created_at, u.name " +
        "FROM bookings b JOIN users u ON u.email = b.passenger_email " +
        "WHERE u.role = 'student' AND u.status <> 'suspended' AND u.discoverable = 1 AND b.passenger_email <> ? " +
        "ORDER BY b.created_at DESC LIMIT 1500", [driverEmail]);
    await fillBookingCoords(rows);

    const found = new Map();
    for (const b of rows) {
        if (b.pickup_lat == null) continue;
        const lat = approx(b.pickup_lat), lng = approx(b.pickup_lng);
        let best = null; const near = [];
        for (const a of anchors) {
            const d = distKm(a.lat, a.lng, lat, lng);
            if (d <= radius) { near.push(a.id); if (!best || d < best.d) best = { d: d, ride: a.id }; }
        }
        if (!best) continue;
        const s = found.get(b.passenger_email) || { email: b.passenger_email, name: b.name, trips: 0, last: 0, near: new Set(), best: null };
        s.trips++; s.last = Math.max(s.last, Number(b.created_at)); near.forEach((id) => s.near.add(id));
        if (!s.best || best.d < s.best.d) { s.best = best; s.lat = lat; s.lng = lng; }
        found.set(b.passenger_email, s);
    }
    return [...found.values()];
}

/* ---------- router ---------- */
const routes = [];
function route(method, pattern, opts, handler) {
    routes.push({ method: method, opts: opts, handler: handler, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });
}

async function readJson(req, limit) {
    const chunks = []; let size = 0, tooBig = false;
    await new Promise((resolve, reject) => {
        req.on('data', (c) => { size += c.length; if (size > limit) tooBig = true; else chunks.push(c); });
        req.on('end', resolve);
        req.on('error', reject);
    });
    if (tooBig) throw new HttpError(413, 'That request is too large.');
    if (!chunks.length) return {};
    try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (e) { throw bad('Invalid request.'); }
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

async function handleApi(req, res, url) {
    let matched = null, pathMatched = false;
    for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method === req.method) { matched = { r: r, params: m.groups || {} }; break; }
    }
    if (!matched) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed.' : 'Not found.');

    const { r, params } = matched;
    const write = req.method !== 'GET' && req.method !== 'HEAD';

    if (write) { // basic CSRF protection: same-origin only
        const origin = req.headers.origin;
        if (origin) {
            let host = '';
            try { host = new URL(origin).host; } catch (e) { /* fall through */ }
            if (host !== req.headers.host) throw new HttpError(403, 'Blocked request.');
        }
        const ct = String(req.headers['content-type'] || '');
        if (Number(req.headers['content-length'] || 0) > 0 && !ct.includes('application/json')) throw new HttpError(415, 'Unsupported content type.');
    }

    const user = await userFromRequest(req);
    if (r.opts.auth !== false && !user) throw new HttpError(401, 'Please log in.');
    if (r.opts.role && user.role !== r.opts.role) throw new HttpError(403, r.opts.role === 'admin' ? 'Administrators only.' : r.opts.role === 'driver' ? 'Only drivers can do this.' : 'Only passengers can do this.');

    const body = write ? await readJson(req, r.opts.max || 20000) : {};
    const result = await r.handler({ req: req, res: res, params: params, body: body, user: user, ip: clientIp(req), url: url });
    if (res.writableEnded) return;
    const [status, payload] = Array.isArray(result) ? result : [200, result];
    sendJson(res, status, payload || { ok: true });
}

/* =====================================================================
   AUTH
===================================================================== */
route('POST', '/api/auth/register', { auth: false }, async ({ body, ip }) => {
    if (limited('reg:' + ip, 20, 3600e3)) throw new HttpError(429, TOO_MANY);
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').replace(/\s+/g, '');
    const answer = normAnswer(body.answer || '');

    if (!['driver', 'student'].includes(body.role)) throw bad('Choose Student or Driver.');
    if (!str(body.name, 2, 80)) throw bad('Enter your full name.');
    if (!EMAIL_RE.test(email)) throw bad('Email must look like 12345678@dut4life.ac.za.');
    if (!PHONE_RE.test(phone)) throw bad('Enter a 10-digit phone number, like 082 000 0000.');
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128) throw bad('Password must be 8 to 128 characters.');
    if (!QUESTIONS.includes(body.question)) throw bad('Choose a security question.');
    if (answer.length < 2 || answer.length > 100) throw bad('Enter an answer to your security question.');

    const exists = 'An account with this email already exists. Log in instead.';
    if (await q1('SELECT email FROM users WHERE email = ?', [email])) throw new HttpError(409, exists);

    const passHash = await hashSecret(body.password);
    const answerHash = await hashSecret(answer);
    try {
        await run('INSERT INTO users (email, name, phone, role, pass_hash, question, answer_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
            [email, clean(body.name), phone, body.role, passHash, body.question, answerHash, Date.now()]);
    } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') throw new HttpError(409, exists); // two sign-ups at the same moment
        throw err;
    }
    return [201, { ok: true }];
});

route('POST', '/api/auth/login', { auth: false }, async ({ req, res, body, ip }) => {
    const email = String(body.email || '').trim().toLowerCase();
    const key = 'login:' + ip + ':' + email;
    if (limited(key, 8, 15 * 60e3)) throw new HttpError(429, TOO_MANY);
    const password = typeof body.password === 'string' ? body.password.slice(0, 128) : '';
    const user = EMAIL_RE.test(email) ? await getUser(email) : null;

    const ok = user ? await checkSecret(password, user.passHash) : (await burnTime(password), false);
    if (!ok) throw new HttpError(401, 'Email or password is incorrect.');
    if (user.status === 'suspended') throw new HttpError(403, 'This account has been suspended. Please contact UniLift support.');

    hits.delete(key);
    if (body.adminOnly && user.role !== 'admin') throw new HttpError(403, 'This account does not have administrator access.');
    if (!body.adminOnly && user.role === 'admin') throw new HttpError(403, 'Administrators must log in from the Admin tab.');
    setSession(req, res, user, !!body.remember);
    return { user: { email: user.email, name: user.name, role: user.role } };
});

route('POST', '/api/auth/logout', { auth: false }, async ({ req, res }) => {
    clearSession(req, res);
    return { ok: true };
});

route('GET', '/api/me', { auth: false }, async ({ req }) => {
    const u = await userFromRequest(req);
    return { user: u ? { email: u.email, name: u.name, role: u.role } : null };
});

// Step 1 of a password reset: return the account's security question.
// Unknown emails get a believable question too, so nobody can use this to find out who has an account.
route('POST', '/api/auth/question', { auth: false }, async ({ body, ip }) => {
    const email = String(body.email || '').trim().toLowerCase();
    if (limited('q:' + ip, 15, 15 * 60e3)) throw new HttpError(429, TOO_MANY);
    if (!EMAIL_RE.test(email)) throw bad('Use your student email, like 12345678@dut4life.ac.za.');
    const u = await getUser(email);
    if (u) return { question: u.question };
    const n = crypto.createHash('sha256').update(email).digest()[0] % QUESTIONS.length;
    return { question: QUESTIONS[n] };
});

route('POST', '/api/auth/reset', { auth: false }, async ({ body, ip }) => {
    const email = String(body.email || '').trim().toLowerCase();
    const key = 'reset:' + ip + ':' + email;
    if (limited(key, 5, 15 * 60e3)) throw new HttpError(429, TOO_MANY);
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128) throw bad('New password must be 8 to 128 characters.');
    const answer = normAnswer(body.answer || '');
    const user = EMAIL_RE.test(email) ? await getUser(email) : null;

    const ok = user && answer ? await checkSecret(answer, user.answerHash) : (await burnTime(answer), false);
    if (!ok) throw bad("That answer doesn't match. Try again.");

    // token_version + 1 logs out any other devices
    await run('UPDATE users SET pass_hash = ?, token_version = token_version + 1 WHERE email = ?', [await hashSecret(body.password), email]);
    hits.delete(key);
    return { ok: true };
});

/* =====================================================================
   STATE
===================================================================== */
route('GET', '/api/state', {}, async ({ user }) => buildState(user));

route('POST', '/api/notifications/read', {}, async ({ user }) => {
    await run('UPDATE notifications SET is_read = 1 WHERE email = ?', [user.email]);
    return { ok: true };
});

/* =====================================================================
   DRIVER
===================================================================== */
route('PUT', '/api/vehicle', { role: 'driver' }, async ({ body, user }) => {
    const b = body.bank && typeof body.bank === 'object' ? body.bank : {};
    const year = Number(body.year), seats = Number(body.seats);
    const plate = clean(body.plate || '').toUpperCase().replace(/\s+/g, ' ');
    const number = String(b.number || '').replace(/\s+/g, '');
    const branch = String(b.branch || '').replace(/\s+/g, '');

    if (!str(body.make, 1, 40)) throw bad("Enter your vehicle's make.");
    if (!str(body.model, 1, 40)) throw bad("Enter your vehicle's model.");
    if (!Number.isInteger(year) || year < 1990 || year > new Date().getFullYear() + 1) throw bad('Enter a valid year.');
    if (!str(body.colour, 1, 30)) throw bad("Enter your vehicle's colour.");
    if (plate.replace(/[^A-Z0-9]/g, '').length < 4 || plate.length > 14) throw bad('Enter your number plate.');
    if (!Number.isInteger(seats) || seats < 1 || seats > 6) throw bad('Passenger seats must be between 1 and 6.');
    if (!BANKS.includes(b.bank)) throw bad('Choose your bank.');
    if (!ACCOUNT_TYPES.includes(b.type)) throw bad('Choose an account type.');
    if (!str(b.holder, 2, 80)) throw bad("Enter the account holder's name.");
    if (!/^\d{6,13}$/.test(number)) throw bad('Account number must be 6 to 13 digits.');
    if (!/^\d{6}$/.test(branch)) throw bad('Branch code must be 6 digits.');

    const values = [clean(body.make), clean(body.model), year, clean(body.colour), plate, seats, b.bank, b.type, clean(b.holder), number, branch];
    await tx(async (c) => {
        const existing = await q1('SELECT email FROM vehicles WHERE email = ? FOR UPDATE', [user.email], c);
        if (existing) {
            await run('UPDATE vehicles SET make = ?, model = ?, vehicle_year = ?, colour = ?, plate = ?, seats = ?, bank_name = ?, account_type = ?, ' +
                'account_holder = ?, account_number = ?, branch_code = ? WHERE email = ?', values.concat([user.email]), c);
        } else {
            await run('INSERT INTO vehicles (make, model, vehicle_year, colour, plate, seats, bank_name, account_type, account_holder, account_number, branch_code, email, registered_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', values.concat([user.email, Date.now()]), c);
        }
    });
    return { ok: true };
});

route('POST', '/api/rides', { role: 'driver' }, async ({ body, user }) => {
    const v = await q1('SELECT seats FROM vehicles WHERE email = ?', [user.email]);
    if (!v) throw bad('Register your vehicle before publishing rides.');
    const maxSeats = Number(v.seats);
    const seats = Number(body.seats), price = Number(body.price);
    const from = clean(body.from || ''), to = clean(body.to || '');

    if (from.length < 2 || from.length > 80 || to.length < 2 || to.length > 80) throw bad('Enter where you are leaving from and going to.');
    if (from.toLowerCase() === to.toLowerCase()) throw bad('Start and destination must be different.');
    if (!validDate(body.date) || body.date < todayStr()) throw bad('Choose today or a future date.');
    if (typeof body.time !== 'string' || !TIME_RE.test(body.time)) throw bad('Choose a departure time.');
    if (rideStart({ date: body.date, time: body.time }) <= new Date()) throw bad('That departure time has already passed.');
    if (!Number.isInteger(seats) || seats < 1 || seats > maxSeats) throw bad('Seats on offer must be between 1 and ' + maxSeats + '.');
    if (!(price >= 1 && price <= 5000)) throw bad('Enter a price per seat.');

    const ride = {
        id: uid(), driver: user.email, from: from, to: to, date: body.date, time: body.time, seats: seats,
        price: Math.round(price * 100) / 100, notes: clean(body.notes || '').slice(0, 120), returnTime: '', createdAt: Date.now()
    };
    // Place the ride on the map. If the lookup fails the ride is still published and is placed later.
    const a = await geocodeAddress(from, 2), b = await geocodeAddress(to, 2);
    await run('INSERT INTO rides (id, driver_email, from_place, to_place, ride_date, ride_time, seats, price, notes, return_time, created_at, from_lat, from_lng, to_lat, to_lng, geo_tried) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        [ride.id, ride.driver, ride.from, ride.to, ride.date, ride.time, ride.seats, ride.price, ride.notes, ride.returnTime, ride.createdAt,
        a ? a.lat : null, a ? a.lng : null, b ? b.lat : null, b ? b.lng : null]);
    return [201, { ride: ride }];
});

route('DELETE', '/api/rides/:id', { role: 'driver' }, async ({ params, user }) => {
    await tx(async (c) => {
        // the ride row is locked, so nobody can book it while we check and delete
        const ride = await q1('SELECT id FROM rides WHERE id = ? AND driver_email = ? FOR UPDATE', [params.id, user.email], c);
        if (!ride) throw new HttpError(404, 'Ride not found.');
        const n = await q1('SELECT COUNT(*) AS n FROM bookings WHERE ride_id = ? AND cancelled = 0', [params.id], c);
        if (Number(n.n) > 0) throw bad('This ride has passengers. You can only remove rides with no bookings.');
        await run('DELETE FROM rides WHERE id = ?', [params.id], c); // cancelled bookings go with it
    });
    return { ok: true };
});

route('POST', '/api/rides/:id/return', { role: 'driver' }, async ({ params, body, user }) => {
    if (typeof body.time !== 'string' || !TIME_RE.test(body.time)) throw bad('Choose a pick-up time.');
    await tx(async (c) => {
        const rr = await q1('SELECT * FROM rides WHERE id = ? AND driver_email = ? FOR UPDATE', [params.id, user.email], c);
        if (!rr) throw new HttpError(404, 'Ride not found.');
        const ride = mapRide(rr);
        await run('UPDATE rides SET return_time = ? WHERE id = ?', [body.time, ride.id], c);
        const passengers = await q('SELECT passenger_email FROM bookings WHERE ride_id = ? AND cancelled = 0', [ride.id], c);
        for (const p of passengers) {
            await notify(c, p.passenger_email, 'Your driver ' + user.name + ' set the afternoon pick-up for ' + ride.from + ' / ' + ride.to + ' on ' + fmtDate(ride.date) + ' at ' + body.time + '.');
        }
    });
    return { ok: true };
});

route('POST', '/api/bookings/:id/confirm', { role: 'driver' }, async ({ params, user }) => {
    await tx(async (c) => {
        const b = await q1('SELECT * FROM bookings WHERE id = ? AND driver_email = ? AND cancelled = 0 FOR UPDATE', [params.id, user.email], c);
        if (!b) throw new HttpError(404, 'Booking not found.');
        if (b.status !== 'eft_pending' && b.status !== 'eft_sent') throw bad('Nothing to confirm on this booking.');
        await run("UPDATE bookings SET status = 'paid' WHERE id = ?", [b.id], c);
        const r = await q1('SELECT from_place, to_place FROM rides WHERE id = ?', [b.ride_id], c) || {};
        await notify(c, b.passenger_email, 'Your EFT for ' + (r.from_place || '') + ' to ' + (r.to_place || '') + ' was confirmed by ' + user.name + '.');
    });
    return { ok: true };
});

/* =====================================================================
   PASSENGER
===================================================================== */
route('POST', '/api/bookings', { role: 'student' }, async ({ body, user }) => {
    if (typeof body.rideId !== 'string') throw new HttpError(404, 'This ride is no longer available.');
    if (!['card', 'eft'].includes(body.method)) throw bad('Choose how you would like to pay.');
    const phone = String(body.phone || '').replace(/\s+/g, '');
    const address = clean(body.address || '');
    if (!PHONE_RE.test(phone)) throw bad('Enter a 10-digit cellphone number, like 082 000 0000.');
    if (address.length < 5 || address.length > 255) throw bad('Enter the address where you should be picked up.');
    const spot = await geocodeAddress(address, 2); // lets drivers nearby find you on their map (only if you allow it)

    return tx(async (c) => {
        // Locking the ride row means two people can never take the last seat at the same time.
        const rr = await q1('SELECT * FROM rides WHERE id = ? FOR UPDATE', [body.rideId], c);
        if (!rr) throw new HttpError(404, 'This ride is no longer available.');
        const ride = mapRide(rr);
        if (rideStart(ride) <= new Date()) throw bad('This ride has already left.');
        if (ride.driver === user.email) throw bad('You cannot book your own ride.');

        const taken = await q1('SELECT COUNT(*) AS n FROM bookings WHERE ride_id = ? AND cancelled = 0', [ride.id], c);
        if (Number(taken.n) >= ride.seats) throw bad('Sorry, this ride just filled up.');
        if (await q1('SELECT id FROM bookings WHERE ride_id = ? AND passenger_email = ? AND cancelled = 0', [ride.id, user.email], c)) throw bad('You have already booked this ride.');
        if (!(await q1('SELECT email FROM vehicles WHERE email = ?', [ride.driver], c))) throw bad('This driver has not finished registering.');

        if (body.method === 'card') {
            const card = await q1('SELECT auto_pay FROM cards WHERE email = ?', [user.email], c);
            if (!(card && card.auto_pay)) throw bad('Add a card with automatic payment switched on, or choose EFT.');
        }

        const booking = {
            id: uid(), rideId: ride.id, passenger: user.email, driver: ride.driver, method: body.method,
            // Card payments are marked paid straight away in this version. Connect a payment gateway here to actually charge the card.
            status: body.method === 'card' ? 'card' : 'eft_pending',
            price: ride.price, phone: phone, address: address, cancelled: false, createdAt: Date.now()
        };
        await run('INSERT INTO bookings (id, ride_id, passenger_email, driver_email, method, status, price, pickup_phone, pickup_address, cancelled, created_at, pickup_lat, pickup_lng, pickup_geo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1)',
            [booking.id, booking.rideId, booking.passenger, booking.driver, booking.method, booking.status, booking.price, booking.phone, booking.address, booking.createdAt,
            spot ? spot.lat : null, spot ? spot.lng : null], c);
        await run("UPDATE ride_offers SET status = 'accepted' WHERE ride_id = ? AND student_email = ? AND status = 'pending'", [ride.id, user.email], c);
        await notify(c, ride.driver, user.name + ' booked a seat on ' + ride.from + ' to ' + ride.to + ' (' + fmtDate(ride.date) + ', ' + ride.time + '). Pickup: ' + address + ', ' + phone + '. Payment: ' + (body.method === 'card' ? 'card, automatic' : 'EFT') + '.');
        return [201, { booking: booking }];
    });
});

route('POST', '/api/bookings/:id/eft-sent', { role: 'student' }, async ({ params, user }) => {
    await tx(async (c) => {
        const b = await q1('SELECT * FROM bookings WHERE id = ? AND passenger_email = ? AND cancelled = 0 FOR UPDATE', [params.id, user.email], c);
        if (!b || b.method !== 'eft') throw new HttpError(404, 'Booking not found.');
        if (b.status !== 'eft_pending') throw bad('This booking is not waiting for an EFT.');
        await run("UPDATE bookings SET status = 'eft_sent' WHERE id = ?", [b.id], c);
        const r = await q1('SELECT from_place, to_place FROM rides WHERE id = ?', [b.ride_id], c) || {};
        await notify(c, b.driver_email, user.name + ' says they paid ' + money(b.price) + ' by EFT for ' + (r.from_place || '') + ' to ' + (r.to_place || '') + '. Please confirm when it arrives.');
    });
    return { ok: true };
});

route('POST', '/api/bookings/:id/cancel', { role: 'student' }, async ({ params, user }) => {
    await tx(async (c) => {
        const b = await q1('SELECT * FROM bookings WHERE id = ? AND passenger_email = ? AND cancelled = 0 FOR UPDATE', [params.id, user.email], c);
        if (!b) throw new HttpError(404, 'Booking not found.');
        const r = await q1('SELECT from_place, to_place, ride_date FROM rides WHERE id = ?', [b.ride_id], c);
        if (r && r.ride_date < todayStr()) throw bad('Past rides cannot be cancelled.');
        await run('UPDATE bookings SET cancelled = 1 WHERE id = ?', [b.id], c);
        await notify(c, b.driver_email, user.name + ' cancelled their seat on ' + (r ? r.from_place + ' to ' + r.to_place + ' (' + fmtDate(r.ride_date) + ')' : 'a ride') + '.');
    });
    return { ok: true };
});

/* ---------- timetable ---------- */
function sniffType(buf) {
    if (buf.slice(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
    return null;
}

route('PUT', '/api/timetable', { role: 'student', max: 3 * 1024 * 1024 }, async ({ body, user }) => {
    const daysIn = body.days && typeof body.days === 'object' ? body.days : {};
    const days = {};
    for (const d of DAYS) {
        const s = daysIn[d] && typeof daysIn[d].start === 'string' ? daysIn[d].start : '';
        const e = daysIn[d] && typeof daysIn[d].end === 'string' ? daysIn[d].end : '';
        if ((s && !TIME_RE.test(s)) || (e && !TIME_RE.test(e))) throw bad(d + ': enter valid times.');
        if ((s && !e) || (!s && e)) throw bad(d + ': enter both a start and an end time, or leave both blank.');
        if (s && e && e <= s) throw bad(d + ': the last class must end after the first one starts.');
        days[d] = { start: s, end: e };
    }
    const hasTimes = DAYS.some((d) => days[d].start);

    // file: undefined = keep what is there, null = remove it, object = replace it
    let file;
    if (body.file === null) {
        file = null;
    } else if (body.file !== undefined) {
        const f = body.file;
        const m = f && typeof f.data === 'string' ? /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(f.data) : null;
        if (!m) throw bad('Could not read that file.');
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > MAX_FILE_BYTES) throw bad('That file is over 1.5 MB. Upload a smaller one.');
        const type = sniffType(buf);
        if (!type) throw bad('Upload a PDF, PNG or JPG file.');
        file = { name: clean(f.name || 'timetable').slice(0, 120) || 'timetable', type: type, size: buf.length, data: buf };
    }

    return tx(async (c) => {
        const existing = await q1('SELECT file_name FROM timetables WHERE email = ? FOR UPDATE', [user.email], c);
        const fileAfter = file === undefined ? !!(existing && existing.file_name) : file !== null;
        if (!hasTimes && !fileAfter) throw bad('Add your class times or upload your timetable.');

        const daysJson = JSON.stringify(days), now = Date.now();
        if (!existing) {
            await run('INSERT INTO timetables (email, days_json, file_name, file_type, file_size, file_data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [user.email, daysJson, file ? file.name : null, file ? file.type : null, file ? file.size : null, file ? file.data : null, now], c);
        } else if (file === undefined) {
            await run('UPDATE timetables SET days_json = ?, updated_at = ? WHERE email = ?', [daysJson, now, user.email], c);
        } else {
            await run('UPDATE timetables SET days_json = ?, file_name = ?, file_type = ?, file_size = ?, file_data = ?, updated_at = ? WHERE email = ?',
                [daysJson, file ? file.name : null, file ? file.type : null, file ? file.size : null, file ? file.data : null, now, user.email], c);
        }

        // tell the drivers this passenger has upcoming rides with
        const drivers = await q('SELECT DISTINCT b.driver_email FROM bookings b JOIN rides r ON r.id = b.ride_id ' +
            'WHERE b.passenger_email = ? AND b.cancelled = 0 AND r.ride_date >= ?', [user.email, todayStr()], c);
        for (const d of drivers) await notify(c, d.driver_email, user.name + ' updated their timetable. Check the day plan for your shared rides.');
        return { ok: true, notified: drivers.length };
    });
});

// A timetable file can be opened by its owner, or by a driver with an active booking from that passenger.
route('GET', '/api/timetable/file/:email', {}, async ({ params, user, res }) => {
    let owner;
    try { owner = decodeURIComponent(params.email).toLowerCase(); } catch (e) { throw bad('Bad request.'); }
    const allowed = owner === user.email ||
        !!(await q1('SELECT id FROM bookings WHERE passenger_email = ? AND driver_email = ? AND cancelled = 0 LIMIT 1', [owner, user.email]));
    const t = allowed ? await q1('SELECT file_name, file_type, file_data FROM timetables WHERE email = ?', [owner]) : null;
    if (!t || !t.file_name || !t.file_data) throw new HttpError(404, 'File not found.');
    const buf = Buffer.from(t.file_data);
    res.writeHead(200, {
        'Content-Type': t.file_type, 'Content-Length': buf.length, 'Cache-Control': 'private, no-store',
        'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(t.file_name), 'X-Content-Type-Options': 'nosniff'
    });
    res.end(buf);
});

/* ---------- card (demo: only non-sensitive details are stored) ---------- */
// The website sends just the brand, last four digits, expiry and name.
// The full card number and CVV never reach this server. To take real payments,
// collect the card with a gateway's hosted fields (PayFast, Yoco, Paystack…)
// and store the token it returns instead.
route('PUT', '/api/card', { role: 'student' }, async ({ body, user }) => {
    const m = /^(\d{2})\/(\d{2})$/.exec(String(body.exp || ''));
    if (!str(body.holder, 2, 60)) throw bad('Enter the name on the card.');
    if (!CARD_BRANDS.includes(body.brand)) throw bad('Card type not recognised.');
    if (!/^\d{4}$/.test(String(body.last4 || ''))) throw bad('Card number not recognised.');
    if (!m || +m[1] < 1 || +m[1] > 12) throw bad('Enter the expiry as MM/YY.');
    const now = new Date();
    if (2000 + +m[2] < now.getFullYear() || (2000 + +m[2] === now.getFullYear() && +m[1] < now.getMonth() + 1)) throw bad('That card has expired.');

    const values = [body.brand, String(body.last4), body.exp, clean(body.holder)];
    await tx(async (c) => {
        const existing = await q1('SELECT email FROM cards WHERE email = ? FOR UPDATE', [user.email], c);
        if (existing) await run('UPDATE cards SET brand = ?, last4 = ?, expiry = ?, holder = ?, auto_pay = 1 WHERE email = ?', values.concat([user.email]), c);
        else await run('INSERT INTO cards (brand, last4, expiry, holder, auto_pay, email) VALUES (?, ?, ?, ?, 1, ?)', values.concat([user.email]), c);
    });
    return { ok: true };
});

route('PATCH', '/api/card', { role: 'student' }, async ({ body, user }) => {
    const card = await q1('SELECT email FROM cards WHERE email = ?', [user.email]);
    if (!card) throw new HttpError(404, 'No card saved.');
    await run('UPDATE cards SET auto_pay = ? WHERE email = ?', [body.auto ? 1 : 0, user.email]);
    return { ok: true };
});

route('DELETE', '/api/card', { role: 'student' }, async ({ user }) => {
    await run('DELETE FROM cards WHERE email = ?', [user.email]);
    return { ok: true };
});

/* =====================================================================
   MAPS AND RIDE INVITATIONS
===================================================================== */
// Turns what the student typed (a suburb, street or campus) into a point on the map.
route('GET', '/api/geocode', {}, async ({ url, user }) => {
    if (limited('geo:' + user.email, 40, 60e3)) throw new HttpError(429, TOO_MANY);
    const text = clean(url.searchParams.get('q') || '');
    if (text.length < 2 || text.length > 120) throw bad('Type a place or suburb to search for.');
    const hit = await geocodeAddress(text, 2);
    if (!hit) throw new HttpError(404, 'We could not find that place. Try adding the suburb, like "Overport".');
    return { lat: hit.lat, lng: hit.lng, label: hit.label };
});

// Student map: upcoming rides with free seats that leave from near the area the student entered.
route('GET', '/api/map/rides', { role: 'student' }, async ({ url, user }) => {
    const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'));
    if (!inSA(lat, lng)) throw bad('Choose a place in South Africa.');
    const radius = clampKm(url.searchParams.get('radius'), 10);
    const date = url.searchParams.get('date') || '';
    if (date && !validDate(date)) throw bad('Choose a valid date.');

    const params = [user.email, todayStr(), user.email].concat(date ? [date] : []);
    const rows = await q("SELECT r.*, u.name AS driver_name, v.make, v.model, v.colour, " +
        "(SELECT COUNT(*) FROM bookings b WHERE b.ride_id = r.id AND b.cancelled = 0) AS booked, " +
        "(SELECT COUNT(*) FROM bookings b WHERE b.ride_id = r.id AND b.passenger_email = ? AND b.cancelled = 0) AS mine " +
        "FROM rides r JOIN users u ON u.email = r.driver_email JOIN vehicles v ON v.email = r.driver_email " +
        "WHERE r.ride_date >= ? AND r.driver_email <> ? AND u.status <> 'suspended'" + (date ? ' AND r.ride_date = ?' : '') +
        ' ORDER BY r.ride_date, r.ride_time LIMIT 300', params);
    await fillRideCoords(rows);

    const now = new Date(), out = [];
    for (const r of rows) {
        if (r.from_lat == null || rideStart(mapRide(r)) <= now) continue;
        const left = Number(r.seats) - Number(r.booked);
        if (left <= 0) continue;
        const km = distKm(lat, lng, r.from_lat, r.from_lng);
        if (km > radius) continue;
        out.push({
            id: r.id, driverName: r.driver_name, car: r.colour + ' ' + r.make + ' ' + r.model, from: r.from_place, to: r.to_place,
            date: r.ride_date, time: r.ride_time, seats: Number(r.seats), left: left, price: Number(r.price), notes: r.notes,
            lat: r.from_lat, lng: r.from_lng, km: Math.round(km * 10) / 10, booked: Number(r.mine) > 0
        });
    }
    out.sort((a, b) => a.km - b.km || (a.date + a.time).localeCompare(b.date + b.time));
    return { rides: out };
});

// The driver's upcoming rides, with how many seats are left and where they start.
async function driverUpcoming(email) {
    const rows = await q('SELECT r.*, (SELECT COUNT(*) FROM bookings b WHERE b.ride_id = r.id AND b.cancelled = 0) AS booked ' +
        'FROM rides r WHERE r.driver_email = ? AND r.ride_date >= ? ORDER BY r.ride_date, r.ride_time', [email, todayStr()]);
    const now = new Date();
    const up = rows.filter((r) => rideStart(mapRide(r)) > now);
    await fillRideCoords(up);
    return up;
}

// Driver map: students whose earlier pick-up spots are close to where the driver starts.
route('GET', '/api/map/students', { role: 'driver' }, async ({ url, user }) => {
    const radius = clampKm(url.searchParams.get('radius'), 5);
    const rideId = url.searchParams.get('rideId') || '';
    const up = await driverUpcoming(user.email);
    if (rideId && !up.some((r) => r.id === rideId)) throw new HttpError(404, 'Ride not found.');

    const anchors = up.filter((r) => (!rideId || r.id === rideId) && r.from_lat != null).map((r) => ({ id: r.id, lat: r.from_lat, lng: r.from_lng }));
    const people = await nearbyStudents(user.email, anchors, radius);

    const emails = people.map((p) => p.email);
    const busy = new Map(); // student -> ride ids that already have a booking or an invitation
    if (emails.length) {
        const ids = up.map((r) => r.id);
        const held = ids.length ? await q("SELECT ride_id, passenger_email AS email FROM bookings WHERE cancelled = 0 AND ride_id IN (?) AND passenger_email IN (?) " +
            "UNION SELECT ride_id, student_email AS email FROM ride_offers WHERE status IN ('pending','accepted') AND ride_id IN (?) AND student_email IN (?)", [ids, emails, ids, emails]) : [];
        held.forEach((h) => { if (!busy.has(h.email)) busy.set(h.email, new Set()); busy.get(h.email).add(h.ride_id); });
    }

    const students = people.map((p) => ({
        id: studentId(p.email), name: p.name.split(' ')[0], lat: p.lat, lng: p.lng, km: Math.round(p.best.d * 10) / 10,
        ride: p.best.ride, near: [...p.near], trips: p.trips, last: p.last, blocked: [...(busy.get(p.email) || [])]
    })).sort((a, b) => a.km - b.km);

    return {
        rides: up.map((r) => ({
            id: r.id, from: r.from_place, to: r.to_place, date: r.ride_date, time: r.ride_time, price: Number(r.price),
            left: Number(r.seats) - Number(r.booked), lat: r.from_lat, lng: r.from_lng
        })),
        students: students
    };
});

// A driver invites a nearby student to one of their rides. The student gets a notification and can book from it.
route('POST', '/api/offers', { role: 'driver' }, async ({ body, user }) => {
    if (limited('offer:' + user.email, 30, 3600e3)) throw new HttpError(429, 'You have sent a lot of invitations. Please wait a while before sending more.');
    if (typeof body.studentId !== 'string' || typeof body.rideId !== 'string') throw bad('Choose a rider and a ride.');
    const note = clean(body.note || '').slice(0, 150);

    const up = await driverUpcoming(user.email);
    const rr = up.find((r) => r.id === body.rideId);
    if (!rr) throw bad('Choose one of your upcoming rides.');
    if (Number(rr.seats) - Number(rr.booked) <= 0) throw bad('That ride is already full.');
    if (rr.from_lat == null) throw bad('We could not place that ride on the map. Republish it with a clearer starting point.');

    const people = await nearbyStudents(user.email, [{ id: rr.id, lat: rr.from_lat, lng: rr.from_lng }], clampKm(body.radius, 10));
    const s = people.find((p) => studentId(p.email) === body.studentId);
    if (!s) throw bad('That rider is no longer near this ride.');
    if (await q1('SELECT id FROM bookings WHERE ride_id = ? AND passenger_email = ? AND cancelled = 0', [rr.id, s.email])) throw bad('They have already booked this ride.');

    const v = await q1('SELECT make, model, colour FROM vehicles WHERE email = ?', [user.email]) || {};
    const ride = mapRide(rr);
    await tx(async (c) => {
        try {
            await run('INSERT INTO ride_offers (id, ride_id, driver_email, student_email, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [uid(), ride.id, user.email, s.email, note, 'pending', Date.now()], c);
        } catch (err) {
            if (err && err.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'You have already messaged them about this ride.');
            throw err;
        }
        await notify(c, s.email, user.name + ' (' + [v.colour, v.make, v.model].filter(Boolean).join(' ') + ') invited you to ride ' + ride.from + ' to ' + ride.to + ' on ' +
            fmtDate(ride.date) + ' at ' + ride.time + ' for ' + money(ride.price) + ' a seat.' + (note ? ' "' + note + '"' : '') + ' Open Find a ride to book it.');
    });
    return [201, { ok: true }];
});

route('POST', '/api/offers/:id/decline', { role: 'student' }, async ({ params, user }) => {
    const r = await run("UPDATE ride_offers SET status = 'declined' WHERE id = ? AND student_email = ? AND status = 'pending'", [params.id, user.email]);
    if (!r.affectedRows) throw new HttpError(404, 'Invitation not found.');
    return { ok: true };
});

// Students choose whether drivers can find them on the driver map.
route('PUT', '/api/discoverable', { role: 'student' }, async ({ body, user }) => {
    await run('UPDATE users SET discoverable = ? WHERE email = ?', [body.on ? 1 : 0, user.email]);
    return { ok: true };
});

/* =====================================================================
   ADMIN
===================================================================== */
route('GET', '/api/admin/overview', { role: 'admin' }, async () => {
    const driverRows = await q(
        "SELECT u.email, u.name, u.phone, u.status, u.created_at, v.make, v.model, v.plate, " +
        "(SELECT AVG(rating) FROM reviews WHERE driver_email = u.email) AS avg_rating, " +
        "(SELECT COUNT(*) FROM reviews WHERE driver_email = u.email) AS review_count, " +
        "(SELECT COUNT(*) FROM rides WHERE driver_email = u.email) AS ride_count, " +
        "(SELECT COUNT(*) FROM reviews WHERE driver_email = u.email AND rating <= 2) AS low_count, " +
        "(SELECT COUNT(*) FROM warnings WHERE email = u.email) AS warn_count " +
        "FROM users u LEFT JOIN vehicles v ON v.email = u.email WHERE u.role = 'driver' ORDER BY u.created_at, u.email");
    const drivers = driverRows.map((d, i) => ({
        id: 'D' + String(i + 1).padStart(3, '0'), email: d.email, name: d.name, phone: d.phone, status: d.status || 'active',
        rating: d.avg_rating === null ? null : Math.round(Number(d.avg_rating) * 10) / 10, reviews: Number(d.review_count),
        rides: Number(d.ride_count), low: Number(d.low_count), warns: Number(d.warn_count), car: d.make ? d.make + ' ' + d.model + ' (' + d.plate + ')' : '', joined: Number(d.created_at)
    }));
    const students = (await q(
        "SELECT u.email, u.name, u.phone, u.created_at, " +
        "(SELECT COUNT(*) FROM bookings WHERE passenger_email = u.email AND cancelled = 0) AS booking_count " +
        "FROM users u WHERE u.role = 'student' ORDER BY u.name")).map((s2) => ({
            email: s2.email, name: s2.name, phone: s2.phone, studentNo: s2.email.split('@')[0],
            bookings: Number(s2.booking_count), joined: Number(s2.created_at)
        }));
    const reviews = (await q(
        "SELECT r.rating, r.comment, r.created_at, d.name AS driver_name, p.name AS reviewer_name " +
        "FROM reviews r JOIN users d ON d.email = r.driver_email JOIN users p ON p.email = r.reviewer_email " +
        "ORDER BY r.created_at DESC LIMIT 10")).map((r) => ({
            driver: r.driver_name, reviewer: r.reviewer_name, rating: Number(r.rating), comment: r.comment, at: Number(r.created_at)
        }));
    const warnings = (await q(
        "SELECT w.title, w.detail, w.created_at, u.name, u.role FROM warnings w JOIN users u ON u.email = w.email " +
        "ORDER BY w.created_at DESC LIMIT 10")).map((w) => ({
            title: w.title, detail: w.detail, name: w.name, role: w.role, at: Number(w.created_at)
        }));
    return { drivers: drivers, students: students, reviews: reviews, warnings: warnings };
});

route('POST', '/api/admin/drivers/status', { role: 'admin' }, async ({ body }) => {
    const email = String(body.email || '').trim().toLowerCase();
    if (!['active', 'suspended'].includes(body.status)) throw bad('Choose Active or Suspended.');
    const d = await q1("SELECT email, name FROM users WHERE email = ? AND role = 'driver'", [email]);
    if (!d) throw bad('Driver not found.');
    await tx(async (c) => {
        // token_version + 1 signs the driver out of any device they are already logged in on
        await run('UPDATE users SET status = ?, token_version = token_version + 1 WHERE email = ?', [body.status, email], c);
        await run('INSERT INTO warnings (id, email, title, detail, created_at) VALUES (?, ?, ?, ?, ?)',
            [uid(), email, body.status === 'suspended' ? 'Driver suspended' : 'Driver reinstated',
            body.status === 'suspended' ? 'Account suspended by an administrator.' : 'Account reactivated by an administrator.', Date.now()], c);
    });
    return { ok: true };
});

// An admin warns a driver whose reviews are poor. The driver is also notified.
route('POST', '/api/admin/warnings', { role: 'admin' }, async ({ body }) => {
    const email = String(body.email || '').trim().toLowerCase();
    const d = await q1("SELECT email FROM users WHERE email = ? AND role = 'driver'", [email]);
    if (!d) throw bad('Driver not found.');
    const s = await q1('SELECT AVG(rating) AS avg, COUNT(*) AS n, SUM(rating <= 2) AS low FROM reviews WHERE driver_email = ?', [email]);
    if (!Number(s.n)) throw bad('This driver has no reviews to base a warning on.');
    const note = clean(body.note || '').slice(0, 100);
    const detail = ('Poor reviews: average ' + Number(s.avg).toFixed(1) + ' from ' + Number(s.n) + ' reviews (' +
        Number(s.low) + ' rated 1-2 stars).' + (note ? ' ' + note : '')).slice(0, 255);
    await tx(async (c) => {
        await run('INSERT INTO warnings (id, email, title, detail, created_at) VALUES (?, ?, ?, ?, ?)',
            [uid(), email, 'Warning: poor reviews', detail, Date.now()], c);
        await notify(c, email, 'Warning from UniLift: ' + detail + ' Please improve, or your account may be suspended.');
    });
    return { ok: true };
});

/* =====================================================================
   STATIC FILES + SERVER
===================================================================== */
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.webp': 'image/webp', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
        "font-src https://fonts.gstatic.com; img-src 'self' data: https://tile.openstreetmap.org https://cdnjs.cloudflare.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch (e) { throw bad('Bad request.'); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    const hidden = path.relative(PUBLIC_DIR, file).split(path.sep).some((p) => p.startsWith('.'));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || hidden) throw new HttpError(403, 'Forbidden.');

    let stat, target = file;
    try { stat = fs.statSync(file); } catch (e) { stat = null; }
    if ((!stat || !stat.isFile()) && !path.extname(file)) { // clean links: /login opens login.html
        try { const alt = fs.statSync(file + '.html'); if (alt.isFile()) { stat = alt; target = file + '.html'; } } catch (e) { /* not found */ }
    }
    if (!stat || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Page not found. Go back to the home page: /');
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': ext === '.html' || ext === '.js' ? 'no-cache' : 'public, max-age=3600'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
    try {
        securityHeaders(res);
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/healthz') {
            try { await db.ping(); return sendJson(res, 200, { ok: true, database: 'up' }); }
            catch (e) { return sendJson(res, 503, { ok: false, database: 'down' }); }
        }
        if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
        return serveStatic(req, res, url.pathname);
    } catch (err) {
        if (res.headersSent) return res.end();
        if (err instanceof HttpError) {
            if (err.status === 413) res.setHeader('Connection', 'close');
            return sendJson(res, err.status, { error: err.message });
        }
        console.error(err);
        return sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.' });
    }
});

async function shutdown() {
    server.close();
    try { await db.end(); } catch (e) { /* already closed */ }
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
    try {
        await db.init();
        SECRET = await loadSecret();
    } catch (err) {
        console.error('\nUniLift could not start.\n' + db.describeError(err) + '\n');
        process.exit(1);
    }
    server.listen(PORT, HOST, () => {
        console.log('UniLift is running at http://localhost:' + PORT + '  (database: ' + db.DB_NAME + ')');
    });
})();