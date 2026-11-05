'use strict';

/* ---------------------------------------------------------------------
   Adds test data for the two maps:
     - drivers with vehicles and UPCOMING rides (some with seats already taken),
       placed at real Durban suburbs, so students see drivers on their map;
     - students with PAST bookings whose pick-up spots are near those drivers,
       so drivers see students on their rider map.

   Put this file in the scripts/ folder, then (with the server stopped):

     node scripts/seed-map-data.js                       (8 drivers, 24 students)
     node scripts/seed-map-data.js --drivers 12 --students 40
     node scripts/seed-map-data.js --remove              (deletes everything this script added)

   - Needs no internet: coordinates are written straight into the database.
   - Every account uses the same password and security answer, printed at the end.
   - Accounts look like 3999xxxx@dut4life.ac.za, which is how --remove finds them.
   - TEST DATA ONLY: do not run this on a live site.
--------------------------------------------------------------------- */

const crypto = require('crypto');
const db = require('../db');
const { q, run, tx } = db;

const PASSWORD = 'Password123!';
const QUESTION = 'What was your childhood nickname?';
const ANSWER = 'unilift';
const EMAIL_LIKE = '3999____@dut4life.ac.za';
const DAY = 86400000;

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    const n = i > -1 ? Number(process.argv[i + 1]) : fallback;
    return Number.isInteger(n) && n >= 0 && n <= 200 ? n : fallback;
}
const DRIVERS = arg('drivers', 8);
const STUDENTS = arg('students', 24);

/* ---------- where things are (approximate centres, latitude / longitude) ---------- */
const AREAS = {
    'Overport': [-29.8367, 30.9900], 'Berea': [-29.8500, 30.9950], 'Glenwood': [-29.8730, 30.9800],
    'Umlazi': [-29.9700, 30.8850], 'Chatsworth': [-29.9200, 30.8830], 'Pinetown': [-29.8100, 30.8600],
    'Phoenix': [-29.7010, 31.0130], 'Umhlanga': [-29.7270, 31.0850], 'Isipingo': [-29.9990, 30.9300],
    'Amanzimtoti': [-30.0530, 30.8790], 'Kwamashu': [-29.7500, 30.9800], 'Westville': [-29.8330, 30.9250],
    'Morningside': [-29.8300, 31.0080], 'Bluff': [-29.9270, 31.0000]
};
const CAMPUSES = { 'Steve Biko Campus': [-29.8531, 30.9791], 'ML Sultan Campus': [-29.8578, 31.0105], 'Ritson Campus': [-29.8536, 30.9891] };
const STREETS = ['Main Road', 'Church Street', 'Old Dutch Road', 'Sparks Road', 'Jan Smuts Highway', 'Bluff Road', 'Ridge Road', 'Umgeni Road', 'Bellair Road'];

const FIRST = ['Sipho', 'Thandi', 'Lwazi', 'Nomvula', 'Ayanda', 'Zanele', 'Bongani', 'Nokuthula', 'Thabo', 'Lerato',
    'Siyabonga', 'Palesa', 'Mpho', 'Naledi', 'Sibusiso', 'Busisiwe', 'Kabelo', 'Ntombi', 'Themba', 'Precious',
    'Rohan', 'Priya', 'Kyle', 'Megan', 'Yusuf', 'Fatima', 'Devan', 'Ashleigh', 'Mohamed', 'Kiara'];
const LAST = ['Dlamini', 'Zulu', 'Ndlovu', 'Khumalo', 'Mthembu', 'Naidoo', 'Pillay', 'Govender', 'Mkhize', 'Cele',
    'Ngcobo', 'Sithole', 'Nxumalo', 'Shange', 'Mbatha', 'Botha', 'Patel', 'Moodley', 'Chetty', 'Hadebe',
    'Smith', 'Jacobs', 'Abrahams', 'Buthelezi', 'Majola'];
