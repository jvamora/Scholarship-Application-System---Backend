// One-off purge of orphaned ZZZ test rows left by interrupted e2e runs.
// Dependency-ordered: children before parents. Keyed on the ZZz/zzz test
// prefixes used by verify-selection-pipeline.js / verify-selection-routes.js.
require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });

  // Identify throwaway program ids.
  const progs = await pool.query(
    `SELECT id, name FROM scholarship_programs WHERE name LIKE 'ZZZ%'`
  );
  const progIds = progs.rows.map((r) => r.id);
  const progList = progIds.length ? progIds.join(',') : '0';

  console.log(`orphaned programs: ${progIds.length} -> [${progIds.join(', ')}]`);
  console.log('prog names:');
  progs.rows.forEach((r) => console.log(`  id=${r.id} name=${r.name}`));

  // Applications that belong to those programs (or carry the APP-ZZZ / APP-RT prefix).
  const apps = await pool.query(
    `SELECT id FROM applications
      WHERE scholarship_id IN (${progList})
         OR application_number LIKE 'APP-ZZZ%'
         OR application_number LIKE 'APP-RT%'
         OR application_number LIKE 'APP-ZZZ-Phase2%'`
  );
  const appIds = apps.rows.map((r) => r.id);
  const appList = appIds.length ? appIds.join(',') : '0';
  console.log(`applications to purge: ${appIds.length}`);

  // Students attached to those applications' student_id (via applications.student_id).
  const studs = await pool.query(
    `SELECT DISTINCT student_id AS id FROM applications WHERE id IN (${appList})`
  );
  const studIds = studs.rows.map((r) => r.id);
  const studList = studIds.length ? studIds.join(',') : '0';

  // User tree: all user_id rows from those students plus zzz- prefixed users.
  const userQ = await pool.query(
    `SELECT DISTINCT st.user_id AS id
       FROM students st WHERE st.id IN (${studList})
     UNION
     SELECT id FROM users WHERE email LIKE 'zzz-%' OR uuid LIKE 'zzz-%'`
  );
  const userIds = userQ.rows.map((r) => r.id);
  const userList = userIds.length ? userIds.join(',') : '0';
  console.log(`users to purge: ${userIds.length}`);

  // --- dependency-ordered deletes ---
  if (appIds.length) {
    await pool.query(`DELETE FROM committee_reviews WHERE application_id IN (${appList})`);
    await pool.query(`DELETE FROM application_status_history WHERE application_id IN (${appList})`);
    await pool.query(`DELETE FROM scholars WHERE application_id IN (${appList})`);
    await pool.query(`DELETE FROM notifications WHERE reference_id IN (${appList})`);
    await pool.query(`DELETE FROM applications WHERE id IN (${appList})`);
  }
  if (studIds.length) {
    await pool.query(`DELETE FROM students WHERE id IN (${studList})`);
  }
  if (userIds.length) {
    await pool.query(`DELETE FROM users WHERE id IN (${userList}) OR email LIKE 'zzz-%'`);
  }
  if (progIds.length) {
    await pool.query(`DELETE FROM selection_runs WHERE scholarship_id IN (${progList})`);
    await pool.query(`DELETE FROM notifications WHERE reference_id IN (${progList})`);
    await pool.query(`DELETE FROM scholarship_programs WHERE id IN (${progList})`);
  }
  // belt-and-braces: any remaining by prefix that the id-joins missed.
  await pool.query(`DELETE FROM users WHERE email LIKE 'zzz-%' OR uuid LIKE 'zzz-%'`);
  await pool.query(`DELETE FROM scholarship_programs WHERE name LIKE 'ZZZ%'`);

  const checkP = await pool.query(`SELECT COUNT(*)::int AS c FROM scholarship_programs WHERE name LIKE 'ZZZ%'`);
  const checkA = await pool.query(`SELECT COUNT(*)::int AS c FROM applications WHERE application_number LIKE 'APP-ZZZ%' OR application_number LIKE 'APP-RT%'`);
  const checkU = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE email LIKE 'zzz-%'`);
  console.log(`post-check: ZZZ_PROGRAMS=${checkP.rows[0].c} ZZZ_APPLICATIONS=${checkA.rows[0].c} ZZZ_USERS=${checkU.rows[0].c}`);
  await pool.end();
  process.exit(checkP.rows[0].c + checkA.rows[0].c + checkU.rows[0].c ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });