'use strict';

/* ---------------------------------------------------------------------
   Adds fake past rides, bookings and reviews for the drivers already in
   the database (run scripts/seed.js first).

   Reviews only come from students who really have a booking on that
   driver's ride. Warnings are only given (by an "admin") to drivers whose
   reviews are poor, and the worst-reviewed warned driver is suspended.

     node scripts/seed-admin-data.js

   TEST DATA ONLY. Each run adds another batch.
--------------------------------------------------------------------- */

const crypto = require('crypto');
const db = require('../db');
const { q, run, tx } = db;

const uid = () => crypto.randomBytes(8).toString('hex');
const int = (n) => crypto.randomInt(n);
const pick = (a) => a[int(a.length)];
const pad = (n) => String(n).padStart(2, '0');
const DAY = 86400000;

// Every ride starts or ends at a campus. No suburb-to-suburb rides.
const CAMPUSES = ['DUT Steve Biko Campus', 'DUT Ritson Campus', 'DUT ML Sultan Campus'];
const AREAS = ['Berea', 'Umlazi', 'Pinetown', 'Chatsworth', 'Umhlanga', 'Westville', 'Overport', 'Phoenix', 'Amanzimtoti'];
const STREETS = ['Main Road', 'Church Street', 'Jan Smuts Highway', 'Old Dutch Road', 'Sparks Road', 'Bluff Road'];

const GOOD = ['Always on time and very friendly. Great driver!', 'Smooth ride, highly recommend!', 'Clean car and safe driving.',
    'Picked me up right on time.', 'Very polite, will ride again.', 'Great music and a comfortable trip.'];
const OK = ['Good ride, but was a bit late.', 'Fine trip, car was a bit warm.', 'Okay overall, took a longer route.'];
const BAD = ['Arrived very late and did not message.', 'Drove too fast for my comfort.'];

(async () => {
    try { await db.init(); } catch (err) { console.error(db.describeError(err)); process.exit(1); }

    const drivers = await q(
        "SELECT u.email, u.name, v.seats FROM users u JOIN vehicles v ON v.email = u.email WHERE u.role = 'driver' AND u.email NOT LIKE '1000000%'");
    const students = await q("SELECT email, phone FROM users WHERE role = 'student'");
    if (!drivers.length || !students.length) {
        console.error('Need at least one driver (with a vehicle) and one student. Run scripts/seed.js first.');
        await db.end(); process.exit(1);
    }

    const counts = { rides: 0, bookings: 0, reviews: 0, warnings: 0 };
    const ratingsBy = new Map(); // driver email -> list of ratings

    await tx(async (c) => {
        const now = Date.now();

        for (const d of drivers) {
            // Most drivers are good; the first one is always poor so the dashboard has a warning to show.
            const bias = drivers.length > 2 && d === drivers[0] ? 9 : int(10);
            ratingsBy.set(d.email, []);
            const rideCount = 3 + int(3);

            for (let i = 0; i < rideCount; i++) {
                const when = new Date(now - (2 + int(90)) * DAY);
                const date = when.getFullYear() + '-' + pad(when.getMonth() + 1) + '-' + pad(when.getDate());
                const time = pad(6 + int(13)) + ':' + pick(['00', '15', '30', '45']);
                const toCampus = int(2) === 0; // half the rides go to campus, half leave from it
                const campus = pick(CAMPUSES), area = pick(AREAS);
                const from = toCampus ? area : campus;
                const to = toCampus ? campus : area;
                const seats = Number(d.seats);
                const price = 20 + int(13) * 5;
                const rideId = uid();

                await run('INSERT INTO rides (id, driver_email, from_place, to_place, ride_date, ride_time, seats, price, notes, return_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [rideId, d.email, from, to, date, time, seats, price, '', '', when.getTime() - DAY], c);
                counts.rides++;

                // Book some different students onto this ride.
                const shuffled = students.slice().sort(() => crypto.randomInt(3) - 1);
                const riders = shuffled.slice(0, 1 + int(Math.min(seats, students.length)));

                for (const s of riders) {
                    await run('INSERT INTO bookings (id, ride_id, passenger_email, driver_email, method, status, price, pickup_phone, pickup_address, cancelled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
                        [uid(), rideId, s.email, d.email, pick(['card', 'eft']), 'paid', price, s.phone,
                        (1 + int(200)) + ' ' + pick(STREETS) + ', ' + area, when.getTime() - DAY], c);
                    counts.bookings++;

                    // About 8 in 10 passengers leave a review, after the ride.
                    if (int(10) < 8) {
                        const rating = bias < 7 ? 4 + int(2) : bias < 9 ? 3 + int(2) : 1 + int(3);
                        const comment = rating >= 5 ? pick(GOOD) : rating >= 3 ? pick(OK) : pick(BAD);
                        await run('INSERT INTO reviews (id, driver_email, reviewer_email, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                            [uid(), d.email, s.email, rating, comment, when.getTime() + DAY], c);
                        ratingsBy.get(d.email).push(rating);
                        counts.reviews++;
                    }
                }
            }
        }

        // Warnings go only to drivers with enough reviews and a low average.
        let worst = null;
        for (const d of drivers) {
            const r = ratingsBy.get(d.email);
            if (r.length < 3) continue;
            const avg = r.reduce((x, y) => x + y, 0) / r.length;
            if (avg >= 3.5) continue;
            const low = r.filter((x) => x <= 2).length;
            await run('INSERT INTO warnings (id, email, title, detail, created_at) VALUES (?, ?, ?, ?, ?)',
                [uid(), d.email, 'Warning: poor reviews',
                'Poor reviews: average ' + avg.toFixed(1) + ' from ' + r.length + ' reviews (' + low + ' rated 1-2 stars).',
                now - (1 + int(30)) * DAY], c);
            counts.warnings++;
            if (!worst || avg < worst.avg) worst = { email: d.email, avg: avg };
        }

        // The worst-reviewed driver who was warned is suspended.
        if (worst) {
            await run("UPDATE users SET status = 'suspended' WHERE email = ?", [worst.email], c);
            await run('INSERT INTO warnings (id, email, title, detail, created_at) VALUES (?, ?, ?, ?, ?)',
                [uid(), worst.email, 'Driver suspended', 'Suspended after repeated poor reviews.', now - DAY], c);
            counts.warnings++;
            console.log('Suspended: ' + worst.email);
        }
    });

    console.log('Added ' + counts.rides + ' past rides, ' + counts.bookings + ' bookings, ' +
        counts.reviews + ' reviews and ' + counts.warnings + ' warnings.');
    await db.end();
})().catch(async (err) => {
    console.error('Failed, nothing was saved.\n', err);
    try { await db.end(); } catch (e) { /* ignore */ }
    process.exit(1);
});