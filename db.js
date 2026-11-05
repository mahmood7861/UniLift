'use strict';

/* ---------------------------------------------------------------------
   UniLift database layer (MySQL / MariaDB via the "mysql2" package).
   - One connection pool shared by the whole server.
   - Creates the database (if your MySQL user is allowed to) and all the
     tables on start-up, using schema.sql.
--------------------------------------------------------------------- */

require('./env');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let mysql;
try {
    mysql = require('mysql2/promise');
} catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
        console.error('\nThe "mysql2" package is not installed yet. Run this once in the project folder:\n\n    npm install\n');
        process.exit(1);
    }
    throw err;
}

const DB_NAME = process.env.DB_NAME || 'unilift';
if (!/^[A-Za-z0-9_]+$/.test(DB_NAME)) {
    console.error('DB_NAME may only contain letters, numbers and underscores.');
    process.exit(1);
}

function options(withDatabase) {
    const o = {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        charset: 'utf8mb4',
        waitForConnections: true,
        connectionLimit: Number(process.env.DB_POOL) || 10,
        decimalNumbers: true,      // DECIMAL columns come back as numbers, not strings
        supportBigNumbers: true,
        bigNumberStrings: false    // BIGINT timestamps come back as numbers
    };
    if (withDatabase) o.database = DB_NAME;
    if (process.env.DB_SSL) o.ssl = { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== '0' };
    return o;
}

let pool = null;

/* ---------- query helpers ---------- */
// Every helper takes an optional connection so the same code works inside a transaction.
const target = (conn) => conn || pool;
async function q(sql, params, conn) { return (await target(conn).query(sql, params || []))[0]; }
async function q1(sql, params, conn) { const rows = await q(sql, params, conn); return rows[0] || null; }
async function run(sql, params, conn) { return (await target(conn).query(sql, params || []))[0]; }

// Runs fn(connection) inside a transaction. Rolls back on any error and retries a deadlock a couple of times.
async function tx(fn) {
    for (let attempt = 1; ; attempt++) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const result = await fn(conn);
            await conn.commit();
            return result;
        } catch (err) {
            try { await conn.rollback(); } catch (e) { /* connection already gone */ }
            if (err && err.code === 'ER_LOCK_DEADLOCK' && attempt < 3) continue;
            throw err;
        } finally {
            conn.release();
        }
    }
}

/* ---------- start-up ---------- */
async function createDatabaseIfMissing() {
    const boot = await mysql.createConnection(options(false));
    try {
        await boot.query('CREATE DATABASE IF NOT EXISTS `' + DB_NAME + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    } finally {
        await boot.end();
    }
}

function loadStatements() {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
        .split(/\r?\n/).filter((line) => !/^\s*--/.test(line)).join('\n');
    const all = sql.split(';').map((s) => s.trim()).filter(Boolean);
    // The database is created separately, and nothing here should ever delete data,
    // so these kinds of statements are skipped even if someone adds them to schema.sql.
    const skip = /^(CREATE\s+(DATABASE|SCHEMA)|USE|DROP|TRUNCATE|DELETE)\b/i;
    const skipped = all.filter((st) => skip.test(st));
    if (skipped.length) console.log('Skipped ' + skipped.length + ' statement(s) in schema.sql that are not needed (CREATE DATABASE / USE / DROP).');
    return all.filter((st) => !skip.test(st));
}

async function init() {
    pool = mysql.createPool(options(true));
    try {
        await pool.query('SELECT 1');
    } catch (err) {
        if (err && err.code === 'ER_BAD_DB_ERROR') { // database does not exist yet: create it
            await pool.end();
            await createDatabaseIfMissing();
            pool = mysql.createPool(options(true));
            await pool.query('SELECT 1');
        } else {
            throw err;
        }
    }
    for (const statement of loadStatements()) await pool.query(statement);
    await migrate();
    await seedAdmins();
}

/* ---------- initial administrator accounts ---------- */

const INITIAL_ADMINS = [];

function hashSecret(value) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16);

        crypto.scrypt(
            value,
            salt,
            64,
            { N: 16384, r: 8, p: 1 },
            (err, key) => {
                if (err) return reject(err);

                resolve(
                    salt.toString('hex') + ':' + key.toString('hex')
                );
            }
        );
    });
}

