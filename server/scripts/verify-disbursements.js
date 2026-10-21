// Staff disbursement module — route-level integration tests.
//
// Drives the REAL Express app (src/app.js) over HTTP against the LIVE
// Postgres/Supabase database, passing real JWTs through the auth middleware.
// Creates its own throwaway program + scholar, exercises the whole ledger
// lifecycle, then deletes every artifact it created.
//
// Checks:
//   D1  GET  /api/disbursements/scholars            -> 200 + our scholar
//   D2  GET  /api/disbursements/scholars/:id         -> 200 + history array
//   D3  GET  /api/disbursements/summary              -> 200 + numeric totals
//   D4  POST /api/disbursements                      -> 201 pending
//   D5  POST /api/disbursements (duplicate term)     -> 409
//   D6  POST /api/disbursements (amount omitted)     -> defaults to program amount
//   D7  POST /api/disbursements/:id/release (no ref) -> 400
//   D8  POST /api/disbursements/:id/processing       -> 200 processing
//   D9  POST /api/disbursements/:id/release          -> 200 released (+stamps)
//   D10 POST /api/disbursements/:id/release (again)  -> 409
//   D11 PUT  /api/disbursements/:id (already paid)   -> 409
//   D12 GET  /api/disbursements?scholar_id=          -> ledger + totals
//   D13 POST /api/disbursements/:id/cancel (no reason)-> 400
//   D14 POST /api/disbursements/:id/cancel (reason)  -> 200 cancelled
//   D15 POST /api/disbursements/:id/release (cancelled)-> 409
//   D16 POST /api/disbursements (unknown scholar)    -> 404
//   D17 GET  /api/disbursements/summary (applicant)  -> 403
//   D18 POST /api/disbursements (revoked scholar)    -> 409
//   D19 audit_logs rows written for every transition
//   D20 scholar notifications written (scheduled/processing/released/cancelled)
//   D21 POST /api/disbursements/:id/release (representative, no name) -> 400
//   D22 POST /api/disbursements/:id/release (full receipt) -> 200 + persisted
//   D23 GET  /api/disbursements/my (scholar self-service) -> 200 + own rows
//   D24 POST /api/disbursements/my/:id/acknowledge
//       wrong signature -> 400, correct -> 200, repeat -> 409, audit written
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

Module._load = originalLoad;

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const rnd = Math.random().toString(36).slice(2, 8);
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

let server = null;
let baseUrl = '';
const created = { userIds: [], studentId: null, applicationId: null, scholarId: null, programId: null, disbursementIds: [] };

