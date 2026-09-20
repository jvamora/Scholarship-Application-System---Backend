// Phase 2 — Route-level integration tests for the award pipeline.
// Drives the REAL Express app (src/app.js) over HTTP against the LIVE
// Postgres/Supabase database, passing a real JWT through the auth middleware.
//
// Exercises the actual route wiring — including the accept-award/decline-award
// adapters that translate HTTP (req, res) into the service's data arguments.
//
// Assertions (5):
//   R1  POST /api/selection/:id/approve-awardees with no run yet      -> 409
//   R2  POST /api/selection/999999/run (unknown program)             -> 404
//   R3  GET  /api/selection/:id/leaderboard after a run              -> 200 + data
//   R4  POST /api/applications/:id/accept-award wrong signature      -> 400
//   R5  POST /api/applications/:id/decline-award on scholar_active   -> 409
require('dotenv').config();

// Silence morgan BEFORE app.js loads (it calls morgan('dev') at import time).
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'morgan') return () => (req, res, next) => next();
  return originalLoad.apply(this, arguments);
};

const jwt = require('jsonwebtoken');
const db = require('../src/config/database');
const app = require('../src/app');
const selectionService = require('../src/services/selectionService');
const { SelectionError } = selectionService;

Module._load = originalLoad;

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const rnd = Math.random().toString(36).slice(2, 8);
let programId = null;
let committeeId = null;
let applicantUserId = null;
let studentId = null;
let appId = null;
let server = null;
let baseUrl = '';

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

async function signToken(userId, role) {
  const [rows] = await db.query('SELECT token_version FROM users WHERE id = ?', [userId]);
  const tv = rows && rows[0] ? Number(rows[0].token_version || 0) : 0;
  return jwt.sign({ id: userId, role, tv }, JWT_SECRET, { expiresIn: '1h' });
}

async function http(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON body */ }
  return { status: res.status, json };
}

async function cleanup() {
  try {
    if (server) server.close();
    if (appId) {
      await db.execute(`DELETE FROM committee_reviews WHERE application_id = ?`, [appId]);
      await db.execute(`DELETE FROM application_status_history WHERE application_id = ?`, [appId]);
      await db.execute(`DELETE FROM scholars WHERE application_id = ?`, [appId]);
      await db.execute(`DELETE FROM applications WHERE id = ?`, [appId]);
    }
    if (studentId) await db.execute(`DELETE FROM students WHERE id = ?`, [studentId]);
    if (applicantUserId) await db.execute(`DELETE FROM users WHERE id = ?`, [applicantUserId]);
    if (committeeId) await db.execute(`DELETE FROM users WHERE id = ?`, [committeeId]);
    if (programId) {
      await db.execute(`DELETE FROM selection_runs WHERE scholarship_id = ?`, [programId]);
      await db.execute(`DELETE FROM scholarship_programs WHERE id = ?`, [programId]);
    }
    console.log('cleanup ok');
  } catch (e) {
    console.error('CLEANUP FAILED:', e.message);
  }
}

async function main() {
  // ---- fixtures: 1 program (1 slot), 1 committee member, 1 applicant ----
  const prog = await db.execute(
    `INSERT INTO scholarship_programs (name, description, slots, available_slots, deadline, status)
     VALUES ('ZZZ-Route-${rnd}', 'route e2e fixture', 1, 1,
             (CURRENT_DATE + INTERVAL '30 days')::date, 'open')`
  );
  programId = prog.insertId;

  const cm = await db.execute(
    `INSERT INTO users (uuid, email, password, role, first_name, last_name, status, is_first_login)
     VALUES (?, ?, 'x', 'committee', 'Route', 'Reviewer', 'approved', 0)`,
    [`zzz-rt-${rnd}-cm`, `zzz-rt-${rnd}-cm@test.local`]
  );
  committeeId = cm.insertId;

  const au = await db.execute(
    `INSERT INTO users (uuid, email, password, role, first_name, last_name, status, is_first_login)
     VALUES (?, ?, 'x', 'applicant', 'Alice', 'Routes', 'activated', 0)`,
    [`zzz-rt-${rnd}-alice`, `zzz-rt-${rnd}-alice@test.local`]
  );
  applicantUserId = au.insertId;

  const st = await db.execute(
    `INSERT INTO students (user_id, student_number) VALUES (?, ?)`,
    [applicantUserId, `STU-RT-${rnd}`]
  );
  studentId = st.insertId;

  const aApp = await db.execute(
    `INSERT INTO applications (application_number, student_id, scholarship_id, academic_year_id, status, total_score)
     VALUES (?, ?, ?, (SELECT id FROM academic_years WHERE is_active = TRUE LIMIT 1), 'submitted', 90)`,
    [`APP-RT-${rnd}`, studentId, programId]
  );
  appId = aApp.insertId;

  await db.execute(
    `INSERT INTO committee_reviews (application_id, committee_member_id, score, recommendation)
     VALUES (?, ?, ?, 'approve')`,
    [appId, committeeId, 90 / 20]
  );

  const committeeToken = await signToken(committeeId, 'committee');
  const applicantToken = await signToken(applicantUserId, 'applicant');

  // ---- start the real server ----
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  // R1: approve-awardees with no selection run yet -> 409
  const r1 = await http('POST', `/api/selection/${programId}/approve-awardees`, committeeToken);
  record('R1 approve-awardees: no run yet → 409', r1.status === 409, `status=${r1.status}`);

  // setup: run selection (happy path) to produce a ranked run + shortlist
  const runRes = await http('POST', `/api/selection/${programId}/run`, committeeToken);
  record('setup run → 201', runRes.status === 201, `status=${runRes.status}`);

  // R2: run selection on an unknown program -> 404
  const r2 = await http('POST', '/api/selection/999999/run', committeeToken);
  record('R2 run: unknown program → 404', r2.status === 404, `status=${r2.status}`);

  // R3: leaderboard returns ranked data -> 200
  const r3 = await http('GET', `/api/selection/${programId}/leaderboard`, committeeToken);
  const rows = r3.json && r3.json.data && r3.json.data.rows;
  const boardOk = r3.status === 200 && r3.json && r3.json.success === true && Array.isArray(rows);
  record('R3 leaderboard → 200 + data', boardOk,
    `status=${r3.status}, rows=${rows ? rows.length : 'n/a'}`);

  // setup: approve awardees so Alice is 'awarded' (single applicant, no tie)
  const approveRes = await http('POST', `/api/selection/${programId}/approve-awardees`, committeeToken);
  record('setup approve → 200', approveRes.status === 200, `status=${approveRes.status}`);

  // R4: accept-award with WRONG signature -> 400
  const r4 = await http('POST', `/api/applications/${appId}/accept-award`, applicantToken, { signature: 'Wrong Name' });
  record('R4 accept-award: wrong signature → 400', r4.status === 400, `status=${r4.status}`);

  // setup: correct accept -> scholar_active (enables R5)
  const okAccept = await http('POST', `/api/applications/${appId}/accept-award`, applicantToken, { signature: 'Alice Routes' });
  record('setup accept (correct) → 200', okAccept.status === 200, `status=${okAccept.status}`);

  // R5: decline-award on a scholar_active (non-awarded) app -> 409
  const r5 = await http('POST', `/api/applications/${appId}/decline-award`, applicantToken);
  record('R5 decline-award: scholar_active → 409', r5.status === 409, `status=${r5.status}`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} route checks passed ===`);
  cleanup().finally(() => process.exit(failed ? 1 : 0));
}

main().catch((e) => { console.error('FATAL:', e.stack || e.message); cleanup().finally(() => process.exit(1)); });