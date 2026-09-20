#!/usr/bin/env node
// ============================================================
// Applies the base PostgreSQL/Supabase schema + committee
// columns + reference seeds to the target database.
//
// The database target is read from process.argv[2] OR the
// DATABASE_URL environment variable.
//
// Usage (from the server/ folder, so the `pg` package resolves):
//   node scripts/apply-base-schema.js "postgresql://USER:PASS@HOST:5432/DB"
//   # or
//   DATABASE_URL="postgresql://..." node scripts/apply-base-schema.js
//
// Idempotent: supabase_schema.sql + 009 + 010 use CREATE TABLE IF NOT
// EXISTS / ADD COLUMN IF NOT EXISTS / NOT EXISTS, so re-running is safe.
// ============================================================
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const dbUrl = process.argv[2] || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Missing target DB. Pass a connection string as the 2nd arg or set DATABASE_URL.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }, // Supabase requires TLS
    connectionTimeoutMillis: 20000,
  });

  // Relative to server/scripts/ -> <repo root>/scholarship/database/migrations
  const migrationsDir = path.join(__dirname, '..', '..', 'scholarship', 'database', 'migrations');
  const files = [
    'supabase_schema.sql',
    '009_add_committee_fields.sql',
    '010_seed_reference_data.sql',
  ];

  for (const file of files) {
    const full = path.join(migrationsDir, file);
    if (!fs.existsSync(full)) {
      console.error(`  MISSING: ${full}`);
      process.exit(1);
    }
    const sql = fs.readFileSync(full, 'utf8');
    process.stdout.write(`Applying ${file} ... `);
    try {
      await pool.query(sql);
      console.log('ok');
    } catch (e) {
      console.error('FAIL');
      console.error(e.message);
      await pool.end();
      process.exit(1);
    }
  }

  await pool.end();
  console.log('Base schema applied successfully.');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});