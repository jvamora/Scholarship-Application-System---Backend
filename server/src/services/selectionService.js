// ============================================================
// selectionService — slot-model v2 award pipeline.
//
// SINGLE OWNER of available_slots and award-state transitions.
// Nothing outside this service may consume/free award slots or move an
// application into an award state (shortlisted/awarded/scholar_active/
// award_declined/award_forfeited).
// ============================================================
const { query, execute, transaction } = require('../config/database');
const { logAdminAction } = require('../utils/auditLogger');

const WAITLIST_WINDOW = Math.max(1, parseInt(process.env.WAITLIST_WINDOW || '10', 10));
const ACCEPT_DAYS = Math.max(1, parseInt(process.env.AWARD_ACCEPTANCE_DAYS || '7', 10));

// Statuses eligible for ranking at selection time. Locked award states and
// withdrawn applications are never re-ranked.
const RANKED_POOL_STATUSES = [
  'submitted', 'under_review', 'committee_review',
  'approved', 'rejected', 'waitlisted', 'shortlisted',
];

class SelectionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// The live cutoff: how many awards this program still has to give.
function cutoffFor(program) {
  const n = Number(program.available_slots ?? program.slots ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function tagForRank(rank, cutoff) {
  if (rank <= cutoff) return 'shortlisted';
  if (rank <= cutoff + WAITLIST_WINDOW) return 'waitlisted';
  return 'rejected';
}

// Notify the owning applicant (non-fatal inside transactions).
async function notifyApplicantTx(connection, applicationId, title, message, type = 'info') {
  try {
    const [rows] = await connection.query(
      `SELECT u.id AS user_id, a.application_number, sp.name AS scholarship_name
         FROM applications a
         JOIN students st ON st.id = a.student_id
         JOIN users u ON u.id = st.user_id
         JOIN scholarship_programs sp ON sp.id = a.scholarship_id
        WHERE a.id = ? LIMIT 1`,
      [applicationId]
    );
    const app = rows && rows[0];
    if (!app) return;
    const text = typeof message === 'function' ? message(app) : message;
    await connection.query(
      `INSERT INTO notifications (user_id, title, message, type, reference_type, reference_id)
       VALUES (?, ?, ?, ?, 'application', ?)`,
      [app.user_id, title, text, type, applicationId]
    );
  } catch (e) {
    console.error(`[selectionService] notify failed for app #${applicationId}:`, e.message);
  }
}

// Notify every active admin (non-fatal).
async function notifyAdmins(title, message, type = 'warning', referenceId = null) {
  try {
    const admins = await query(
      `SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE AND deleted_at IS NULL`
    );
    for (const a of admins || []) {
      await execute(
        `INSERT INTO notifications (user_id, title, message, type, reference_type, reference_id)
         VALUES (?, ?, ?, ?, 'scholarship', ?)`,
        [a.id, title, message, type, referenceId]
      );
    }
  } catch (e) {
    console.error('[selectionService] admin notify failed:', e.message);
  }
}

// Core rank-and-tag algorithm, shared by the selection run and tie resolution.
async function applyRanks(connection, runId, ranked, cutoff, actorId, remarkPrefix) {
  // --- straddling-tie detection: an exact-score group spanning the cutoff ---
  // Keyed on the precise weighted score (4dp), so after rounding there are no
  // false "ties" on integer collapses — only genuinely identical scores.
  const groups = new Map();
  ranked.forEach((a, idx) => {
    const key = (a.total_score_precise != null ? Number(a.total_score_precise) : Number(a.total_score)).toFixed(4);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(idx + 1); // 1-based rank
  });
  const tieRanks = new Set();
  for (const ranks of groups.values()) {
    const min = Math.min(...ranks);
    const max = Math.max(...ranks);
    if (min <= cutoff && max > cutoff) ranks.forEach((r) => tieRanks.add(r));
  }

  let shortlisted = 0;
  let waitlisted = 0;
  let rejected = 0;
  const ties = [];

  for (let i = 0; i < ranked.length; i += 1) {
    const rank = i + 1;
    const app = ranked[i];
    const isTie = tieRanks.has(rank);
    const nextStatus = tagForRank(rank, cutoff);
    if (nextStatus === 'shortlisted') shortlisted += 1;
    else if (nextStatus === 'waitlisted') waitlisted += 1;
    else rejected += 1;
    if (isTie) ties.push({ id: app.id, rank, score: Number(app.total_score) });

    const changed = app.status !== nextStatus;
    await connection.query(
      `UPDATE applications
          SET status = ?, selection_rank = ?, selection_tie = ?, selection_run_id = ?
        WHERE id = ?`,
      [nextStatus, rank, isTie, runId, app.id]
    );
    if (changed) {
      await connection.query(
        `INSERT INTO application_status_history (application_id, status, remarks, changed_by)
         VALUES (?, ?, ?, ?)`,
        [app.id, nextStatus,
         `${remarkPrefix}: ranked #${rank} of ${ranked.length} (score ${Number(app.total_score)}) → ${nextStatus}`,
         actorId]
      );
      await notifyApplicantTx(
        connection, app.id, 'Application Update',
        (a) => `"${a.scholarship_name}" — your application is now "${String(nextStatus).replace(/_/g, ' ')}" (rank #${rank}).`,
        nextStatus === 'shortlisted' ? 'success' : nextStatus === 'waitlisted' ? 'warning' : 'info'
      );
    }
  }
  return { shortlisted, waitlisted, rejected, ties };
}

// ------------------------------------------------------------
// System Shortlisting — rank all evaluated applications of a program.
// ------------------------------------------------------------
async function runSelection(scholarshipId, actorId) {
  return transaction(async (connection) => {
    const [progs] = await connection.query(
      `SELECT * FROM scholarship_programs WHERE id = ? FOR UPDATE`, [scholarshipId]
    );
    const program = progs && progs[0];
    if (!program) throw new SelectionError('Scholarship program not found.', 404);
    if (program.status === 'draft') {
      throw new SelectionError('Draft programs cannot be ranked. Publish the program first.', 400);
    }
    if (program.status === 'completed') {
      throw new SelectionError('This program is completed and can no longer be ranked.', 409);
    }

    const cutoff = cutoffFor(program);
    if (cutoff <= 0) {
      throw new SelectionError(
        'This program has no available slots to award (available_slots is 0).', 409
      );
    }

    // A locked run means the cycle was finalized — no re-ranking afterwards.
    const [lockedRuns] = await connection.query(
      `SELECT id FROM selection_runs WHERE scholarship_id = ? AND locked_at IS NOT NULL LIMIT 1`,
      [scholarshipId]
    );
    if (lockedRuns && lockedRuns.length > 0) {
      throw new SelectionError(
        'A locked selection already exists for this program. Re-ranking is disabled after final approval.',
        409
      );
    }

    // Ranked pool: evaluated (≥1 review AND a score), not withdrawn, not locked.
    const [pool] = await connection.query(
      `SELECT a.id, a.status, a.total_score, a.total_score_precise, a.created_at,
              (SELECT COUNT(*) FROM committee_reviews cr WHERE cr.application_id = a.id) AS review_count
         FROM applications a
        WHERE a.scholarship_id = ?
          AND a.status IN (?)
        ORDER BY a.created_at ASC`,
      [scholarshipId, RANKED_POOL_STATUSES]
    );

    const ranked = (pool || [])
      .filter((a) => Number(a.review_count) > 0 && a.total_score != null)
      .sort((x, y) => {
        // Primary: precise weighted score (0-100, 4dp) — makes exact ties rare.
        const sx = x.total_score_precise != null ? Number(x.total_score_precise) : Number(x.total_score);
        const sy = y.total_score_precise != null ? Number(y.total_score_precise) : Number(y.total_score);
        if (sy !== sx) return sy - sx;
        // Deterministic tie-break cascade (safety net for a rare exact tie):
        return (new Date(x.created_at) - new Date(y.created_at)) || (Number(x.id) - Number(y.id));
      });

    // Reviewed but score-less (reopened for re-evaluation) → back to review.
    const unranked = (pool || []).filter(
      (a) => !(Number(a.review_count) > 0 && a.total_score != null)
    );

    // Snapshot the run first so updates can reference it.
    const run = await connection.execute(
      `INSERT INTO selection_runs
         (scholarship_id, cutoff_rank, waitlist_size, total_evaluated, tie_policy, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [scholarshipId, cutoff, WAITLIST_WINDOW, ranked.length, 'auto', actorId]
    );
    const runId = run.insertId;

    const counts = await applyRanks(connection, runId, ranked, cutoff, actorId, 'Selection run');

    for (const a of unranked) {
      if (a.status === 'withdrawn') continue;
      if (a.status !== 'committee_review') {
        await connection.query(
          `INSERT INTO application_status_history (application_id, status, remarks, changed_by)
           VALUES (?, 'committee_review', 'Removed from selection — awaiting re-evaluation (no score)', ?)`,
          [a.id, actorId]
        );
      }
      await connection.query(
        `UPDATE applications
            SET status = 'committee_review', selection_rank = NULL, selection_tie = FALSE
          WHERE id = ?`,
        [a.id]
      );
    }

    if (counts.ties.length > 0) {
      await notifyAdmins(
        'Tie at the cutoff — manual decision required',
        `Program "${program.name}": ${counts.ties.length} applicant(s) share a score across the rank-${cutoff} cutoff. Resolve the tie(s) in the Selection Leaderboard before approving awardees.`,
        'warning',
        scholarshipId
      );
    }

    logAdminAction({ actorId, action: 'SELECTION_RUN', entityType: 'scholarship', entityId: scholarshipId, details: { runId, evaluated: ranked.length, cutoff } });

    return {
      runId,
      cutoff,
      waitlistSize: WAITLIST_WINDOW,
      evaluated: ranked.length,
      ...counts,
      requeuedForReview: unranked.filter((a) => a.status !== 'withdrawn').length,
    };
  });
}

// ------------------------------------------------------------
// Leaderboard — the ranked master list for a program.
// ------------------------------------------------------------
async function getLeaderboard(scholarshipId) {
  const progs = await query(
    `SELECT id, name, description, slots, available_slots, status, amount, deadline
       FROM scholarship_programs WHERE id = ?`,
    [scholarshipId]
  );
  const program = progs && progs[0];
  if (!program) throw new SelectionError('Scholarship program not found.', 404);

  const runs = await query(
    `SELECT * FROM selection_runs WHERE scholarship_id = ? ORDER BY created_at DESC LIMIT 1`,
    [scholarshipId]
  );
  const run = runs && runs[0];

  const rows = await query(
    `SELECT a.id, a.selection_rank, a.selection_tie, a.status, a.total_score, a.total_score_precise,
            a.award_expires_at, a.accepted_at,
            u.first_name, u.last_name, u.email,
            agg.review_count, agg.avg_score_1to5
       FROM applications a
       JOIN students st ON st.id = a.student_id
       JOIN users u ON u.id = st.user_id
       LEFT JOIN (
            SELECT application_id,
                   COUNT(*) AS review_count,
                   ROUND(AVG(score), 2) AS avg_score_1to5
              FROM committee_reviews
          GROUP BY application_id
       ) agg ON agg.application_id = a.id
      WHERE a.scholarship_id = ? AND a.selection_rank IS NOT NULL
      ORDER BY a.selection_rank ASC`,
    [scholarshipId]
  );

  // reviewed-but-unevaluated or otherwise unranked applications
  const unranked = await query(
    `SELECT a.id, a.status, u.first_name, u.last_name, agg.review_count
       FROM applications a
       JOIN students st ON st.id = a.student_id
       JOIN users u ON u.id = st.user_id
       LEFT JOIN (
            SELECT application_id, COUNT(*) AS review_count
              FROM committee_reviews GROUP BY application_id
       ) agg ON agg.application_id = a.id
      WHERE a.scholarship_id = ? AND a.selection_rank IS NULL
        AND a.status NOT IN ('withdrawn')
      ORDER BY a.created_at DESC`,
    [scholarshipId]
  );

  const cutoff = cutoffFor(program);
  const blockingTies = rows.filter(
    (r) => r.selection_tie && Number(r.selection_rank) <= cutoff
  ).length;

  return {
    program: { ...program, cutoff },
    run: run || null,
    rows,
    unranked,
    blockingTies,
    waitlistSize: WAITLIST_WINDOW,
    acceptanceDays: ACCEPT_DAYS,
  };
}

// ------------------------------------------------------------
// Admin tie-breaking — winners are placed inside the cutoff.
// All winners must belong to ONE unresolved tie group (same score).
// ------------------------------------------------------------
async function resolveTies(scholarshipId, winners, reason, actorId) {
  if (!Array.isArray(winners) || winners.length === 0) {
    throw new SelectionError('winners[] (application IDs to keep in the cutoff) is required.', 400);
  }
  if (!reason || !String(reason).trim()) {
    throw new SelectionError('A documented reason for the tie-break decision is required.', 400);
  }
  const cleanReason = String(reason).trim();

  return transaction(async (connection) => {
    const [progs] = await connection.query(
      `SELECT * FROM scholarship_programs WHERE id = ? FOR UPDATE`, [scholarshipId]
    );
    const program = progs && progs[0];
    if (!program) throw new SelectionError('Scholarship program not found.', 404);
    const cutoff = cutoffFor(program);

    const [winnerRows] = await connection.query(
      `SELECT id, selection_rank, selection_tie, total_score
         FROM applications
        WHERE id IN (?) AND scholarship_id = ?`,
      [winners, scholarshipId]
    );
    if (!winnerRows || winnerRows.length !== winners.length) {
      throw new SelectionError('One or more selected applications were not found for this program.', 404);
    }
    if (winnerRows.some((w) => !w.selection_tie)) {
      throw new SelectionError('Selected applications are not part of an unresolved tie.', 409);
    }
    const scoreKey = Number(winnerRows[0].total_score).toFixed(2);
    if (winnerRows.some((w) => Number(w.total_score).toFixed(2) !== scoreKey)) {
      throw new SelectionError('All winners must belong to the same tie group (identical score).', 400);
    }

    // The whole tie group: same exact score, tie-flagged, this program.
    const [group] = await connection.query(
      `SELECT id, selection_rank, status
         FROM applications
        WHERE scholarship_id = ? AND selection_tie = TRUE AND total_score = ?
        ORDER BY selection_rank ASC`,
      [scholarshipId, winnerRows[0].total_score]
    );

    const winnerSet = new Set(winners.map(Number));
    const byRank = [...group].sort((a, b) => a.selection_rank - b.selection_rank);
    const winnersSorted = byRank.filter((a) => winnerSet.has(a.id));
    const losersSorted = byRank.filter((a) => !winnerSet.has(a.id));
    const ordered = [...winnersSorted, ...losersSorted];

    // Reuse the group's existing rank slots (collision-free reassignment).
    const rankSlots = byRank.map((a) => a.selection_rank).sort((x, y) => x - y);

    const resolved = [];
    for (let i = 0; i < ordered.length; i += 1) {
      const app = ordered[i];
      const newRank = rankSlots[i];
      const nextStatus = tagForRank(newRank, cutoff);
      const changed = app.status !== nextStatus || app.selection_rank !== newRank;
      await connection.query(
        `UPDATE applications
            SET selection_rank = ?, selection_tie = FALSE, status = ?
          WHERE id = ?`,
        [newRank, nextStatus, app.id]
      );
      await connection.query(
        `INSERT INTO application_status_history (application_id, status, remarks, changed_by)
         VALUES (?, ?, ?, ?)`,
        [app.id, nextStatus,
         `Tie resolved by admin (${cleanReason}) — re-ranked #${newRank} → ${nextStatus}`,
         actorId]
      );
      if (changed) {
        await notifyApplicantTx(
          connection, app.id, 'Application Update',
          (a) => `"${a.scholarship_name}" — your application is now "${String(nextStatus).replace(/_/g, ' ')}" (rank #${newRank}) after tie resolution.`,
          nextStatus === 'shortlisted' ? 'success' : nextStatus === 'waitlisted' ? 'warning' : 'info'
        );
      }
      resolved.push({ id: app.id, rank: newRank, status: nextStatus });
    }

    return {
      resolved: resolved.length,
      winners: winnersSorted.map((a) => a.id),
      cutoff,
      reason: cleanReason,
      rows: resolved,
    };
  });
}

