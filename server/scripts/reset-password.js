#!/usr/bin/env node
// Reset an existing account's password (bcrypt-hash it), clear the first-login
// flag so it signs in directly, and bump token_version to revoke old JWTs.
// Usage (from server/ so pg + bcryptjs resolve):
//   DATABASE_URL="postgresql://..." node scripts/reset-password.js --email you@x.edu --password 'newpass'
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

function argVal(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = argVal('email');
  const password = argVal('password');
  if (!email || !password) {
    console.error('Usage: node scripts/reset-password.js --email you@x.edu --password "newpass"');
    process.exit(1);
  }
  if (String(password).length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });

  const result = await pool.query('SELECT id, email, role FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  const found = result.rows && result.rows[0];
  if (!found) { console.error('No active user with email: ' + email); await pool.end(); process.exit(1); }

  const hash = await bcrypt.hash(String(password), 10);
  await pool.query(
    'UPDATE users SET password = $1, is_first_login = 0, token_version = token_version + 1 WHERE id = $2',
    [hash, found.id]
  );
  console.log(`Password reset for ${found.email} (role=${found.role}, id=${found.id}); old sessions revoked.`);
  await pool.end();
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });