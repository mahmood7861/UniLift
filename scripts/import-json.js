'use strict';

/* ---------------------------------------------------------------------
   One-time import of the OLD version's data (data/db.json) into MySQL.
   Only needed if you already collected real accounts with the file-based
   version. Usage:

     npm run import-json
     npm run import-json -- path/to/db.json

   It refuses to run if the users table already has people in it.
--------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { q1, run, tx } = db;

const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'db.json'));
const filesDir = path.join(path.dirname(file), 'files');
const fileKey = (email) => crypto.createHash('sha256').update(email).digest('hex').slice(0, 32);

(async () => {
  if (!fs.existsSync(file)) { console.error('Cannot find ' + file); process.exit(1); }
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));

  try { await db.init(); } catch (err) { console.error(db.describeError(err)); process.exit(1); }

  const existing = await q1('SELECT COUNT(*) AS n FROM users');
  if (Number(existing.n) > 0) {
    console.error('The MySQL database already has users in it, so nothing was imported.');
    await db.end(); process.exit(1);
  }

  const counts = { users: 0, vehicles: 0, rides: 0, bookings: 0, cards: 0, timetables: 0, notifications: 0 };
  const users = old.users || {};

  await tx(async (c) => {
    for (const u of Object.values(users)) {
      await run('INSERT INTO users (email, name, phone, role, pass_hash, question, answer_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [u.email, u.name, u.phone, u.role, u.passHash, u.question, u.answerHash, u.tokenVersion || 0, u.createdAt || Date.now()], c);
      counts.users++;
    }
    for (const [email, v] of Object.entries(old.vehicles || {})) {
      if (!users[email] || !v.bank) continue;
      await run('INSERT INTO vehicles (email, make, model, vehicle_year, colour, plate, seats, bank_name, account_type, account_holder, account_number, branch_code, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [email, v.make, v.model, v.year, v.colour, v.plate, v.seats, v.bank.bank, v.bank.type, v.bank.holder, v.bank.number, v.bank.branch, v.registeredAt || Date.now()], c);
      counts.vehicles++;
    }
    const rideIds = new Set();
    for (const r of old.rides || []) {
      if (!users[r.driver]) continue;
      await run('INSERT INTO rides (id, driver_email, from_place, to_place, ride_date, ride_time, seats, price, notes, return_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [r.id, r.driver, r.from, r.to, r.date, r.time, r.seats, r.price, r.notes || '', r.returnTime || '', r.createdAt || Date.now()], c);
      rideIds.add(r.id); counts.rides++;
    }
    for (const b of old.bookings || []) {
      if (!rideIds.has(b.rideId) || !users[b.passenger] || !users[b.driver]) continue;
      await run('INSERT INTO bookings (id, ride_id, passenger_email, driver_email, method, status, price, cancelled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [b.id, b.rideId, b.passenger, b.driver, b.method, b.status, b.price, b.cancelled ? 1 : 0, b.createdAt || Date.now()], c);
      counts.bookings++;
    }
    for (const [email, card] of Object.entries(old.cards || {})) {
      if (!users[email]) continue;
      await run('INSERT INTO cards (email, brand, last4, expiry, holder, auto_pay) VALUES (?, ?, ?, ?, ?, ?)',
        [email, card.brand, card.last4, card.exp, card.holder, card.auto ? 1 : 0], c);
      counts.cards++;
    }
    for (const [email, t] of Object.entries(old.timetables || {})) {
      if (!users[email]) continue;
      let data = null;
      if (t.file) { try { data = fs.readFileSync(path.join(filesDir, fileKey(email))); } catch (e) { data = null; } }
      const f = data ? t.file : null;
      await run('INSERT INTO timetables (email, days_json, file_name, file_type, file_size, file_data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [email, JSON.stringify(t.days || {}), f ? f.name : null, f ? f.type : null, f ? data.length : null, data, t.updatedAt || Date.now()], c);
      counts.timetables++;
    }
    for (const [email, list] of Object.entries(old.notifs || {})) {
      if (!users[email]) continue;
      for (const n of list) {
        await run('INSERT INTO notifications (id, email, message, created_at, is_read) VALUES (?, ?, ?, ?, ?)',
          [n.id, email, String(n.text).slice(0, 500), n.at || Date.now(), n.read ? 1 : 0], c);
        counts.notifications++;
      }
    }
  });

  console.log('Imported:', counts);
  await db.end();
})().catch(async (err) => { console.error('Import failed, nothing was saved.\n', err); try { await db.end(); } catch (e) { /* ignore */ } process.exit(1); });
