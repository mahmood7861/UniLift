# UniLift

Ride sharing for DUT students. Drivers register a vehicle and publish rides. Passengers book seats, pay by card or EFT, and share their timetable so drivers can plan the trip home together.

The website runs on Node.js and stores everything in **MySQL**.

## What you need

- [Node.js](https://nodejs.org) 18 or newer
- MySQL 5.7 / 8.x, or MariaDB 10.3+ (the MySQL that comes with XAMPP works too)

## Set it up

**1. Make a database and a user for it.** In the MySQL console (or phpMyAdmin's SQL tab), as an admin user:

```sql
CREATE DATABASE unilift CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'unilift'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
GRANT ALL PRIVILEGES ON unilift.* TO 'unilift'@'localhost';
```

> Quick start on XAMPP: skip this step, set `DB_USER=root` and leave `DB_PASSWORD` empty in step 3. The server will create the database for you. Use a proper user like the one above once the site is live.

**2. Install the one package the server needs.**

```
npm install
```

**3. Tell the server how to reach MySQL.** Copy `.env.example` to `.env` and fill it in:

```
DB_HOST=localhost
DB_PORT=3306
DB_USER=unilift
DB_PASSWORD=choose-a-strong-password
DB_NAME=unilift
```

**4. Start it.**

```
npm start
```

Open **http://localhost:3000**. The tables are created automatically the first time (from `schema.sql`), and running it again is harmless. If MySQL is not reachable the server stops with a plain message saying what to check.

> Open the site through that address. Double-clicking the HTML files will not work, because the pages talk to the server.

## Try the whole flow

1. **Sign up** as a **Driver** with an email like `12345678@dut4life.ac.za`, then log in.
2. Register your vehicle and bank details, then publish a ride.
3. Log out. Sign up as a **Student** with a different student number, log in, and add a timetable.
4. Find the ride and book it by card or EFT. For EFT, the driver's account details appear.
5. Log back in as the driver: you will see the passenger and their classes that day, can confirm the EFT, and set the afternoon pick-up time.

## What is in the database

| Table | Holds |
| --- | --- |
| `users` | Accounts: name, phone, role, hashed password, security question and hashed answer |
| `vehicles` | A driver's car and bank details for EFT |
| `rides` | Published rides |
| `bookings` | Seats booked, payment method and status |
| `cards` | Brand, last four digits and expiry only |
| `timetables` | Class times per weekday, plus the uploaded PDF or image |
| `notifications` | Alerts shown under the bell |
| `settings` | The key that signs login cookies (unless you set `SESSION_SECRET`) |

Two people can never take the last seat at once: booking locks the ride row inside a transaction.

## Backups

```
mysqldump -u unilift -p unilift > unilift-backup.sql
```

Do this regularly. Timetable uploads are inside the database, so one dump covers everything.

## Coming from the earlier file-based version?

If you already collected real accounts in `data/db.json`, copy them into MySQL once:

```
npm run import-json
```

It refuses to run if MySQL already has users, and it saves nothing unless everything imports.

## Files

```
server.js            the server and API
db.js                MySQL connection, tables and transactions
schema.sql           the table definitions
env.js               reads the .env file
scripts/import-json.js
public/              the website (index.html, login.html, dashboard.html, js/)
```

## Settings (in `.env` or environment variables)

| Variable | Default | What it does |
| --- | --- | --- |
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` | localhost, 3306, root, empty, unilift | How to reach MySQL |
| `DB_SSL` | off | Set to `1` for cloud databases that require SSL |
| `PORT` | `3000` | Port to listen on |
| `TZ` | `Africa/Johannesburg` | Timezone used to decide whether a ride is in the past |
| `SESSION_SECRET` | generated | Key that signs login cookies |
| `TRUST_PROXY` | off | Set to `1` behind a proxy or hosting platform (adds Secure cookies over HTTPS) |

## Putting it online

- Use a host that runs Node, plus a MySQL database (your host's, or a managed one such as Railway, Aiven or DigitalOcean). Put its details in the environment variables above.
- Serve it over **HTTPS** and set `TRUST_PROXY=1`.
- If MySQL 5.7 rejects timetable uploads, raise `max_allowed_packet` to at least 4 MB.
- Never commit `.env` to GitHub. It is already in `.gitignore`.
- Login and reset attempt limits are counted per server process, so with several copies of the server the limits are per copy.

## Still to add before real launch

- **Email verification.** The site checks that emails look like `12345678@dut4life.ac.za`, but nothing yet proves the person owns that inbox.
- **Real card payments.** Card payments are simulated. Connect a gateway such as PayFast, Yoco or Paystack and store its token. The place to do it is marked in `server.js` under `POST /api/bookings`.
- Terms and privacy pages, and a way for users to delete their account (POPIA).

## Security built in

- Passwords and security answers are hashed with scrypt and a random salt.
- Login cookies are signed, HttpOnly and SameSite. Resetting a password logs out other devices.
- Login and password-reset attempts are rate limited, and reset never reveals whether an email has an account.
- All database queries use placeholders, and every value from the browser is type-checked first.
- Drivers' bank details are only sent to passengers who chose EFT for one of their rides. Passengers only see their own bookings, card and timetable. Timetable files are only open to the passenger and drivers they are booked with, and are checked to really be PDF, PNG or JPG.
- Every rule is enforced on the server as well as in the browser.