// ------------------------------------------------------------
// Rank-disciplined promotion: repeatedly promote the TOP-RANKED
// waitlisted application while the program has open award slots.
// Must be called inside a transaction that has locked the program row.
// ------------------------------------------------------------
async function promoteInTx(connection, program, actorId, reason) {
  const promoted = [];
  for (;;) {
    const [fresh] = await connection.query(
      `SELECT available_slots, slots FROM scholarship_programs WHERE id = ?`,
      [program.id]
    );
    const avail = Number(fresh[0]?.available_slots || 0);
    if (avail <= 0) break;

    const [next] = await connection.query(
      `SELECT id, selection_rank, total_score
         FROM applications
        WHERE scholarship_id = ? AND status = 'waitlisted' AND selection_rank IS NOT NULL
        ORDER BY selection_rank ASC
        LIMIT 1`,
      [program.id]
    );
    if (!next || next.length === 0) break; // waitlist exhausted — slot stays open
    const appId = next[0].id;

    const slotUpd = await connection.execute(
      `UPDATE scholarship_programs
          SET available_slots = available_slots - 1
        WHERE id = ? AND available_slots > 0`,
      [program.id]
    );
    if (slotUpd.affectedRows === 0) break; // raced — nothing left

    const upd = await connection.execute(
      `UPDATE applications
          SET status = 'awarded', award_expires_at = NOW() + (? * INTERVAL '1 day')
        WHERE id = ? AND status = 'waitlisted'`,
      [ACCEPT_DAYS, appId]
    );
    if (upd.affectedRows === 0) break;

    await connection.query(
      `INSERT INTO application_status_history (application_id, status, remarks, changed_by)
       VALUES (?, 'awarded', ?, ?)`,
      [appId, `Promoted from waitlist (rank #${next[0].selection_rank}) — ${reason}`, actorId]
    );
    await notifyApplicantTx(
      connection, appId, '🎉 Good News — Award Offer',
      (a) => `A slot opened in "${a.scholarship_name}" and you are the next-ranked applicant — you are now offered the award! Please accept within ${ACCEPT_DAYS} day(s).`,
      'success'
    );
    promoted.push({ id: appId, rank: next[0].selection_rank });
  }
  return promoted;
}

