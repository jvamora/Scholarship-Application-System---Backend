// Phase 0 helper — confirms no ZZZ test rows remain in the live database.
require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  const a = await pool.query(
    `SELECT COUNT(*)::int AS c FROM scholarship_programs WHERE name LIKE 'ZZZ%'`
  );
  const b = await pool.query(
    `SELECT COUNT(*)::int AS c FROM users WHERE email LIKE 'zzz-phase0%'`
  );
  const c = await pool.query(
    `SELECT COUNT(*)::int AS c FROM applications WHERE application_number LIKE 'APP-ZZZ%'`
  );
  console.log(`ZZZ_PROGRAMS=${a.rows[0].c} ZZZ_USERS=${b.rows[0].c} ZZZ_APPLICATIONS=${c.rows[0].c}`);
  await pool.end();
  process.exit(a.rows[0].c + b.rows[0].c + c.rows[0].c ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
