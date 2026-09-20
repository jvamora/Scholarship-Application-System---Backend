// Phase 2 — End-to-end integration test of the full award pipeline
// against the LIVE Supabase database. Exercises every selectionService
// function in sequence and cleans up all throwaway rows afterwards.
//
// Scenario: 1 program (2 slots), 5 applicants with varied scores, including
// an EXACT TIE at the rank-2 cutoff to exercise tie resolution.
require('dotenv').config();
const db = require('../src/config/database');
const selectionService = require('../src/services/selectionService');
const { SelectionError } = selectionService;

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// Invariant: available_slots + (count of awarded + scholar_active apps) === slots
// Every slot is either free (available_slots), pending acceptance ('awarded'),
// or accepted ('scholar_active'). Declined/forfeited apps free their slot.
async function checkSlotsInvariant(label) {
  const [p] = await db.query(`SELECT slots, available_slots FROM scholarship_programs WHERE id = ?`, [programId]);
  const [occRow] = await db.query(
    `SELECT COUNT(*)::int AS n FROM applications WHERE scholarship_id = ? AND status IN ('awarded', 'scholar_active')`,
    [programId]
  );
  const slots = Number(p.slots);
  const avail = Number(p.available_slots);
  const occupied = Number(occRow?.n || 0);
  const ok = avail + occupied === slots;
  record(`${label}: slot invariant`, ok, `avail=${avail} + occupied=${occupied} = ${avail + occupied}, slots=${slots}`);
}

const rnd = Math.random().toString(36).slice(2, 8);
const sig = (first, last) => `${first} ${last}`.trim();

let programId = null;
let bonusProgramId = null;
const userIds = [];
const appIds = [];
let committeeMemberId = null;

async function cleanup() {
  try {
    if (appIds.length) {
      await db.execute(`DELETE FROM committee_reviews WHERE application_id IN (?)`, [appIds]);
      await db.execute(`DELETE FROM application_status_history WHERE application_id IN (?)`, [appIds]);
      await db.execute(`DELETE FROM scholars WHERE application_id IN (?)`, [appIds]);
      await db.execute(`DELETE FROM applications WHERE id IN (?)`, [appIds]);
    }
    if (userIds.length) {
      await db.execute(`DELETE FROM students WHERE user_id IN (?)`, [userIds]);
      await db.execute(`DELETE FROM users WHERE id IN (?)`, [userIds]);
    }
    if (committeeMemberId) await db.execute(`DELETE FROM users WHERE id = ?`, [committeeMemberId]);
    if (programId) {
      await db.execute(`DELETE FROM selection_runs WHERE scholarship_id = ?`, [programId]);
      await db.execute(`DELETE FROM scholarship_programs WHERE id = ?`, [programId]);
    }
    if (bonusProgramId) {
      await db.execute(`DELETE FROM selection_runs WHERE scholarship_id = ?`, [bonusProgramId]);
      await db.execute(`DELETE FROM scholarship_programs WHERE id = ?`, [bonusProgramId]);
    }
    const allUsers = [...userIds, committeeMemberId].filter(Boolean);
    if (allUsers.length) {
      await db.execute(`DELETE FROM notifications WHERE user_id IN (?) OR reference_id = ?`, [allUsers, programId]);
    }
    console.log('cleanup ok');
  } catch (e) {
    console.error('CLEANUP FAILED:', e.message);
  }
}