// ------------------------------------------------------------
// Final Approval — lock the Top-N, open acceptance windows,
// close the program, send the three tiers of notices.
// ------------------------------------------------------------
async function approveAwardees(scholarshipId, actorId) {
  return transaction(async (connection) => {
    const [progs] = await connection.query(
      `SELECT * FROM scholarship_programs WHERE id = ? FOR UPDATE`, [scholarshipId]
    );
    const program = progs && progs[0];
    if (!program) throw new SelectionError('Scholarship program not found.', 404);

    const [runs] = await connection.query(
      `SELECT * FROM selection_runs WHERE scholarship_id = ? ORDER BY created_at DESC LIMIT 1`,
      [scholarshipId]
    );
    const run = runs && runs[0];
    if (!run) throw new SelectionError('No selection has been run yet. Run the selection first.', 409);
    if (run.locked_at) throw new SelectionError('Awardees were already approved for this program.', 409);

    const cutoff = cutoffFor(program);
    if (cutoff <= 0) {
      throw new SelectionError('available_slots is 0 — configure slots before approving awardees.', 409);
    }

    // Blocking ties: any unresolved tie at or above the cutoff rank.
    const [ties] = await connection.query(
      `SELECT id, selection_rank, total_score
         FROM applications
        WHERE scholarship_id = ? AND selection_tie = TRUE AND selection_rank <= ?`,
      [scholarshipId, cutoff]
    );
    if (ties.length > 0) {
      const err = new SelectionError(
        `Unresolved tie(s) at the rank-${cutoff} cutoff must be resolved before approval.`, 409
      );
      err.ties = ties;
      throw err;
    }

    // The ranked pool of this run that is still unlocked.
    const [ranked] = await connection.query(
      `SELECT a.id, a.selection_rank, a.status
         FROM applications a
        WHERE a.selection_run_id = ? AND a.selection_rank IS NOT NULL
        ORDER BY a.selection_rank ASC`,
      [run.id]
    );
    if (ranked.length === 0) {
      throw new SelectionError('The selection run has no ranked applications.', 409);
    }

    let approved = 0;
    let waitlisted = 0;
    let rejected = 0;

    for (const a of ranked) {
      // Re-tag against the LIVE cutoff (handles admin slot edits since the run).
      // Applications within the cutoff are AWARDED; those in the window stay
      // waitlisted; the rest are rejected.
      const nextStatus = tagForRank(a.selection_rank, cutoff);
      if (nextStatus === 'shortlisted') {
        await connection.query(
          `UPDATE applications
              SET status = 'awarded', award_expires_at = NOW() + (? * INTERVAL '1 day')
            WHERE id = ?`,
          [ACCEPT_DAYS, a.id]
        );
        approved += 1;
        await connection.query(
          `INSERT INTO application_status_history (application_id, status, remarks, changed_by)
           VALUES (?, 'awarded', ?, ?)`,
          [a.id,
           `Final award approval — rank #${a.selection_rank}; accept within ${ACCEPT_DAYS} day(s)`,
           actorId]
        );
        await notifyApplicantTx(
          connection, a.id, '🎉 Congratulations — Notice of Award',
          (ap) => `Congratulations! You have been awarded "${ap.scholarship_name}" (rank #${a.selection_rank}). Please log in and accept your award within ${ACCEPT_DAYS} day(s) or the slot will be offered to the next applicant.`,
          'success'
        );
      } else {
        if (a.status !== nextStatus) {
          await connection.query(`UPDATE applications SET status = ? WHERE id = ?`, [nextStatus, a.id]);
          await connection.query(
            `INSERT INTO application_status_history (application_id, status, remarks, changed_by)
             VALUES (?, ?, ?, ?)`,
            [a.id, nextStatus,
             `Approval pass re-tagged to ${nextStatus} (cutoff now ${cutoff})`, actorId]
          );
        }
        if (nextStatus === 'waitlisted') {
          waitlisted += 1;
          await notifyApplicantTx(
            connection, a.id, 'Application Update — Waitlisted',
            (ap) => `"${ap.scholarship_name}": you were ranked #${a.selection_rank} and are on the waitlist. If an awardee declines, the slot is offered to you automatically in rank order.`,
            'warning'
          );
        } else {
          rejected += 1;
          await notifyApplicantTx(
            connection, a.id, 'Application Decision',
            (ap) => `We regret to inform you that your application for "${ap.scholarship_name}" was not selected this cycle (rank #${a.selection_rank}). Thank you for applying.`,
            'info'
          );
        }
      }
    }

    // Lock the run, close the program, commit the full award budget.
    await connection.query(`UPDATE selection_runs SET locked_at = NOW() WHERE id = ?`, [run.id]);
    await connection.query(
      `UPDATE scholarship_programs SET status = 'closed', available_slots = 0 WHERE id = ?`,
      [scholarshipId]
    );

    logAdminAction({ actorId, action: 'AWARDEES_APPROVED', entityType: 'scholarship', entityId: scholarshipId, details: { approved, waitlisted, rejected, runId: run.id } });

    return {
      approved,
      waitlisted,
      rejected,
      cutoff,
      acceptanceDays: ACCEPT_DAYS,
      lockedRunId: run.id,
    };
  });
}

