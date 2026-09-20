// Phase 0 — End-to-end verification of slot decoupling (slot-model v2).
// Proves against the LIVE database that:
//   1. Application.submit() succeeds WITHOUT consuming available_slots.
//   2. The duplicate-application guard still blocks a second active application.
//   3. Concurrent submissions from different students both succeed.
//   4. available_slots is untouched by all of the above.
// Creates throwaway rows with a ZZZ prefix and cleans up in `finally`.
// Exits 0 on success.
require('dotenv').config();
const db = require('../src/config/database');
const Application = require('../src/models/applicationModel');

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const rnd = Math.random().toString(36).slice(2, 8);

(async () => {
  let programId = null;
  const userIds = [];
  try {
    // ---- throwaway program: open, 5 slots, deadline in 30 days ----
    // NOTE: db.execute() returns { affectedRows, insertId } (not an array).
    const prog = await db.execute(
      `INSERT INTO scholarship_programs
         (name, description, slots, available_slots, deadline, status)
       VALUES ('ZZZ-Phase0-Test-Program-${rnd}', 'temporary verification program', 5, 5,
               (CURRENT_DATE + INTERVAL '30 days')::date, 'open')`
    );
    programId = prog.insertId;

    // ---- throwaway applicant users ----
    for (let i = 1; i <= 3; i += 1) {
      const u = await db.execute(
        `INSERT INTO users (uuid, email, password, role, first_name, last_name, status, is_first_login)
         VALUES (?, ?, 'x-not-a-real-hash', 'applicant', 'Phase0', 'Test${i}', 'activated', 0)`,
        [`zzz-phase0-uuid-${rnd}-${i}`, `zzz-phase0-${rnd}-${i}@test.local`]
      );
      userIds.push(u.insertId);
    }

    const slots = async () => {
      const [p] = await db.query(
        'SELECT available_slots FROM scholarship_programs WHERE id = ?', [programId]
      );
      return Number(p.available_slots);
    };

    const slotsBefore = await slots();

    // ---- 1. single submit must NOT consume a slot ----
    const app1 = await Application.submit(
      { scholarshipId: programId, answers: {} }, userIds[0], []
    );
    record(
      'submit() succeeds without slot consumption',
      (await slots()) === slotsBefore,
      `available_slots ${slotsBefore} → ${await slots()}`
    );

    // ---- 2. duplicate guard: same student, same program ----
    try {
      await Application.submit({ scholarshipId: programId, answers: {} }, userIds[0], []);
      record('duplicate application blocked', false, 'second submit unexpectedly succeeded');
    } catch (e) {
      record(
        'duplicate application blocked',
        e.status === 409,
        `status=${e.status || 'n/a'} msg=${e.message.slice(0, 60)}`
      );
    }

    // ---- 3. concurrent submits from different students both succeed ----
    const [app2, app3] = await Promise.all([
      Application.submit({ scholarshipId: programId, answers: {} }, userIds[1], []),
      Application.submit({ scholarshipId: programId, answers: {} }, userIds[2], []),
    ]);
    record(
      'concurrent submits (2 students) both succeed',
      Boolean(app2 && app3 && app2.id && app3.id),
      `apps #${app2.id}, #${app3.id}`
    );

    // ---- 4. slots still untouched after all submits ----
    const slotsAfter = await slots();
    record(
      'available_slots untouched overall',
      slotsAfter === slotsBefore,
      `${slotsBefore} → ${slotsAfter}`
    );
  } finally {
    // ---- cleanup (users cascade → students → applications → documents) ----
    try {
      if (userIds.length) {
        await db.execute(`DELETE FROM users WHERE id IN (?)`, [userIds]);
      }
      if (programId) {
        await db.execute(`DELETE FROM scholarship_programs WHERE id = ?`, [programId]);
      }
      console.log('cleanup ok (throwaway rows removed)');
    } catch (e) {
      console.error('CLEANUP FAILED — remove ZZZ-Phase0-* rows manually:', e.message);
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} checks passed ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