async function signToken(userId, role) {
  // db.query() returns rows directly — do NOT destructure.
  const rows = await db.query('SELECT token_version FROM users WHERE id = ?', [userId]);
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

// ------------------------------------------------------------
// SETUP — a throwaway program, an Active Scholar, and the role tokens.
// ------------------------------------------------------------
async function setup() {
  const program = await db.execute(
    `INSERT INTO scholarship_programs (name, slots, available_slots, deadline, status, amount)
     VALUES (?, 5, 5, CURRENT_DATE + 30, 'open', 20000)`,
    [`ZZZ Disbursement Program ${rnd}`]
  );
  created.programId = program.insertId;

  const staff = await db.execute(
    `INSERT INTO users (uuid, email, password, role, first_name, last_name, status, is_first_login)
     VALUES (?, ?, 'x', 'staff', 'Disb', 'Staff', 'approved', 0)`,
    [`zzz-disb-${rnd}-staff`, `zzz-disb-${rnd}-staff@test.local`]
  );
  created.userIds.push(staff.insertId);

  const applicant = await db.execute(
    `INSERT INTO users (uuid, email, password, role, first_name, last_name, status, is_first_login)
     VALUES (?, ?, 'x', 'applicant', 'Dana', 'Scholar', 'activated', 0)`,
    [`zzz-disb-${rnd}-app`, `zzz-disb-${rnd}-app@test.local`]
  );
  created.userIds.push(applicant.insertId);

  const student = await db.execute(
    `INSERT INTO students (user_id, student_number) VALUES (?, ?)`,
    [applicant.insertId, `STU-DISB-${rnd}`]
  );
  created.studentId = student.insertId;

  const application = await db.execute(
    `INSERT INTO applications (application_number, student_id, scholarship_id, academic_year_id, status, total_score, accepted_at)
     VALUES (?, ?, ?, (SELECT id FROM academic_years WHERE is_active = TRUE LIMIT 1), 'scholar_active', 95, NOW())`,
    [`APP-DISB-${rnd}`, created.studentId, created.programId]
  );
  created.applicationId = application.insertId;

  const scholar = await db.execute(
    `INSERT INTO scholars (application_id, student_id, scholarship_id, user_id, status, accepted_at)
     VALUES (?, ?, ?, ?, 'active', NOW())`,
    [created.applicationId, created.studentId, created.programId, applicant.insertId]
  );
  created.scholarId = scholar.insertId;

  return {
    staffToken: await signToken(staff.insertId, 'staff'),
    applicantToken: await signToken(applicant.insertId, 'applicant'),
  };
}

// ------------------------------------------------------------
// CLEANUP — remove every artifact this run created (idempotent).
// ------------------------------------------------------------
async function cleanup() {
  try {
    if (server) server.close();
    if (created.scholarId) {
      await db.execute('DELETE FROM disbursements WHERE scholar_id = ?', [created.scholarId]);
    }
    // audit rows for this run carry the staff actor's user_id — removed below.
    for (const userId of created.userIds) {
      await db.execute('DELETE FROM notifications WHERE user_id = ?', [userId]);
      await db.execute("DELETE FROM audit_logs WHERE user_id = ? AND entity_type = 'disbursement'", [userId]);
    }
    if (created.scholarId) await db.execute('DELETE FROM scholars WHERE id = ?', [created.scholarId]);
    if (created.applicationId) {
      await db.execute('DELETE FROM application_status_history WHERE application_id = ?', [created.applicationId]);
      await db.execute('DELETE FROM applications WHERE id = ?', [created.applicationId]);
    }
    if (created.studentId) await db.execute('DELETE FROM students WHERE id = ?', [created.studentId]);
    if (created.userIds.length) {
      await db.execute('DELETE FROM users WHERE id IN (?)', [created.userIds]);
    }
    if (created.programId) await db.execute('DELETE FROM scholarship_programs WHERE id = ?', [created.programId]);
  } catch (e) {
    console.error('cleanup warning:', e.message);
  }
}

async function main() {
  const { staffToken, applicantToken } = await setup();

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Ephemeral server listening on port ${port} (rnd=${rnd})\n`);

  // D1: GET /api/disbursements/scholars -> 200 + includes our scholar
  const d1 = await http('GET', '/api/disbursements/scholars', staffToken);
  const foundScholar = (d1.json?.scholars || []).find((s) => Number(s.id) === Number(created.scholarId));
  record('D1  GET  /scholars returns scholar list', d1.status === 200 && Boolean(foundScholar), `status=${d1.status}`);

  // D2: GET /api/disbursements/scholars/:id -> 200 with scholar profile + history
  const d2 = await http('GET', `/api/disbursements/scholars/${created.scholarId}`, staffToken);
  record('D2  GET  /scholars/:id returns profile + history', d2.status === 200 && d2.json?.data?.scholar?.id === created.scholarId && Array.isArray(d2.json?.data?.disbursements), `status=${d2.status}`);

  // D3: GET /api/disbursements/summary -> 200 + numeric counters
  const d3 = await http('GET', '/api/disbursements/summary', staffToken);
  const sData = d3.json?.data;
  const summaryOk = d3.status === 200 && typeof sData?.released_amount === 'number' && typeof sData?.pending_count === 'number';
  record('D3  GET  /summary returns aggregates', summaryOk, `status=${d3.status}`);

  // D4: POST /api/disbursements -> 201 pending release
  const d4 = await http('POST', '/api/disbursements', staffToken, {
    scholar_id: created.scholarId,
    term: '1st Tranche',
    amount: 10000,
    notes: 'Automated test release',
  });
  const disb1Id = d4.json?.data?.id;
  if (disb1Id) created.disbursementIds.push(disb1Id);
  record('D4  POST /disbursements schedules pending release', d4.status === 201 && d4.json?.data?.status === 'pending', `status=${d4.status}, id=${disb1Id}`);

  // D5: POST /api/disbursements (duplicate scholar + term) -> 409
  const d5 = await http('POST', '/api/disbursements', staffToken, {
    scholar_id: created.scholarId,
    term: '1st Tranche',
    amount: 10000,
  });
  record('D5  POST /disbursements duplicate term → 409', d5.status === 409, `status=${d5.status}`);

  // D6: POST /api/disbursements (amount omitted) -> defaults to program amount
  const d6 = await http('POST', '/api/disbursements', staffToken, {
    scholar_id: created.scholarId,
    term: '2nd Tranche',
  });
  const disb2Id = d6.json?.data?.id;
  if (disb2Id) created.disbursementIds.push(disb2Id);
  record('D6  POST /disbursements default program amount → 201', d6.status === 201 && Number(d6.json?.data?.amount) === 20000, `status=${d6.status}, amount=${d6.json?.data?.amount}`);

  // D7: POST /api/disbursements/:id/release WITHOUT reference number -> 400
  const d7 = await http('POST', `/api/disbursements/${disb1Id}/release`, staffToken, {});
  record('D7  POST /release without reference_number → 400', d7.status === 400, `status=${d7.status}`);

  // D8: POST /api/disbursements/:id/processing -> 200 processing
  const d8 = await http('POST', `/api/disbursements/${disb1Id}/processing`, staffToken);
  record('D8  POST /processing marks status → 200', d8.status === 200 && d8.json?.data?.status === 'processing', `status=${d8.status}`);

  // D9: POST /api/disbursements/:id/release WITH ref -> 200 released
  // The scholar collects the cash in person, so no recipient name is sent —
  // the service must default it to the scholar's registered full name.
  const d9 = await http('POST', `/api/disbursements/${disb1Id}/release`, staffToken, {
    reference_no: `REF-TEST-${rnd}`,
    notes: 'Transferred via automated route test',
    claimed_by: 'self',
    id_verified: true,
  });
  record(
    'D9  POST /release completes payout → 200 released (receipt: self)',
    d9.status === 200 &&
      d9.json?.data?.status === 'released' &&
      d9.json?.data?.reference_no === `REF-TEST-${rnd}` &&
      d9.json?.data?.claimed_by === 'self' &&
      d9.json?.data?.recipient_name === 'Dana Scholar',
    `status=${d9.status}, recipient=${d9.json?.data?.recipient_name}`
  );



  // D10: POST /api/disbursements/:id/release AGAIN -> 409 already released
  const d10 = await http('POST', `/api/disbursements/${disb1Id}/release`, staffToken, { reference_no: 'XYZ-REF' });
  record('D10 POST /release on already released → 409', d10.status === 409, `status=${d10.status}`);

  // D11: PUT /api/disbursements/:id on released disbursement -> 409 immutable
  const d11 = await http('PUT', `/api/disbursements/${disb1Id}`, staffToken, { remarks: 'illegal edit' });
  record('D11 PUT  /disbursements/:id on released → 409 immutable', d11.status === 409, `status=${d11.status}`);

  // D12: GET /api/disbursements?scholar_id= -> ledger listing + totals
  const d12 = await http('GET', `/api/disbursements?scholar_id=${created.scholarId}`, staffToken);
  const ledgerRows = d12.json?.disbursements || [];
  const ledgerTotals = d12.json?.totals;
  record('D12 GET  /disbursements filtered ledger + totals → 200', d12.status === 200 && ledgerRows.length >= 2 && Number(ledgerTotals?.released_amount) === 10000, `status=${d12.status}, released_amount=${ledgerTotals?.released_amount}`);

  // D13: POST /api/disbursements/:id/cancel WITHOUT reason -> 400
  const d13 = await http('POST', `/api/disbursements/${disb2Id}/cancel`, staffToken, {});
  record('D13 POST /cancel without reason → 400', d13.status === 400, `status=${d13.status}`);

  // D14: POST /api/disbursements/:id/cancel WITH reason -> 200 cancelled
  const d14 = await http('POST', `/api/disbursements/${disb2Id}/cancel`, staffToken, { reason: 'Automated cancellation check' });
  record('D14 POST /cancel with reason → 200 cancelled', d14.status === 200 && d14.json?.data?.status === 'cancelled', `status=${d14.status}`);

  // D15: POST /api/disbursements/:id/release on CANCELLED -> 409
  const d15 = await http('POST', `/api/disbursements/${disb2Id}/release`, staffToken, { reference_no: 'TEST-REF' });
  record('D15 POST /release on cancelled → 409', d15.status === 409, `status=${d15.status}`);

  // D16: POST /api/disbursements on non-existent scholar -> 404
  const d16 = await http('POST', '/api/disbursements', staffToken, { scholar_id: 9999999, term: '404 Probe Term' });
  record('D16 POST /disbursements unknown scholar → 404', d16.status === 404, `status=${d16.status}`);

  // D17: Role gating — applicant cannot view summary -> 403
  const d17 = await http('GET', '/api/disbursements/summary', applicantToken);
  record('D17 GET  /summary as applicant → 403 forbidden', d17.status === 403, `status=${d17.status}`);

  // D18: Try scheduling for revoked scholar -> 409
  await db.execute('UPDATE scholars SET status = ? WHERE id = ?', ['revoked', created.scholarId]);
  const d18 = await http('POST', '/api/disbursements', staffToken, { scholar_id: created.scholarId, term: '3rd Tranche' });
  record('D18 POST /disbursements on revoked scholar → 409', d18.status === 409, `status=${d18.status}`);

  // D19: Audit log check — verify that actions were persisted
  const auditLogs = await db.query(
    "SELECT action FROM audit_logs WHERE entity_type = 'disbursement' AND entity_id::text = ? ORDER BY id ASC",
    [String(disb1Id)]
  );
  const actions = (auditLogs || []).map((r) => r.action);
  const auditOk = actions.includes('DISBURSEMENT_SCHEDULED') && actions.includes('DISBURSEMENT_PROCESSING') && actions.includes('DISBURSEMENT_RELEASED');
  record('D19 audit_logs rows created for scheduled/processing/released', auditOk, `actions=${actions.join(', ')}`);

  // D20: Notifications check — scholar inbox received notifications
  const notifs = await db.query(
    'SELECT title FROM notifications WHERE user_id = ? ORDER BY id ASC',
    [created.userIds[1]]
  );
  const notifTitles = (notifs || []).map((n) => n.title);
  record('D20 scholar received notifications', notifTitles.length >= 2, `titles=${notifTitles.slice(0, 3).join(' | ')}`);

  // ------------------------------------------------------------
  // D21..D24 — walk-in receipt + scholar acknowledgment (migration 005).
  // D18 revoked the scholar to prove the standing guard, so restore active
  // standing before scheduling/releasing the receipt-test rows.
  // ------------------------------------------------------------
  await db.execute('UPDATE scholars SET status = ? WHERE id = ?', ['active', created.scholarId]);

  const repScheduled = await http('POST', '/api/disbursements', staffToken, {
    scholar_id: created.scholarId,
    term: 'Representative Claim Term',
    amount: 5000,
  });
  const repId = repScheduled.json?.data?.id;
  if (repId) created.disbursementIds.push(repId);
  record(
    'D21a POST /disbursements schedules the receipt-test row → 201',
    repScheduled.status === 201,
    `status=${repScheduled.status}, id=${repId}`
  );

  // D21: a representative collected the cash but no name was recorded -> 400
  const d21 = await http('POST', `/api/disbursements/${repId}/release`, staffToken, {
    reference_no: `REF-REP-${rnd}`,
    claimed_by: 'representative',
  });
  record(
    'D21 POST /release representative without recipient name → 400',
    d21.status === 400,
    `status=${d21.status}`
  );

  // D22: complete walk-in receipt -> 200 and every field persisted
  const d22 = await http('POST', `/api/disbursements/${repId}/release`, staffToken, {
    reference_no: `REF-REP-${rnd}`,
    claimed_by: 'representative',
    recipient_name: 'Rosa Reyes',
    claimant_id_note: 'School ID 2023-00123 + authorization letter',
    id_verified: true,
  });
  const receiptRows = await db.query(
    'SELECT claimed_by, recipient_name, claimant_id_note, id_verified FROM disbursements WHERE id = ?',
    [repId]
  );
  const persisted = (receiptRows && receiptRows[0]) || {};
  record(
    'D22 POST /release records the representative receipt → 200 + persisted',
    d22.status === 200 &&
      persisted.claimed_by === 'representative' &&
      persisted.recipient_name === 'Rosa Reyes' &&
      persisted.id_verified === true,
    `status=${d22.status}, recipient=${persisted.recipient_name}, id_verified=${persisted.id_verified}`
  );

  // D23: the scholar's own view — only their releases, with the awaiting count
  const d23 = await http('GET', '/api/disbursements/my', applicantToken);
  const myRows = d23.json?.data?.disbursements || [];
  const awaiting = Number(d23.json?.data?.totals?.awaiting_acknowledgment_count);
  record(
    'D23 GET  /disbursements/my returns the scholar\'s own releases → 200',
    d23.status === 200 &&
      Number(d23.json?.data?.scholar?.id) === Number(created.scholarId) &&
      myRows.length >= 2 &&
      awaiting >= 2,
    `status=${d23.status}, releases=${myRows.length}, awaiting=${d23.json?.data?.totals?.awaiting_acknowledgment_count}`
  );

  // D24: acknowledgment — wrong signature 400, correct 200, repeat 409, audited
  const wrongSig = await http('POST', `/api/disbursements/my/${disb1Id}/acknowledge`, applicantToken, {
    signature: 'Not The Real Name',
  });
  const rightSig = await http('POST', `/api/disbursements/my/${disb1Id}/acknowledge`, applicantToken, {
    signature: 'Dana Scholar',
  });
  const repeatSig = await http('POST', `/api/disbursements/my/${disb1Id}/acknowledge`, applicantToken, {
    signature: 'Dana Scholar',
  });
  const ackRows = await db.query('SELECT acknowledged_at FROM disbursements WHERE id = ?', [disb1Id]);
  const ackAudit = await db.query(
    "SELECT id FROM audit_logs WHERE entity_type = 'disbursement' AND entity_id::text = ? AND action = 'DISBURSEMENT_RECEIVED'",
    [String(disb1Id)]
  );
  record(
    'D24 scholar acknowledgment: wrong 400 → correct 200 → repeat 409 + audit row',
    wrongSig.status === 400 &&
      rightSig.status === 200 &&
      Boolean(ackRows && ackRows[0] && ackRows[0].acknowledged_at) &&
      repeatSig.status === 409 &&
      (ackAudit || []).length >= 1,
    `wrong=${wrongSig.status}, ok=${rightSig.status}, repeat=${repeatSig.status}, audit=${(ackAudit || []).length}`
  );

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} disbursement checks passed ===`);
  cleanup().finally(() => process.exit(failed ? 1 : 0));
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  cleanup().finally(() => process.exit(1));
});