// ------------------------------------------------------------
// Acceptance — applicant signs the award → Active Scholar.
// ------------------------------------------------------------
async function acceptAward(applicationId, userId, signature) {
  const sig = String(signature || '').trim().replace(/\s+/g, ' ');
  if (sig.length < 3) {
    throw new SelectionError('A digital signature (your full name) is required to accept the award.', 400);
  }

  return transaction(async (connection) => {
    const [rows] = await connection.query(
      `SELECT a.id, a.status, a.award_expires_at, a.scholarship_id, a.student_id,
              u.first_name, u.last_name, sp.name AS scholarship_name
         FROM applications a
         JOIN students st ON st.id = a.student_id
         JOIN users u ON u.id = st.user_id
         JOIN scholarship_programs sp ON sp.id = a.scholarship_id
        WHERE a.id = ? AND st.user_id = ?
        FOR UPDATE`,
      [applicationId, userId]
    );
    const app = rows && rows[0];
    if (!app) throw new SelectionError('Application not found.', 404);
    if (app.status === 'scholar_active') {
      throw new SelectionError('This award has already been accepted.', 409);
    }
    if (app.status !== 'awarded') {
      throw new SelectionError(`Only awarded applications can be accepted. Current status: "${app.status}".`, 409);
    }
    if (app.award_expires_at && new Date(app.award_expires_at).getTime() < Date.now()) {
      // Deadline passed on access — forfeit and promote the next waitlisted.
      await connection.query(
        `UPDATE applications SET status = 'award_forfeited' WHERE id = ?`,
        [applicationId]
      );
      await connection.query(
        `INSERT INTO application_status_history (application_id, status, remarks, changed_by)
         VALUES (?, 'award_forfeited', 'Acceptance deadline passed — award forfeited on access', ?)`,
        [applicationId, userId]
      );
      const [progs] = await connection.query(
        `SELECT * FROM scholarship_programs WHERE id = ?`, [app.scholarship_id]
      );
      const promoted = await promoteInTx(connection, progs[0], null, 'award expired on access');
      const err = new SelectionError('The acceptance deadline has passed — the award was forfeited.', 410);
      err.forfeited = true;
      err.promoted = promoted;
      throw err;
    }

    // Signature must match the registered full name (case-insensitive).
    const fullName = `${app.first_name || ''} ${app.last_name || ''}`.trim().replace(/\s+/g, ' ').toLowerCase();
    if (sig.toLowerCase() !== fullName) {
      throw new SelectionError('The signature must match your registered full name.', 400);
    }

    await connection.query(
      `UPDATE applications
          SET status = 'scholar_active', accepted_at = NOW(), acceptance_signature = ?
        WHERE id = ?`,
      [sig, applicationId]
    );
    await connection.query(
      `INSERT INTO scholars (application_id, student_id, scholarship_id, user_id, status, accepted_at)
       VALUES (?, ?, ?, ?, 'active', NOW())
       ON CONFLICT (application_id) DO NOTHING`,
      [applicationId, app.student_id, app.scholarship_id, userId]
    );
    await connection.query(
      `INSERT INTO application_status_history (application_id, status, remarks, changed_by)
       VALUES (?, 'scholar_active', 'Award accepted — converted to Active Scholar', ?)`,
      [applicationId, userId]
    );
    await notifyApplicantTx(
      connection, applicationId, 'Award Accepted 🎓',
      (a) => `Your award for "${a.scholarship_name}" is confirmed. You are now an Active Scholar.`,
      'success'
    );

    logAdminAction({ actorId: userId, action: 'AWARD_ACCEPTED', entityType: 'application', entityId: applicationId, details: { signature: sig, scholarshipName: app.scholarship_name } });

    return { applicationId, status: 'scholar_active', scholarshipName: app.scholarship_name };
  });
}

