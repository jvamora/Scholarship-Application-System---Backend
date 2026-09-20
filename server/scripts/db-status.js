#!/usr/bin/env node
// Read-only diagnostic: prints what's already in the target DB.
// Usage (from server/ so pg resolves):
//   DATABASE_URL="postgresql://..." node scripts/db-status.js
const { Pool } = require('pg');

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });

  const count = async (table) => {
    try {
      const r = await pool.query(`SELECT COUNT(*) AS n FROM "${table}"`);
      return r.rows[0].n;
    } catch { return 'n/a'; }
  };
  const q = async (sql) => {
    try { return (await pool.query(sql)).rows; }
    catch (e) { return 'ERROR: ' + e.message; }
  };

  console.log('users            :', await count('users'));
  console.log('colleges         :', await count('colleges'));
  console.log('courses          :', await count('courses'));
  console.log('academic_years   :', await count('academic_years'));
  console.log('scholarships     :', await count('scholarships'));
  console.log('applications     :', await count('applications'));

  console.log('\nAdmin row for adminone@university.edu:');
  console.log(JSON.stringify(await q("SELECT id, email, role, status, is_first_login, first_name, last_name, created_at FROM users WHERE email='adminone@university.edu'"), null, 2));

  console.log('\nCommittee columns on users (009 check):');
  console.log(JSON.stringify(await q("SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name IN ('committee_score','recommendation','committee_notes')"), null, 2));

  console.log('\nApplied migrations (_migrations):');
  console.log(JSON.stringify(await q('SELECT name FROM _migrations ORDER BY name'), null, 2));

  await pool.end();
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });