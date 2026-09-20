#!/usr/bin/env node
// ============================================================
// Postgres migration runner (slot-model v2) — targets DATABASE_URL.
// Replaces the legacy MySQL-only scripts/... runner; legacy files in
// scholarship/database/migrations are NOT executed here.
//
// Usage:
//   node scripts/migrate-pg.js            apply all pending migrations
//   node scripts/migrate-pg.js --status   list applied / pending
//
// Files live in server/migrations-pg/*.sql, applied in filename order.
// Each file runs OUTSIDE an explicit transaction because ALTER TYPE ...
// ADD VALUE (Postgres) cannot run inside one — every file must therefore
// be individually idempotent. Applied files are recorded in _migrations.
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations-pg');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows: appliedRows } = await pool.query('SELECT name FROM _migrations ORDER BY name');
  const appliedSet = new Set(appliedRows.map((r) => r.name));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (process.argv.includes('--status')) {
    console.log('Applied:', appliedSet.size ? [...appliedSet].join(', ') : '(none)');
    console.log('Pending:', files.filter((f) => !appliedSet.has(f)).join(', ') || '(none)');
    await pool.end();
    return;
  }

  let failures = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`SKIP   ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      console.log(`APPLY  ${file} — ok`);
    } catch (e) {
      console.error(`FAIL   ${file} — ${e.message}`);
      failures += 1;
      break; // stop on first failure; earlier applied files stay recorded
    }
  }

  await pool.end();
  if (failures) {
    console.error(`\n${failures} migration(s) failed — fix and re-run.`);
    process.exit(1);
  }
  console.log('\nMigrations up to date.');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
