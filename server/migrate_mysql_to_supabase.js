'use strict';
const cp = require('child_process');
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();
const REPORT = process.env.TEMP + '\\migrate_report.txt';
const POOL = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 60000, idleTimeoutMillis: 30000 });
const MB = ['-u', 'root', '--password=', '--connect-timeout=5', '-D', 'scholarship_db', '--batch', '--raw', '-e'];
function add(line) { fs.appendFileSync(REPORT, line + '\n'); }
function mysqlJson(sql) {
  const r = cp.spawnSync('mysql', MB.concat([sql]), { encoding: 'utf8', timeout: 60000 });
  if (r.error) throw new Error('mysql spawn: ' + r.error.message);
  if (r.status !== 0) throw new Error('mysql rc=' + r.status + ': ' + String(r.stderr || ''));
  const lines = String(r.stdout || '').split('\n').filter(l => l.trim() && l.trim() !== 'data');
  return lines.length ? JSON.parse(lines.join('\n')) : [];
}
const USER_OBJ = "JSON_OBJECT('id',id,'uuid',uuid,'email',email,'password',password,'role',role,'first_name',first_name,'middle_name',middle_name,'last_name',last_name,'phone',phone,'address',address,'avatar_url',avatar_url,'is_active',is_active,'email_verified_at',email_verified_at,'last_login_at',last_login_at,'created_at',created_at,'updated_at',updated_at,'status',status,'remark',remark,'created_by',created_by,'committee_score',committee_score,'recommendation',recommendation,'committee_notes',committee_notes,'is_first_login',is_first_login,'activated_at',activated_at,'token_version',token_version,'deleted_at',deleted_at)";
const STUDENT_OBJ = "JSON_OBJECT('id',id,'user_id',user_id,'student_number',student_number,'course_id',course_id,'year_level',year_level,'gender',gender,'phone',phone,'address',address,'created_at',created_at,'updated_at',updated_at)";
const isBcrypt = p => typeof p === 'string' && /^\$2[aby]\$/.test(p);
const ts = v => (v === null || v === undefined || v === '') ? null : String(v);
const num = v => (v === null || v === undefined) ? null : Number(v);
const boolN = v => (v === 1 || v === '1' || v === true);
(async () => {
  fs.writeFileSync(REPORT, '--- START ' + new Date().toISOString() + ' ---\n');
  try {
    add('Read users...');
    const users = mysqlJson('SELECT COALESCE(JSON_ARRAYAGG(' + USER_OBJ + '),"[]") AS data FROM users;');
    add('users=' + users.length);
    add('Read students...');
    const students = mysqlJson('SELECT COALESCE(JSON_ARRAYAGG(' + STUDENT_OBJ + '),"[]") AS data FROM students;');
    add('students=' + students.length);
    add('Existing supabase users...');
    const existingEmails = (await POOL.query('SELECT email FROM users')).rows.map(r => r.email);
    const existingIds = new Set((await POOL.query('SELECT id FROM users')).rows.map(r => r.id));
    add('existing=' + existingEmails.length);
    const client = await POOL.connect();
    try {
      await client.query('BEGIN');
      add('txn started');
      let inserted = 0, skipped = 0; const invalidPw = [];
      for (const u of users) {
        if (existingEmails.includes(u.email) || existingIds.has(u.id)) { skipped++; continue; }
        if (!isBcrypt(u.password)) invalidPw.push(u.email + '(id=' + u.id + ')');
        await client.query(
          `INSERT INTO users (id, uuid, email, password, role, first_name, middle_name, last_name, phone, address, avatar_url, is_active, email_verified_at, last_login_at, created_at, updated_at, status, remark, created_by, committee_score, recommendation, committee_notes, is_first_login, activated_at, token_version, deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
          [u.id, ts(u.uuid), u.email, u.password, u.role, u.first_name, ts(u.middle_name), u.last_name, ts(u.phone), ts(u.address), ts(u.avatar_url), boolN(u.is_active), ts(u.email_verified_at), ts(u.last_login_at), ts(u.created_at), ts(u.updated_at), u.status, ts(u.remark), num(u.created_by), (u.committee_score === null || u.committee_score === undefined) ? null : Number(u.committee_score), ts(u.recommendation), ts(u.committee_notes), Number(u.is_first_login), ts(u.activated_at), Number(u.token_version || 0), ts(u.deleted_at)]
        );
        inserted++;
      }
      add('users inserted=' + inserted + ' skipped=' + skipped);
      let sInserted = 0, sFailed = 0; const badRef = [];
      for (const s of students) {
        try {
          await client.query(
            `INSERT INTO students (id, user_id, student_number, course_id, year_level, gender, phone, address, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [s.id, s.user_id, s.student_number, num(s.course_id), num(s.year_level), ts(s.gender), ts(s.phone), ts(s.address), ts(s.created_at), ts(s.updated_at)]
          );
          sInserted++;
        } catch (e) { sFailed++; badRef.push('sid=' + s.id + ' uid=' + s.user_id + ' :: ' + e.message.split('\n')[0]); }
      }
      add('students inserted=' + sInserted + ' failed=' + sFailed);
      await client.query("SELECT setval(pg_get_serial_sequence('users','id'), COALESCE((SELECT MAX(id) FROM users),1))");
      await client.query("SELECT setval(pg_get_serial_sequence('students','id'), COALESCE((SELECT MAX(id) FROM students),1))");
      await client.query('COMMIT');
      add('committed; seq bumped');
      if (invalidPw.length) add('WARN non-bcrypt pw: ' + invalidPw.join(', '));
      if (badRef.length) add('WARN student FK: ' + badRef.join(' ; '));
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} add('ROLLED BACK: ' + e.message); throw e; } finally { client.release(); }
    const admins = (await POOL.query("SELECT id,email,role,status,is_first_login FROM users WHERE role='admin' ORDER BY id")).rows;
    const t = (await POOL.query("SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM students) s")).rows[0];
    add('VERIFY users=' + t.u + ' students=' + t.s);
    add('VERIFY admins=' + JSON.stringify(admins));
    add('DONE');
  } catch (e) { add('FATAL ' + e.message + '\n' + (e.stack || '')); }
  process.exit(0);
})();

