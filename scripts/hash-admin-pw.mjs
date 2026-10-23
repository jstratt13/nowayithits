#!/usr/bin/env node
// One-shot tool for computing the admin password hash + salt suitable for
// `wrangler secret put ADMIN_PASSWORD_HASH` / `ADMIN_SALT`.
//
// Usage:
//   node scripts/hash-admin-pw.mjs <password>
//   node scripts/hash-admin-pw.mjs                     # prompts on stdin
//
// Uses the exact same PBKDF2 parameters as the live login flow
// (worker/src/auth/crypto.js), so `wrangler secret put` values produced
// here verify against the password on /auth/login without any drift.
//
// Output is two lines you can pipe into wrangler:
//   ADMIN_PASSWORD_HASH=<base64>
//   ADMIN_SALT=<base64>
//
// The plaintext password never leaves this process.

import * as readline from 'node:readline/promises';
import { hashPassword, generateSalt } from '../worker/src/auth/crypto.js';

async function readPassword() {
  if (process.argv[2]) return process.argv[2];
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const pw = await rl.question('Admin password: ');
  rl.close();
  return pw;
}

const password = await readPassword();
if (!password) {
  console.error('No password provided.');
  process.exit(1);
}

const salt = generateSalt();
const hash = await hashPassword(password, salt);

console.log(`ADMIN_PASSWORD_HASH=${hash}`);
console.log(`ADMIN_SALT=${salt}`);
