'use strict';

// Tiny .env loader (no packages needed). Values already set in the real
// environment always win over the file.
const fs = require('fs');
const path = require('path');

try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    if (/^\s*(#|$)/.test(line)) return;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) return;
    let value = m[2];
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  });
} catch (e) { /* no .env file: use real environment variables */ }
