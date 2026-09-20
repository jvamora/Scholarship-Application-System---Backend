// Phase 0 helper — removes any leftover ZZZ test rows and reports what it found.
require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  const before = await pool.query(
    `SELECT id, name, status FROM scholarship_programs WHERE name LIKE 'ZZZ%'`
  );
  console.log(`found ${before.rows.length} orphaned test program(s):`);
  before.rows.forEach((r) => console.log(`  - id=${r.id} name=${r.name} status=${r.status}`));

  if (before.rows.length > 0) {
    // applications FK → students/users cascade handled separately below; a
    // throwaway program never had real applications attached (only its own
    // runs' rows, which their own cleanup removed — but be thorough anyway).
    const del = await pool.query(
      `DELETE FROM scholarship_programs WHERE name LIKE 'ZZZ%'`
    );
    console.log(`deleted ${del.rowCount} test program(s)`);
  }

  const delUsers = await pool.query(
    `DELETE FROM users WHERE email LIKE 'zzz-phase0%'`
  );
  console.log(`deleted ${delUsers.rowCount} test user(s)`);

  const checkP = await pool.query(
    `SELECT COUNT(*)::int AS c FROM scholarship_programs WHERE name LIKE 'ZZZ%'`
  );
  const checkU = await pool.query(
    `SELECT COUNT(*)::int AS c FROM users WHERE email LIKE 'zzz-phase0%'`
  );
  console.log(`post-check: ZZZ_PROGRAMS=${checkP.rows[0].c} ZZZ_USERS=${checkU.rows[0].c}`);

  await pool.end();
  process.exit(checkP.rows[0].c + checkU.rows[0].c ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