async function seedAdmins() {
    const question = 'What was your childhood nickname?';
    const answerHash = await hashSecret('UniLiftAdministrator');

    for (const admin of INITIAL_ADMINS) {
        const existing = await q1(
            'SELECT email FROM users WHERE email = ?',
            [admin.email]
        );

        if (existing) {
            // If this account already exists, make sure it is an administrator.
            // The existing password is NOT overwritten.
            await run(
                'UPDATE users SET role = ? WHERE email = ?',
                ['admin', admin.email]
            );

            continue;
        }

        const passHash = await hashSecret(admin.password);

        await run(
            `INSERT INTO users
   (email, name, phone, role, pass_hash, question, answer_hash, token_version, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
            [
                admin.email,
                admin.name,
                admin.phone,
                'admin',
                passHash,
                question,
                answerHash,
                Date.now()
            ]
        );

        console.log('Created initial administrator: ' + admin.email);
    }
}
// Adds columns that were introduced after someone's database was first created.
// Safe to run every time: each ALTER is skipped if the column already exists.
async function migrate() {
    // Tables added for the maps feature. Created here as well as in schema.sql so an old schema.sql cannot break the site.
    const creates = [
        `CREATE TABLE IF NOT EXISTS geocode_cache (
          query_key   VARCHAR(150)  NOT NULL,
          lat         DOUBLE        NULL,
          lng         DOUBLE        NULL,
          label       VARCHAR(200)  NOT NULL DEFAULT '',
          created_at  BIGINT        NOT NULL,
          PRIMARY KEY (query_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS ride_offers (
          id             CHAR(16)      NOT NULL,
          ride_id        CHAR(16)      NOT NULL,
          driver_email   VARCHAR(100)  NOT NULL,
          student_email  VARCHAR(100)  NOT NULL,
          message        VARCHAR(150)  NOT NULL DEFAULT '',
          status         VARCHAR(10)   NOT NULL DEFAULT 'pending',
          created_at     BIGINT        NOT NULL,
          PRIMARY KEY (id),
          UNIQUE KEY uq_offer (ride_id, student_email),
          FOREIGN KEY (ride_id) REFERENCES rides (id) ON DELETE CASCADE,
          FOREIGN KEY (driver_email) REFERENCES users (email) ON DELETE CASCADE,
          FOREIGN KEY (student_email) REFERENCES users (email) ON DELETE CASCADE,
          KEY idx_offers_student (student_email, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    ];
    for (const sql of creates) await pool.query(sql);

    const alters = [
        "ALTER TABLE bookings ADD COLUMN pickup_phone VARCHAR(20) NOT NULL DEFAULT '' AFTER price",
        "ALTER TABLE bookings ADD COLUMN pickup_address VARCHAR(255) NOT NULL DEFAULT '' AFTER pickup_phone",
        "ALTER TABLE users ADD COLUMN status VARCHAR(12) NOT NULL DEFAULT 'active'",
        "ALTER TABLE users ADD COLUMN discoverable TINYINT(1) NOT NULL DEFAULT 1",
        "ALTER TABLE rides ADD COLUMN from_lat DOUBLE NULL",
        "ALTER TABLE rides ADD COLUMN from_lng DOUBLE NULL",
        "ALTER TABLE rides ADD COLUMN to_lat DOUBLE NULL",
        "ALTER TABLE rides ADD COLUMN to_lng DOUBLE NULL",
        "ALTER TABLE rides ADD COLUMN geo_tried TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE bookings ADD COLUMN pickup_lat DOUBLE NULL",
        "ALTER TABLE bookings ADD COLUMN pickup_lng DOUBLE NULL",
        "ALTER TABLE bookings ADD COLUMN pickup_geo TINYINT(1) NOT NULL DEFAULT 0"
    ];
    for (const sql of alters) {
        try { await pool.query(sql); }
        catch (err) { if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err; }
    }
}

function describeError(err) {
    const where = (process.env.DB_HOST || 'localhost') + ':' + (Number(process.env.DB_PORT) || 3306);
    switch (err && err.code) {
        case 'ECONNREFUSED':
        case 'ETIMEDOUT':
        case 'ENOTFOUND':
            return 'Cannot reach MySQL at ' + where + '. Is MySQL running, and are DB_HOST and DB_PORT correct?';
        case 'ER_ACCESS_DENIED_ERROR':
            return 'MySQL refused the login. Check DB_USER and DB_PASSWORD in your .env file.';
        case 'ER_DBACCESS_DENIED_ERROR':
            return 'The MySQL user "' + (process.env.DB_USER || 'root') + '" is not allowed to use the database "' + DB_NAME + '". See the README for the GRANT command.';
        case 'ER_BAD_DB_ERROR':
            return 'The database "' + DB_NAME + '" does not exist and could not be created. Create it first (see the README).';
        default:
            return 'Database error: ' + ((err && err.message) || err);
    }
}

async function ping() { await pool.query('SELECT 1'); }
async function end() { if (pool) await pool.end(); }

module.exports = { init, q, q1, run, tx, ping, end, describeError, DB_NAME };
