// JavaScript source code
'use strict';

/* ---------------------------------------------------------------------
   Adds fake students and drivers (with vehicles) to the UniLift database.
   Put this file in the scripts/ folder, next to import-json.js.

     node scripts/seed.js                        (20 students, 10 drivers)
     node scripts/seed.js --students 50 --drivers 15

   - Follows the same rules as server.js (email, phone, banks, seats...).
   - Safe to run more than once: it only adds new accounts.
   - Every seeded account uses the same password and security answer,
     printed at the end. TEST DATA ONLY: do not run this on a live site.
--------------------------------------------------------------------- */

const crypto = require('crypto');
const db = require('../db');
const { q, run, tx } = db;

const PASSWORD = 'Password123!';
const QUESTION = 'What was your childhood nickname?';
const ANSWER = 'unilift';

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    const n = i > -1 ? Number(process.argv[i + 1]) : fallback;
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}
const STUDENTS = arg('students', 20);
const DRIVERS = arg('drivers', 10);

const FIRST = ['Sipho', 'Thandi', 'Lwazi', 'Nomvula', 'Ayanda', 'Zanele', 'Bongani', 'Nokuthula', 'Thabo', 'Lerato',
    'Siyabonga', 'Palesa', 'Mpho', 'Naledi', 'Sibusiso', 'Busisiwe', 'Kabelo', 'Ntombi', 'Themba', 'Precious',
    'Rohan', 'Priya', 'Kyle', 'Megan', 'Yusuf', 'Fatima', 'Devan', 'Ashleigh', 'Mohamed', 'Kiara'];
const LAST = ['Dlamini', 'Zulu', 'Ndlovu', 'Khumalo', 'Mthembu', 'Naidoo', 'Pillay', 'Govender', 'Mkhize', 'Cele',
    'Ngcobo', 'Sithole', 'Nxumalo', 'Shange', 'Mbatha', 'Botha', 'Patel', 'Moodley', 'Chetty', 'Hadebe',
    'Smith', 'Jacobs', 'Abrahams', 'Buthelezi', 'Majola'];

const CARS = [
    ['Toyota', 'Corolla'], ['Toyota', 'Etios'], ['Volkswagen', 'Polo'], ['Volkswagen', 'Polo Vivo'],
    ['Suzuki', 'Swift'], ['Suzuki', 'Celerio'], ['Hyundai', 'i10'], ['Hyundai', 'Atos'], ['Kia', 'Picanto'],
    ['Renault', 'Kwid'], ['Ford', 'Figo'], ['Nissan', 'Micra'], ['Datsun', 'Go'], ['Chevrolet', 'Spark']
];
const COLOURS = ['White', 'Silver', 'Black', 'Grey', 'Red', 'Blue', 'Green'];
const BANKS = {
    'ABSA': '632005', 'African Bank': '430000', 'Capitec': '470010', 'Discovery Bank': '679000',
    'FNB': '250655', 'Investec': '580105', 'Nedbank': '198765', 'Standard Bank': '051001', 'TymeBank': '678910'
};
const ACCOUNT_TYPES = ['Cheque / Current', 'Savings', 'Transmission'];

const pick = (arr) => arr[crypto.randomInt(arr.length)];
const digits = (n) => Array.from({ length: n }, () => crypto.randomInt(10)).join('');

function hashSecret(value) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16);
        crypto.scrypt(value, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) =>
            err ? reject(err) : resolve(salt.toString('hex') + ':' + key.toString('hex')));
    });
}

(async () => {
    try { await db.init(); } catch (err) { console.error(db.describeError(err)); process.exit(1); }

    const taken = new Set((await q('SELECT email FROM users')).map((r) => r.email));

    // One hash is reused for every fake account so seeding is fast.
    const passHash = await hashSecret(PASSWORD);
    const answerHash = await hashSecret(ANSWER);

    function newEmail() {
        for (; ;) {
            const email = '2' + digits(7) + '@dut4life.ac.za'; // 2xxxxxxx never clashes with the 1000000x admins
            if (!taken.has(email)) { taken.add(email); return email; }
        }
    }

    const made = { students: [], drivers: [] };

    await tx(async (c) => {
        const now = Date.now();
        const total = STUDENTS + DRIVERS;

        for (let i = 0; i < total; i++) {
            const isDriver = i >= STUDENTS;
            const email = newEmail();
            const first = pick(FIRST), last = pick(LAST);
            const name = first + ' ' + last;
            const phone = '0' + pick(['6', '7', '8']) + digits(8);

            await run(
                'INSERT INTO users (email, name, phone, role, pass_hash, question, answer_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
                [email, name, phone, isDriver ? 'driver' : 'student', passHash, QUESTION, answerHash, now - crypto.randomInt(1, 60) * 86400000], c);

            if (!isDriver) { made.students.push(email); continue; }

            const [make, model] = pick(CARS);
            const bank = pick(Object.keys(BANKS));
            await run(
                'INSERT INTO vehicles (email, make, model, vehicle_year, colour, plate, seats, bank_name, account_type, account_holder, account_number, branch_code, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [email, make, model, 2012 + crypto.randomInt(14), pick(COLOURS),
                    'ND ' + digits(3) + '-' + digits(3), 3 + crypto.randomInt(2),
                    bank, pick(ACCOUNT_TYPES), name, digits(10), BANKS[bank], now], c);
            made.drivers.push(email);
        }
    });

    console.log('Added ' + made.students.length + ' students and ' + made.drivers.length + ' drivers (with vehicles).');
    console.log('Password for all of them: ' + PASSWORD);
    console.log('Security answer for all of them: ' + ANSWER);
    if (made.drivers.length) console.log('Example driver login: ' + made.drivers[0]);
    if (made.students.length) console.log('Example student login: ' + made.students[0]);
    await db.end();
})().catch(async (err) => {
    console.error('Seeding failed, nothing was saved.\n', err);
    try { await db.end(); } catch (e) { /* ignore */ }
    process.exit(1);
});