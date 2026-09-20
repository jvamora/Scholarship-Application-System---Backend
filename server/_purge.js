// ============================================================
// _purge.js — remove leftover EduGrant E2E/seed test artifacts
// so a re-run starts from a clean DB. Safe to run anytime.
// ============================================================
require('dotenv').config();
const pool=require('./src/config/db');
const LOG=(m)=>{const l=`[${new Date().toISOString()}] ${m}`;console.log(l);};
(async()=>{
  LOG('purging E2E/seed test artifacts');
  try{
    await pool.query('BEGIN');
    const appSub='(SELECT a.id FROM applications a JOIN students s ON s.id=a.student_id JOIN users u ON u.id=s.user_id WHERE u.email LIKE \'%@test.local\' OR u.email LIKE \'%@e2e.test\')';
    await pool.query(`DELETE FROM committee_reviews WHERE application_id IN ${appSub}`);
    await pool.query(`DELETE FROM application_status_history WHERE application_id IN ${appSub}`);
    await pool.query(`DELETE FROM application_documents WHERE application_id IN ${appSub}`);
    await pool.query(`DELETE FROM scholars WHERE application_id IN ${appSub}`);
    await pool.query(`DELETE FROM applications WHERE student_id IN (SELECT s.id FROM students s JOIN users u ON u.id=s.user_id WHERE u.email LIKE '%@test.local' OR u.email LIKE '%@e2e.test')`);
    await pool.query(`DELETE FROM selection_runs WHERE scholarship_id IN (SELECT id FROM scholarship_programs WHERE name LIKE '%E2E %' OR name LIKE '%Merit Scholarship%' OR name LIKE '%Draft Program%' OR name LIKE '%Test %')`);
    await pool.query(`DELETE FROM requirements WHERE scholarship_id IN (SELECT id FROM scholarship_programs WHERE name LIKE '%E2E %' OR name LIKE '%Merit Scholarship%' OR name LIKE '%Draft Program%' OR name LIKE '%Test %')`);
    await pool.query(`DELETE FROM scholarship_programs WHERE name LIKE '%E2E %' OR name LIKE '%Merit Scholarship%' OR name LIKE '%Draft Program%' OR name LIKE '%Test %'`);
    await pool.query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@test.local' OR email LIKE '%@e2e.test')`);
    await pool.query(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@test.local' OR email LIKE '%@e2e.test')`);
    await pool.query(`DELETE FROM activity_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@test.local' OR email LIKE '%@e2e.test')`);
    await pool.query(`DELETE FROM students WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@test.local' OR email LIKE '%@e2e.test')`);
    await pool.query(`DELETE FROM users WHERE email LIKE '%@test.local' OR email LIKE '%@e2e.test'`);
    await pool.query('COMMIT');
    LOG('purge complete');
  }catch(e){
    await pool.query('ROLLBACK');LOG('PURGE_ERR '+e.message);
  }finally{
    try{await pool.end();}catch(e){}
    process.exit(0);
  }
})().catch(e=>{console.error(e);process.exit(1);});