// ------------------------------------------------------------
// Decline — applicant declines → slot freed → auto-promote.
// ------------------------------------------------------------
async function declineAward(applicationId, userId) {
  return transaction(async (connection) => {
    const [rows] = await connection.query(
      `SELECT a.id, a.status, a.scholarship_id, a.student_id
         FROM applications a
         JOIN students st ON st.id = a.student_id
        WHERE a.id = ? AND st.user_id = ?
        FOR UPDATE`,
      [applicationId, userId]
    );
    const app = rows && rows[0];
    if (!app) throw new SelectionError('Application not found.', 404);
    if (app.status !== 'awarded') {
      throw new SelectionError(`Only awarded applications can be declined. Current status: "${app.status}".`, 409);
    }

    await connection.query(
      `UPDATE applications SET status = 'award_declined', award_expires_at = NULL WHERE id = ?`,
      [applicationId]
    );
    await connection.query(
      `INSERT INTO application_status_history (application_id, status, remarks, changed_by)
       VALUES (?, 'award_declined', 'Applicant declined the award', ?)`,
      [applicationId, userId]
    );

    // Free the slot, then hand it to the top-ranked waitlisted applicant.
    await connection.execute(
      `UPDATE scholarship_programs
          SET available_slots = available_slots + 1
        WHERE id = ? AND available_slots < slots`,
      [app.scholarship_id]
    );
    const [progs] = await connection.query(
      `SELECT * FROM scholarship_programs WHERE id = ?`, [app.scholarship_id]
    );
    const promoted = await promoteInTx(connection, progs[0], null, 'award declined by applicant');

    logAdminAction({ actorId: userId, action: 'AWARD_DECLINED', entityType: 'application', entityId: applicationId, details: { scholarshipId: app.scholarship_id } });

    return { applicationId, status: 'award_declined', promoted };
  });
}