async function main() {
  // ---- program: 2 slots, open, deadline in 30 days ----
  const prog = await db.execute(
    `INSERT INTO scholarship_programs (name, description, slots, available_slots, deadline, status)
     VALUES ('ZZZ-Phase2-Pipeline-${rnd}', 'e2e pipeline test', 2, 2,
             (CURRENT_DATE + INTERVAL '30 days')::date, 'open')`
  );
  programId = prog.insertId;

  // ---- a committee member to author reviews ----
  const cm = await db.execute(
    `INSERT INTO users (uuid, email, password, role, first_name, last_name, status, is_first_login)
     VALUES (?, ?, 'x', 'committee', 'Phase2', 'Committee', 'approved', 0)`,
    [`zzz-cm-${rnd}`, `zzz-cm-${rnd}@test.local`]
  );
  committeeMemberId = cm.insertId;

  // ---- 5 applicants: scores 95, 80, 80 (TIE), 65, 50 ----
  const applicants = [
    { first: 'Alice', last: 'A', target: 95 },
    { first: 'Bob', last: 'B', target: 80 },
    { first: 'Carol', last: 'C', target: 80 },
    { first: 'Dave', last: 'D', target: 65 },
    { first: 'Erin', last: 'E', target: 50 },
  ];
  for (const a of applicants) {
    const u = await db.execute(
      `INSERT INTO users (uuid, email, password, role, first_name, last_name, status, is_first_login)
       VALUES (?, ?, 'x', 'applicant', ?, ?, 'activated', 0)`,
      [`zzz-${rnd}-${a.first}`, `zzz-${rnd}-${a.first}@test.local`, a.first, a.last]
    );
    userIds.push(u.insertId);
    const st = await db.execute(`INSERT INTO students (user_id, student_number) VALUES (?, ?)`, [u.insertId, `STU-ZZZ-${rnd}-${a.first}`]);
    const app = await db.execute(
      `INSERT INTO applications (application_number, student_id, scholarship_id, academic_year_id, status, total_score)
       VALUES (?, ?, ?, (SELECT id FROM academic_years WHERE is_active = TRUE LIMIT 1), 'submitted', ?)`,
      [`APP-ZZZ-${rnd}-${a.first}`, st.insertId, programId, a.target]
    );
    appIds.push(app.insertId);
    await db.execute(
      `INSERT INTO committee_reviews (application_id, committee_member_id, score, recommendation)
       VALUES (?, ?, ?, 'approve')`,
      [app.insertId, committeeMemberId, a.target / 20]
    );
  }

  // ---- 1. runSelection ----
  const run = await selectionService.runSelection(programId, committeeMemberId);
  record('runSelection returns runId', !!run.runId, `runId=${run.runId}`);
  record('runSelection: 2 shortlisted', run.shortlisted === 2, `shortlisted=${run.shortlisted}`);
  record('runSelection: 3 waitlisted (window covers ranks 3-5)', run.waitlisted === 3, `waitlisted=${run.waitlisted}`);
  record('runSelection: 0 rejected', run.rejected === 0, `rejected=${run.rejected}`);
  record('runSelection: tie detected at cutoff', run.ties.length > 0, `ties=${JSON.stringify(run.ties)}`);

  // ---- 2. getLeaderboard ----
  const board = await selectionService.getLeaderboard(programId);
  record('getLeaderboard: 5 ranked rows', board.rows.length === 5, `rows=${board.rows.length}`);
  record('getLeaderboard: blockingTies > 0', board.blockingTies > 0, `blockingTies=${board.blockingTies}`);
  record('getLeaderboard: cutoff = 2', board.program.cutoff === 2, `cutoff=${board.program.cutoff}`);

// ---- 3. approveAwardees must be BLOCKED by the unresolved tie ----
let blocked = false;
try {
  await selectionService.approveAwardees(programId, committeeMemberId);
} catch (e) {
  blocked = e instanceof SelectionError && e.status === 409;
}
record('approveAwardees blocked by unresolved tie', blocked);

// ---- 4. resolveTies: keep Bob (rank 2) inside, push Carol out ----
const bobId = appIds[1];
const resolved = await selectionService.resolveTies(
  programId, [bobId], 'prioritized by earlier submission timestamp', committeeMemberId
);
record('resolveTies: resolved the group', resolved.resolved >= 2, `resolved=${resolved.resolved}`);

const board2 = await selectionService.getLeaderboard(programId);
record('after resolution: blockingTies = 0', board2.blockingTies === 0, `blockingTies=${board2.blockingTies}`);

// ---- 5. approveAwardees now succeeds ----
const approval = await selectionService.approveAwardees(programId, committeeMemberId);
record('approveAwardees: 2 approved', approval.approved === 2, `approved=${approval.approved}`);

const [progCheck] = await db.query(`SELECT status, available_slots FROM scholarship_programs WHERE id = ?`, [programId]);
record('program status = closed', progCheck.status === 'closed', `status=${progCheck.status}`);
record('available_slots = 0 after approval', Number(progCheck.available_slots) === 0, `slots=${progCheck.available_slots}`);
await checkSlotsInvariant('after approval');

// ---- 6. acceptAward: Alice (rank 1) accepts with matching signature ----
const aliceAppId = appIds[0];
const accepted = await selectionService.acceptAward(aliceAppId, userIds[0], sig('Alice', 'A'));
record('acceptAward: scholar_active', accepted.status === 'scholar_active', `status=${accepted.status}`);

const [scholar] = await db.query(`SELECT id, status FROM scholars WHERE application_id = ?`, [aliceAppId]);
record('scholars row created', !!scholar && scholar.status === 'active', `scholar=${JSON.stringify(scholar)}`);
await checkSlotsInvariant('after acceptAward');

// ---- 7. acceptAward: WRONG signature rejected (Bob is awarded) ----
let sigBlocked = false;
try {
  await selectionService.acceptAward(appIds[1], userIds[1], 'Wrong Name');
} catch (e) {
  sigBlocked = e instanceof SelectionError && e.status === 400;
}
record('acceptAward: wrong signature rejected', sigBlocked);

// ---- 8. declineAward: Bob (rank 2) declines → Carol (rank 3) promoted ----
const bobAppId = appIds[1];
const declined = await selectionService.declineAward(bobAppId, userIds[1]);
record('declineAward: award_declined', declined.status === 'award_declined', `status=${declined.status}`);
record('declineAward: promoted next waitlisted', declined.promoted.length === 1, `promoted=${declined.promoted.length}`);

const [carolApp] = await db.query(`SELECT status FROM applications WHERE id = ?`, [appIds[2]]);
record('declineAward: Carol promoted to awarded', carolApp.status === 'awarded', `status=${carolApp.status}`);
await checkSlotsInvariant('after decline');

// ---- 9. sweepExpiredAwards: force Carol's award to expire, then sweep ----
await db.execute(`UPDATE applications SET award_expires_at = NOW() - INTERVAL '1 minute' WHERE id = ?`, [appIds[2]]);
const sweep = await selectionService.sweepExpiredAwards();
record('sweepExpiredAwards: 1 forfeited', sweep.forfeited === 1, `forfeited=${sweep.forfeited}`);

const [carolAfter] = await db.query(`SELECT status FROM applications WHERE id = ?`, [appIds[2]]);
record('sweep: Carol forfeited', carolAfter.status === 'award_forfeited', `status=${carolAfter.status}`);

// The sweep auto-promotes Dave from the waitlist when Carol's slot is released.
record('sweep: promoted Dave from waitlist', sweep.promoted === 1, `promoted=${sweep.promoted}`);
await checkSlotsInvariant('after sweep');

// ---- 10. promoteNextWaitlisted: no slots left (Dave already promoted by sweep) ----
const promo = await selectionService.promoteNextWaitlisted(programId, committeeMemberId, 'e2e manual');
record('promoteNextWaitlisted: 0 promoted (slots full)', promo.promoted.length === 0, `promoted=${promo.promoted.length}`);

const [daveApp] = await db.query(`SELECT status FROM applications WHERE id = ?`, [appIds[3]]);
record('promoteNextWaitlisted: Dave awarded by sweep', daveApp.status === 'awarded', `status=${daveApp.status}`);
await checkSlotsInvariant('final state');

// ---- 11. promoteNextWaitlisted happy path: admin opens an extra slot, Erin promoted ----
// Erin (rank 5) is still waitlisted after the sweep promoted Dave. Open one more
// slot (simulating an admin adding capacity) and verify Erin gets promoted.
await db.execute(`UPDATE scholarship_programs SET slots = slots + 1, available_slots = available_slots + 1 WHERE id = ?`, [programId]);
const promo2 = await selectionService.promoteNextWaitlisted(programId, committeeMemberId, 'e2e manual slot opened');
record('promoteNextWaitlisted happy path: 1 promoted', promo2.promoted.length === 1, `promoted=${promo2.promoted.length}`);

const [erinApp] = await db.query(`SELECT status FROM applications WHERE id = ?`, [appIds[4]]);
record('promoteNextWaitlisted: Erin promoted to awarded', erinApp.status === 'awarded', `status=${erinApp.status}`);
await checkSlotsInvariant('after promoteNextWaitlisted happy path');

// =====================
// 12. ERROR-PATH CHECKS (selectionService guards return correct HTTP codes)
// =====================

// 12a. runSelection on a program that does not exist → 404.
let notFound404 = false;
try {
  await selectionService.runSelection(999999, committeeMemberId);
} catch (e) {
  notFound404 = e instanceof SelectionError && e.status === 404;
}
record('runSelection: unknown program → 404', notFound404);

// 12b. approveAwardees called a second time → 409 (run already locked).
let doubleApprove409 = false;
try {
  await selectionService.approveAwardees(programId, committeeMemberId);
} catch (e) {
  doubleApprove409 = e instanceof SelectionError && e.status === 409;
}
record('approveAwardees: second call → 409 (already locked)', doubleApprove409);

// 12c. acceptAward on Alice, who already accepted → 409 (scholar_active).
let reAccept409 = false;
try {
  await selectionService.acceptAward(appIds[0], userIds[0], sig('Alice', 'A'));
} catch (e) {
  reAccept409 = e instanceof SelectionError && e.status === 409;
}
record('acceptAward: already-accepted app → 409', reAccept409);

// 12d. declineAward on Alice, who is scholar_active (not 'awarded') → 409.
let declineActive409 = false;
try {
  await selectionService.declineAward(appIds[0], userIds[0]);
} catch (e) {
  declineActive409 = e instanceof SelectionError && e.status === 409;
}
record('declineAward: non-awarded app → 409', declineActive409);

// 12e. approveAwardees on a program with no selection run yet → 409.
const bonusProg = await db.execute(
  `INSERT INTO scholarship_programs (name, description, slots, available_slots, deadline, status)
   VALUES ('ZZZ-Phase2-NoRun-${rnd}', 'error-path fixture', 1, 1,
           (CURRENT_DATE + INTERVAL '30 days')::date, 'open')`
);
bonusProgramId = bonusProg.insertId;
let noRun409 = false;
try {
  await selectionService.approveAwardees(bonusProgramId, committeeMemberId);
} catch (e) {
  noRun409 = e instanceof SelectionError && e.status === 409;
}
record('approveAwardees: program with no run → 409', noRun409);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n=== ${results.length - failed}/${results.length} pipeline checks passed ===`);
cleanup().finally(() => process.exit(failed ? 1 : 0));
};

main().catch((e) => { console.error('FATAL:', e.stack || e.message); cleanup().finally(() => process.exit(1)); });

