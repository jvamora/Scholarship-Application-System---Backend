// ============================================================
// _dbcheck.js — verify the DB has no leftover E2E/seed test
// artifacts (run after node _run.js; should print all zeros).
// ============================================================
require('dotenv').config();
const pool = require('./src/config/db');
(async () => {
  const checks = [
    ['test users',       "SELECT COUNT(*)::int n FROM users WHERE email LIKE '%@test.local' OR email LIKE '%@e2e.test'"],
    ['E2E programs',     "SELECT COUNT(*)::int n FROM scholarship_programs WHERE name LIKE '%E2E %' OR name LIKE '%Draft Program%' OR name LIKE '%Merit Scholarship%'"],
    ['test applications',"SELECT COUNT(*)::int n FROM applications a JOIN students s ON s.id=a.student_id JOIN users u ON u.id=s.user_id WHERE u.email LIKE '%@test.local' OR u.email LIKE '%@e2e.test'"],
    ['orphan reviews',   "SELECT COUNT(*)::int n FROM committee_reviews cr LEFT JOIN applications a ON a.id=cr.application_id WHERE a.id IS NULL"],
    ['orphan scholars',  "SELECT COUNT(*)::int n FROM scholars sh LEFT JOIN applications a ON a.id=sh.application_id WHERE a.id IS NULL"],
    ['orphan documents', "SELECT COUNT(*)::int n FROM application_documents d LEFT JOIN applications a ON a.id=d.application_id WHERE a.id IS NULL"],
  ];
  let bad = 0;
  for (const [name, sql] of checks) {
    const [rows] = await pool.query(sql);
    const n = rows[0].n;
    if (n !== 0) bad++;
    console.log(name.padEnd(20) + '=> ' + n);
  }
  await pool.end();
  console.log(bad === 0 ? 'DB CLEAN' : 'DB HAS LEFTOVERS (' + bad + ')');
  process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error('CHECK_ERR', e.message); process.exit(1); });