// ------------------------------------------------------------
// Public wrapper — promote the top-ranked waitlisted applicant(s)
// for a program (admin button or internal trigger).
// ------------------------------------------------------------
async function promoteNextWaitlisted(scholarshipId, actorId, reason = 'manual promotion') {
  return transaction(async (connection) => {
    const [progs] = await connection.query(
      `SELECT * FROM scholarship_programs WHERE id = ? FOR UPDATE`, [scholarshipId]
    );
    const program = progs && progs[0];
    if (!program) throw new SelectionError('Scholarship program not found.', 404);
    const promoted = await promoteInTx(connection, program, actorId, reason);
    return { promoted };
  });
}

// ------------------------------------------------------------
// Sweep — forfeit expired awards and promote waitlisted applicants.
// Called by the in-process timer and lazily on reads.
// ------------------------------------------------------------
async function sweepExpiredAwards() {
  const expired = await query(
    `SELECT a.id, a.scholarship_id
       FROM applications a
      WHERE a.status = 'awarded'
        AND a.award_expires_at IS NOT NULL
        AND a.award_expires_at < NOW()`
  );
  if (!expired || expired.length === 0) return { forfeited: 0, promoted: 0 };

  // Group by program so each program is processed in one transaction.
  const byProgram = new Map();
  for (const a of expired) {
    if (!byProgram.has(a.scholarship_id)) byProgram.set(a.scholarship_id, []);
    byProgram.get(a.scholarship_id).push(a.id);
  }

  let forfeited = 0;
  let promotedTotal = 0;

  for (const [scholarshipId, appIds] of byProgram) {
    try {
      const result = await transaction(async (connection) => {
        const [progs] = await connection.query(
          `SELECT * FROM scholarship_programs WHERE id = ? FOR UPDATE`, [scholarshipId]
        );
        const program = progs && progs[0];
        if (!program) return { forfeited: 0, promoted: [] };

        let f = 0;
        for (const appId of appIds) {
          // Re-check under lock — status may have changed.
          const [cur] = await connection.query(
            `SELECT status FROM applications WHERE id = ? FOR UPDATE`, [appId]
          );
          if (!cur[0] || cur[0].status !== 'awarded') continue;

          await connection.query(
            `UPDATE applications SET status = 'award_forfeited' WHERE id = ?`, [appId]
          );
          await connection.query(
            `INSERT INTO application_status_history (application_id, status, remarks, changed_by)
             VALUES (?, 'award_forfeited', 'Acceptance deadline passed — award forfeited', NULL)`,
            [appId]
          );
          await connection.execute(
            `UPDATE scholarship_programs
                SET available_slots = available_slots + 1
              WHERE id = ? AND available_slots < slots`,
            [scholarshipId]
          );
          f += 1;
        }

        const [fresh] = await connection.query(
          `SELECT * FROM scholarship_programs WHERE id = ?`, [scholarshipId]
        );
        const promoted = await promoteInTx(
          connection, fresh[0], null, 'award expired — slot released to waitlist'
        );
        return { forfeited: f, promoted };
      });
      forfeited += result.forfeited;
      promotedTotal += result.promoted.length;
    } catch (e) {
      console.error(`[selectionService] sweep failed for program ${scholarshipId}:`, e.message);
    }
  }

  return { forfeited, promoted: promotedTotal };
}

module.exports = {
  runSelection,
  getLeaderboard,
  resolveTies,
  approveAwardees,
  acceptAward,
  declineAward,
  promoteNextWaitlisted,
  sweepExpiredAwards,
  // exported for unit testing / advanced use
  SelectionError,
  cutoffFor,
  tagForRank,
  WAITLIST_WINDOW,
  ACCEPT_DAYS,
};

