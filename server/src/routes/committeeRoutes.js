const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { notifyApplicant } = require('../utils/notifyApplicant');

// All committee routes require committee (or admin) role
router.use(authenticate, authorize(['committee', 'admin']));

// Helper to normalize recommendation input
function normalizeRecommendation(value) {
  if (value === 'approve' || value === 'reject' || value === 'waitlist') {
    return value;
  }
  return null;
}

// Pending-review count for navbar badge — cheap single aggregate query.
// Counts every application not yet given a final decision.
router.get('/pending-count', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS count FROM applications
        WHERE status IN ('submitted', 'under_review', 'committee_review')`
    );
    res.json({ success: true, count: Number(rows[0]?.count) || 0 });
  } catch (error) {
    console.error('Error fetching pending count:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// List this committee member's notifications (newest first).
router.get('/notifications', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ success: true, notifications: rows });
  } catch (error) {
    console.error('Error listing notifications:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Mark one of this member's notifications as read.
router.post('/notifications/:id/read', async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (error) {
    console.error('Error marking notification read:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper to normalize recommendation input
// List all approved applicant accounts for ranking
router.get('/applicants', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, uuid, email, role, first_name, middle_name, last_name, phone, address, status, 
              committee_score, recommendation, committee_notes, created_at 
       FROM users 
       WHERE role = 'applicant' AND status = 'approved'
       ORDER BY created_at DESC`
    );
    res.json({ success: true, applicants: rows });
  } catch (error) {
    console.error('Error fetching applicants:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get a single approved applicant detail (for the committee evaluation modal)
router.get('/applicants/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, uuid, email, first_name, middle_name, last_name, phone, address, status,
              committee_score, recommendation, committee_notes, created_at
       FROM users
       WHERE id = ? AND role = 'applicant' AND status = 'approved'`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Applicant not found' });
    }
    res.json({ success: true, applicant: rows[0] });
  } catch (error) {
    console.error('Error fetching applicant detail:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// List applications for committee review.
// Joined with applicant profile, scholarship program, slot info, this member's
// own evaluation, and the all-reviewers aggregate for each application.
// Optional query params:
//   status        — exact application status filter (e.g. submitted, approved)
//   scholarshipId — only applications for one program
//   sort          — 'score' (total_score DESC) | 'newest' (default)
router.get('/applications', async (req, res) => {
  try {
    const memberId = req.user.id;

    // ---- Optional filters (parameterized; never string-interpolated) ----
    const where = ['1=1'];
    const params = [];
    if (req.query.status && String(req.query.status).trim()) {
      where.push('a.status = ?');
      params.push(String(req.query.status).trim());
    }
    if (req.query.scholarshipId && Number(req.query.scholarshipId) > 0) {
      where.push('a.scholarship_id = ?');
      params.push(Number(req.query.scholarshipId));
    }

    // ---- Sort (whitelisted to prevent SQL injection via ORDER BY) ----
    let orderBy = 'a.created_at DESC';
    if (String(req.query.sort || '').toLowerCase() === 'score') {
      orderBy = 'a.total_score IS NULL ASC, a.total_score DESC, a.created_at DESC';
    }

    // ---- Pagination (server-capped so huge pages can't be requested) ----
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const [rows] = await pool.query(
      `SELECT 
         a.id,
         a.application_number,
         a.student_id,
         a.scholarship_id,
         a.academic_year_id,
         a.status,
         a.total_score,
         a.remarks,
         a.submitted_at,
         a.created_at,
         a.updated_at,
         u.id AS applicant_user_id,
         u.email AS applicant_email,
         u.first_name AS applicant_first_name,
         u.middle_name AS applicant_middle_name,
         u.last_name AS applicant_last_name,
         u.phone AS applicant_phone,
         u.address AS applicant_address,
         u.status AS applicant_account_status,
         sp.name AS scholarship_name,
         sp.slots AS scholarship_slots,
         sp.available_slots AS scholarship_available_slots,
         agg.review_count,
         agg.avg_score_1to5,
         cr.id AS review_id,
         cr.score AS review_score,
         cr.remarks AS review_remarks,
         cr.recommendation AS review_recommendation
       FROM applications a
       JOIN students st ON a.student_id = st.id
       JOIN users u ON st.user_id = u.id
       JOIN scholarship_programs sp ON a.scholarship_id = sp.id
       LEFT JOIN committee_reviews cr 
         ON cr.application_id = a.id AND cr.committee_member_id = ?
       LEFT JOIN (
         SELECT application_id,
                COUNT(*)            AS review_count,
                ROUND(AVG(score),2) AS avg_score_1to5
           FROM committee_reviews
          GROUP BY application_id
       ) agg ON agg.application_id = a.id
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [memberId, ...params, limit, offset]
    );
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
         FROM applications a
        WHERE ${where.join(' AND ')}`,
      params
    );
    res.json({
      success: true,
      applications: rows,
      total: Number(countRows[0]?.total) || 0,
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error fetching applications:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get a single application detail (with submitted answers + documents)
// for the committee evaluation modal.
router.get('/applications/:id', async (req, res) => {
  try {
    const memberId = req.user.id;
    const [rows] = await pool.query(
      `SELECT 
         a.*,
         u.email AS applicant_email,
         u.first_name AS applicant_first_name,
         u.middle_name AS applicant_middle_name,
         u.last_name AS applicant_last_name,
         u.phone AS applicant_phone,
         u.address AS applicant_address,
         sp.name AS scholarship_name,
         sp.description AS scholarship_description
       FROM applications a
       JOIN students st ON a.student_id = st.id
       JOIN users u ON st.user_id = u.id
       JOIN scholarship_programs sp ON a.scholarship_id = sp.id
       WHERE a.id = ?`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Application not found' });
    }

    const application = rows[0];

    // Parse answers (stored as JSON)
    let answers = {};
    if (application.answers) {
      try {
        answers = typeof application.answers === 'string' ? JSON.parse(application.answers) : application.answers;
      } catch (e) {
        answers = {};
      }
    }

    // Documents
    const [docs] = await pool.query(
      `SELECT * FROM application_documents WHERE application_id = ? ORDER BY id ASC`,
      [application.id]
    );

    // Build a web-accessible URL for each uploaded document.
    // file_path may be an absolute path under <server>/src/uploads or a
    // relative 'uploads/...' path; the static route serves /uploads/*.
    const documents = (docs || []).map(doc => {
      return {
        ...doc,
        file_url: `/api/documents/${doc.id}`,
      };
    });

    // This member's own review
    const [reviewRows] = await pool.query(
      `SELECT * FROM committee_reviews 
       WHERE application_id = ? AND committee_member_id = ?`,
      [application.id, memberId]
    );

    // Full decision/status timeline — the reviewer's accountability record.
    const [historyRows] = await pool.query(
      `SELECT h.id, h.status, h.remarks, h.created_at,
              u.first_name AS changed_by_first_name,
              u.last_name  AS changed_by_last_name,
              u.role       AS changed_by_role
         FROM application_status_history h
         LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.application_id = ?
        ORDER BY h.created_at DESC, h.id DESC`,
      [application.id]
    );

    res.json({
      success: true,
      application: {
        ...application,
        answers,
        documents,
        own_review: reviewRows[0] || null,
        status_history: historyRows || [],
      },
    });
  } catch (error) {
    console.error('Error fetching application detail:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Submit/upsert a committee review + drive the application decision.
// Body: { score (1-5 stars), recommendation (approve|waitlist|reject), notes }
//
// Scoring units (F-09 Lite):
//   - committee_reviews.score  → raw stars (1-5), exactly as reviewers submit
//   - applications.total_score → normalized 0-100 running average (avg × 20),
//     keeping reports/exports on their documented scale.
//
// Decision policy (quorum):
//   COMMITTEE_QUORUM (default 2) reviews must exist before a status flip.
//   A flip needs a strict majority of approve/reject among ALL cast votes;
//   ties or a waitlist plurality hold at 'committee_review'.
//   Set COMMITTEE_QUORUM=1 to restore single-reviewer decisions.
const QUORUM = Math.max(1, parseInt(process.env.COMMITTEE_QUORUM || '2', 10));

// GET /committee/applications/:id already exists below; the status-history for
// an application is attached to that response (see status_history field).

// POST /committee/applications/:id/reopen
// Recall a decision and send the application back into review.
// Available to committee members AND admins (admin route lives here too since
// it must go through the same audited flow as any other decision change).
// Body: { reason } — required, recorded in application_status_history.
const REOPENABLE = ['approved', 'rejected', 'interview', 'waitlisted'];
router.post('/applications/:id/reopen', async (req, res) => {
  try {
    const { id } = req.params;
    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid application id.' });
    }
    const reason = String(req.body?.reason || '').trim().slice(0, 1000); // cap free-text size
    if (!reason || reason.length < 5) {
      return res.status(400).json({ success: false, error: 'A reason of at least 5 characters is required to re-open an application.' });
    }

    const [rows] = await pool.query('SELECT id, status FROM applications WHERE id = ? LIMIT 1', [id]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Application not found' });
    }
    const current = rows[0].status;
    if (!REOPENABLE.includes(current)) {
      return res.status(400).json({
        success: false,
        error: `Only decided applications (${REOPENABLE.join(', ')}) can be re-opened. This one is "${current}".`,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Re-open into 'under_review' — distinct from a fresh 'submitted' so
      // reviewers can see it previously went through a decision.
      await client.query(
        `UPDATE applications
            SET status = 'under_review', total_score = NULL, reviewed_at = NULL,
                remarks = CONCAT(COALESCE(remarks, ''), $1)
          WHERE id = $2`,
        [`\n[Decision recalled] ${reason}`, id]
      );
      await client.query(
        `INSERT INTO application_status_history (application_id, status, remarks, changed_by)
         VALUES ($1, 'under_review', $2, $3)`,
        [
          id,
          `Decision recalled from "${current}" by ${req.user.role}: ${reason}`,
          req.user.id,
        ]
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e2) { /* nothing to roll back */ }
      throw err;
    } finally {
      client.release();
    }

    // Notify the applicant their decided application was recalled into review.
    notifyApplicant(
      id,
      'Application Re-Opened',
      (app) => `Your application for ${app.scholarship_name || 'this program'} (${app.application_number || `#${id}`}) has been re-opened for review. Reason: ${reason}`,
      'warning'
    );

    res.json({
      success: true,
      message: 'Application re-opened for review.',
      data: { id: Number(id), status: 'under_review' },
    });
  } catch (error) {
    console.error('Error reopening application:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /committee/applications/:id/promote  — RETIRED (slot-model v2)
// Manual "promote any waitlisted application" is replaced by rank-based
// promotion: selectionService.promoteNextWaitlisted() always promotes the
// TOP-RANKED waitlisted application when a slot frees (decline/forfeit/raise),
// preserving the leaderboard's cutoff discipline. The legacy implementation
// was also non-functional against Postgres (mysql2-style pool.getConnection()
// does not exist on node-postgres, and pg results expose rowCount, not
// affectedRows — it 500'd on every call).
router.post('/applications/:id/promote', async (req, res) => {
  return res.status(410).json({
    success: false,
    error:
      'Manual promotion has been retired. Awards are now managed through the Selection Leaderboard: ' +
      'run the selection, approve the awardees, and waitlisted applicants are promoted automatically ' +
      'in rank order whenever a slot frees (declined, expired, or slots raised).',
  });
});

router.post('/applications/:id/review', async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { score, recommendation, notes, academicsScore, needScore, statementScore } = req.body;
    const memberId = req.user.id;

    if (score === undefined || score === null || score === '') {
      return res.status(400).json({ success: false, error: 'Score is required' });
    }
    if (!recommendation) {
      return res.status(400).json({ success: false, error: 'Recommendation is required' });
    }

    const normalizedRec = normalizeRecommendation(recommendation);
    if (!normalizedRec) {
      return res.status(400).json({ success: false, error: 'Invalid recommendation. Must be approve, waitlist, or reject.' });
    }

    const numericScore = Number(score);
    if (!Number.isInteger(numericScore) || numericScore < 1 || numericScore > 5) {
      return res.status(400).json({ success: false, error: 'Score must be an integer from 1 to 5' });
    }

    // Weighted component scores (each 1-5). Backward-compatible: if the caller
    // omits them (legacy client), all three are null and we fall back to the
    // single overall score. If ANY is supplied, all three must be valid integers.
    const scores = { academicsScore, needScore, statementScore };
    const anySupplied = Object.values(scores).some((v) => v !== undefined && v !== null && v !== '');
    const numericComponents = {};
    let useComponents = true;
    for (const key of ['academicsScore', 'needScore', 'statementScore']) {
      const v = scores[key];
      const isMissing = v === undefined || v === null || v === '';
      if (anySupplied && isMissing) {
        return res.status(400).json({ success: false, error: 'All three component scores (Academic Merit, Financial Need, Statement) are required.' });
      }
      if (isMissing) { useComponents = false; break; }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        return res.status(400).json({ success: false, error: `${key} must be an integer from 1 to 5` });
      }
      numericComponents[key] = n;
    }
    if (!useComponents) {
      numericComponents.academicsScore = null;
      numericComponents.needScore = null;
      numericComponents.statementScore = null;
    }

    // Cap free-text size so remarks columns can't be flooded via direct API calls.
    const trimmedNotes = String(notes || '').trim().slice(0, 2000);

    // Application must exist
    const [appRows] = await pool.query('SELECT * FROM applications WHERE id = ?', [id]);
    if (appRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Application not found' });
    }
    const application = appRows[0];

    // Decision is computed AFTER saving this vote (see quorum logic below)
    client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Upsert into committee_reviews (unique on application_id + committee_member_id)
      const remarks = trimmedNotes || null;
      await client.query(
        `INSERT INTO committee_reviews 
           (application_id, committee_member_id, score, remarks, recommendation,
            academics_score, need_score, statement_score)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (application_id, committee_member_id) DO UPDATE 
           SET score = EXCLUDED.score,
               remarks = EXCLUDED.remarks,
               recommendation = EXCLUDED.recommendation,
               academics_score = EXCLUDED.academics_score,
               need_score = EXCLUDED.need_score,
               statement_score = EXCLUDED.statement_score,
               updated_at = CURRENT_TIMESTAMP`,
        [id, memberId, numericScore, remarks, normalizedRec,
         numericComponents.academicsScore, numericComponents.needScore, numericComponents.statementScore]
      );

      // Aggregate ALL reviews cast for this application.
      // Weighted component composite (0-100) per review:
      //   academics .40 + need .30 + statement .30, each 1-5 star -> *20.
      // Legacy reviews without components fall back to overall score * 20,
      // so existing data keeps ranking.
      const aggRes = await client.query(
        `SELECT COUNT(*) AS total_reviews,
                AVG(score) AS avg_score,
                ROUND(AVG(
                  CASE WHEN academics_score IS NOT NULL
                        AND need_score IS NOT NULL
                        AND statement_score IS NOT NULL
                    THEN (academics_score * 0.40 + need_score * 0.30 + statement_score * 0.30) * 20
                    ELSE score * 20
                  END
                ), 4) AS avg_composite,
                SUM(CASE WHEN recommendation = 'approve' THEN 1 ELSE 0 END)  AS approves,
                SUM(CASE WHEN recommendation = 'reject' THEN 1 ELSE 0 END)   AS rejects,
                SUM(CASE WHEN recommendation = 'waitlist' THEN 1 ELSE 0 END) AS waitlists
           FROM committee_reviews
          WHERE application_id = $1`,
        [id]
      );
      const agg = aggRes.rows[0] || {};
      const totalReviews = Number(agg.total_reviews) || 0;
      const avgScore = Number(agg.avg_score) || 0;
      const avgComposite = Number(agg.avg_composite) || 0;
      // Display scale stays 0-100 (rounded legacy overall average); a precise,
      // weighted total is stored separately for tie-free ranking.
      const totalScore100 = Math.round(avgScore * 20);
      const totalScorePrecise = avgComposite;
      const approves = Number(agg.approves) || 0;
      const rejects = Number(agg.rejects) || 0;
      const waitlists = Number(agg.waitlists) || 0;

      // Quorum + strict-majority decision.
      // Default: keep the current status; flip only when quorum is met AND
      // one outcome holds a strict majority of all cast votes.
      let targetStatus = application.status || 'committee_review';
      let decisionNote;
      if (totalReviews < QUORUM) {
        decisionNote = `Review recorded (${totalReviews} vote${totalReviews === 1 ? '' : 's'}); quorum of ${QUORUM} not yet met`;
      } else if (approves > rejects && approves > waitlists && approves > totalReviews / 2) {
        targetStatus = 'approved';
        decisionNote = QUORUM === 1
          ? 'Single-reviewer decision: approved'
          : `Quorum met (${totalReviews} votes): approved by strict majority`;
      } else if (rejects > approves && rejects > waitlists && rejects > totalReviews / 2) {
        targetStatus = 'rejected';
        decisionNote = QUORUM === 1
          ? 'Single-reviewer decision: rejected'
          : `Quorum met (${totalReviews} votes): rejected by strict majority`;
      } else if (waitlists > approves && waitlists > rejects && waitlists > totalReviews / 2) {
        // Explicit waitlisted state — the reviewer can promote it later when a
        // slot frees up (POST /applications/:id/promote).
        targetStatus = 'waitlisted';
        decisionNote = QUORUM === 1
          ? 'Single-reviewer decision: waitlisted'
          : `Quorum met (${totalReviews} votes): waitlisted`;
      } else {
        targetStatus = 'committee_review';
        decisionNote = QUORUM === 1
          ? 'Waitlisted — application remains under review'
          : `Quorum met (${totalReviews} votes) but no strict majority — held for further review`;
      }

      // Update the application: running average (0-100) + possibly-flipped status
      await client.query(
        `UPDATE applications 
         SET status = $1, total_score = $2, total_score_precise = $3, reviewed_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [targetStatus, totalScore100, totalScorePrecise, id]
      );

      // Insert into application_status_history (audit every submitted review)
      await client.query(
        `INSERT INTO application_status_history 
           (application_id, status, remarks, changed_by)
         VALUES ($1, $2, $3, $4)`,
        [id, targetStatus, `Committee recommendation: ${normalizedRec} — ${decisionNote}`, memberId]
      );

            // Keep the legacy users committee_score fields in sync with THIS member's
      // star rating + own recommendation (unchanged unit: 1-5).
      await client.query(
        `UPDATE users
            SET committee_score = $1, recommendation = $2, committee_notes = $3
          FROM students st
          WHERE st.user_id = users.id
            AND st.id = $4
            AND users.role = 'applicant'`,
        [numericScore, normalizedRec, remarks, application.student_id]
      );

      await client.query('COMMIT');

      // Notify the applicant of their outcome (only when a decision was reached).
      // Fire-and-forget — the response must never wait on a notification write.
      notifyApplicant(
        id,
        targetStatus === 'approved' ? 'Application Approved 🎉'
          : targetStatus === 'rejected' ? 'Application Rejected'
          : targetStatus === 'waitlisted' ? 'Application Waitlisted'
          : 'Application Update',
        (app) => `${app.scholarship_name || 'This program'} (${app.application_number || `#${id}`}) is now "${targetStatus.replace(/_/g, ' ')}".${decisionNote ? ` ${decisionNote}.` : ''}`,
        targetStatus === 'approved' ? 'success'
          : targetStatus === 'rejected' ? 'error'
          : targetStatus === 'waitlisted' ? 'warning'
          : 'info'
      );

      res.json({
        success: true,
        message: 'Application review submitted successfully',
        data: {
          status: targetStatus,
          totalReviews,
          quorum: QUORUM,
          totalScore: totalScore100,
          totalScorePrecise,
          decisionNote,
        },
      });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e2) { /* nothing to roll back */ }
      throw err;
    } finally {
      if (client) client.release();
    }
  } catch (error) {
    console.error('Error reviewing application:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