const CARS = [['Toyota', 'Corolla'], ['Toyota', 'Etios'], ['Volkswagen', 'Polo'], ['Volkswagen', 'Polo Vivo'], ['Suzuki', 'Swift'],
['Hyundai', 'i10'], ['Kia', 'Picanto'], ['Renault', 'Kwid'], ['Ford', 'Figo'], ['Nissan', 'Micra']];
const COLOURS = ['White', 'Silver', 'Black', 'Grey', 'Red', 'Blue', 'Green'];
const BANKS = { 'ABSA': '632005', 'Capitec': '470010', 'FNB': '250655', 'Nedbank': '198765', 'Standard Bank': '051001', 'TymeBank': '678910' };
const ACCOUNT_TYPES = ['Cheque / Current', 'Savings', 'Transmission'];
const NOTES = ['Leaves from the shopping centre parking', 'Space for a bag or two', 'Music on, AC on', 'Can wait 5 minutes', 'Non-smoking car', ''];

const int = (n) => crypto.randomInt(n);
const pick = (a) => a[int(a.length)];
const digits = (n) => Array.from({ length: n }, () => int(10)).join('');
const jitter = (base, spread) => base + ((int(2000001) / 1000000) - 1) * spread; // base +/- spread degrees (0.01 is about 1 km)
const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const daysFromNow = (n) => dateStr(new Date(Date.now() + n * DAY));
const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = int(i + 1);[b[i], b[j]] = [b[j], b[i]]; } return b; };
const uid = () => crypto.randomBytes(8).toString('hex');

function hashSecret(value) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16);
        crypto.scrypt(value, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) =>
            err ? reject(err) : resolve(salt.toString('hex') + ':' + key.toString('hex')));
    });
}

(async () => {
    try { await db.init(); } catch (err) { console.error(db.describeError(err)); process.exit(1); }

    if (process.argv.includes('--remove')) {
        const r = await run('DELETE FROM users WHERE email LIKE ?', [EMAIL_LIKE]);
        console.log('Removed ' + r.affectedRows + ' test account(s) and their rides, bookings and invitations.');
        await db.end();
        return;
    }

    const taken = new Set((await q('SELECT email FROM users')).map((r) => r.email));
    const newEmail = () => { for (; ;) { const e = '3999' + digits(4) + '@dut4life.ac.za'; if (!taken.has(e)) { taken.add(e); return e; } } };
    const passHash = await hashSecret(PASSWORD), answerHash = await hashSecret(ANSWER);
    const areaNames = Object.keys(AREAS);
    const drivers = [], students = [];
    const counts = { rides: 0, bookings: 0 };

    await tx(async (c) => {
        const now = Date.now();
        const areaOrder = shuffle(areaNames);

        /* ----- drivers, vehicles and their rides ----- */
        for (let i = 0; i < DRIVERS; i++) {
            const email = newEmail(), name = pick(FIRST) + ' ' + pick(LAST), area = areaOrder[i % areaOrder.length];
            const [make, model] = pick(CARS), bank = pick(Object.keys(BANKS)), seats = 3 + int(2);
            await run('INSERT INTO users (email, name, phone, role, pass_hash, question, answer_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
                [email, name, '0' + pick(['6', '7', '8']) + digits(8), 'driver', passHash, QUESTION, answerHash, now - (5 + int(60)) * DAY], c);
            await run('INSERT INTO vehicles (email, make, model, vehicle_year, colour, plate, seats, bank_name, account_type, account_holder, account_number, branch_code, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [email, make, model, 2012 + int(14), pick(COLOURS), 'ND ' + digits(3) + '-' + digits(3), seats, bank, pick(ACCOUNT_TYPES), name, digits(10), BANKS[bank], now], c);
            const d = { email: email, name: name, area: area, seats: seats, past: [], future: [] };
            drivers.push(d);

            const addRide = async (date, list) => {
                const campus = pick(Object.keys(CAMPUSES));
                const [lat, lng] = AREAS[area], [tLat, tLng] = CAMPUSES[campus];
                const ride = { id: uid(), date: date, booked: 0, seats: seats };
                await run('INSERT INTO rides (id, driver_email, from_place, to_place, ride_date, ride_time, seats, price, notes, return_time, created_at, from_lat, from_lng, to_lat, to_lng, geo_tried) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
                    [ride.id, email, area, campus, date, pad(6 + int(3)) + ':' + pick(['00', '15', '30', '45']), seats, 20 + int(5) * 5, pick(NOTES), '', now - int(5) * DAY,
                    jitter(lat, 0.004), jitter(lng, 0.004), tLat, tLng], c);
                list.push(ride); counts.rides++;
            };
            for (const n of shuffle([1, 2, 3, 4, 5, 6, 7]).slice(0, 2 + int(2))) await addRide(daysFromNow(n), d.future);   // upcoming
            for (const n of shuffle([2, 4, 7, 9, 12, 16, 21, 28, 35]).slice(0, 3)) await addRide(daysFromNow(-n), d.past);   // history
        }

        /* ----- students: past pick-ups near the drivers, so drivers can find them ----- */
        const driverAreas = [...new Set(drivers.map((d) => d.area))];
        const book = async (ride, driver, student, when, spot) => {
            const method = pick(['card', 'eft']);
            await run('INSERT INTO bookings (id, ride_id, passenger_email, driver_email, method, status, price, pickup_phone, pickup_address, cancelled, created_at, pickup_lat, pickup_lng, pickup_geo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1)',
                [uid(), ride.id, student.email, driver.email, method, method === 'card' ? 'card' : 'paid', 25, student.phone, spot.address, when, spot.lat, spot.lng], c);
            ride.booked++; counts.bookings++;
        };
        for (let i = 0; i < STUDENTS && drivers.length; i++) {
            const email = newEmail(), name = pick(FIRST) + ' ' + pick(LAST), area = pick(driverAreas);
            const student = { email: email, name: name, area: area, phone: '0' + pick(['6', '7', '8']) + digits(8) };
            await run('INSERT INTO users (email, name, phone, role, pass_hash, question, answer_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
                [email, name, student.phone, 'student', passHash, QUESTION, answerHash, now - (5 + int(60)) * DAY], c);
            students.push(student);

            const local = drivers.filter((d) => d.area === area);
            const spot = () => ({
                lat: jitter(AREAS[area][0], 0.012), lng: jitter(AREAS[area][1], 0.012),
                address: (1 + int(120)) + ' ' + pick(STREETS) + ', ' + area
            });
            const pastRides = shuffle(local.flatMap((d) => d.past.map((r) => ({ r: r, d: d })))).filter((x) => x.r.booked < x.r.seats);
            for (const x of pastRides.slice(0, 1 + int(3))) {
                const daysAgo = Math.max(1, Math.round((new Date(dateStr(new Date())) - new Date(x.r.date)) / DAY));
                await book(x.r, x.d, student, now - daysAgo * DAY - 3600000, spot());
            }
        }

        /* ----- fill some seats on upcoming rides (always leaving at least one free) ----- */
        for (const d of drivers) {
            const locals = students.filter((s) => s.area === d.area);
            for (const r of d.future) {
                const take = Math.min(int(d.seats), locals.length); // 0 .. seats-1
                for (const s of shuffle(locals).slice(0, take)) {
                    await book(r, d, s, now - int(3) * DAY, { lat: jitter(AREAS[d.area][0], 0.01), lng: jitter(AREAS[d.area][1], 0.01), address: (1 + int(120)) + ' ' + pick(STREETS) + ', ' + d.area });
                }
            }
        }
    });

    console.log('Added ' + drivers.length + ' drivers, ' + students.length + ' students, ' + counts.rides + ' rides and ' + counts.bookings + ' bookings.');
    console.log('Password for all of them: ' + PASSWORD + '   Security answer: ' + ANSWER + '\n');
    console.log('DRIVERS (log in as one to see the Rider map):');
    drivers.forEach((d) => console.log('  ' + d.email + '   ' + d.name.padEnd(22) + ' starts in ' + d.area + ', ' + d.seats + ' seats'));
    console.log('\nSTUDENTS (log in as one, open Driver map, search their area):');
    students.slice(0, 6).forEach((s) => console.log('  ' + s.email + '   ' + s.name.padEnd(22) + ' ' + s.area));
    console.log('\nTip: on the student map, type one of these areas: ' + [...new Set(drivers.map((d) => d.area))].join(', ') + '.');
    await db.end();
})().catch(async (err) => {
    console.error('Seeding failed, nothing was saved.\n', err);
    try { await db.end(); } catch (e) { /* ignore */ }
    process.exit(1);
});

