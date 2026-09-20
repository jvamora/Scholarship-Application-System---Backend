// Lightweight helper to notify the APPLICANT who owns a scholarship application.
//
// Upstream, other roles already get in-app notifications on relevant events
// (staff via adminController.notifyApplicantCreator, committee via
// applicationController.notifyReviewersOfNewApplication, admin/staff via
// authController). Applicants were the only role with NO in-app notification,
// which meant they could never see when their application was approved,
// rejected, waitlisted, recalled, or otherwise changed without manually
// reloading "My Applications".
//
// This helper resolves the owning applicant's user_id from the application's
// student_id and writes a row into the existing `notifications` table. It is
// intentionally fire-and-forget and never throws: a notification failure must
// never roll back or break the primary action that triggered it.
const pool = require('../config/db');

const notifyApplicant = async (applicationId, title, message, type = 'info') => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id AS user_id,
              u.first_name, u.last_name,
              a.application_number,
              sp.name AS scholarship_name
         FROM applications a
         JOIN students st ON st.id = a.student_id
         JOIN users u     ON u.id = st.user_id
         JOIN scholarship_programs sp ON sp.id = a.scholarship_id
        WHERE a.id = ? LIMIT 1`,
      [applicationId]
    );
    const app = rows && rows[0];
    if (!app) return;

    // Allow the message to be a function so callers can build rich, contextual
    // text without pre-fetching the application metadata themselves.
    if (typeof message === 'function') {
      message = message(app);
    }

    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type, reference_type, reference_id)
       VALUES (?, ?, ?, ?, 'application', ?)`,
      [app.user_id, title, message, type, applicationId]
    );
  } catch (err) {
    // Intentionally swallowed — a failed notification must never break the
    // primary action (matching the pattern used elsewhere in the codebase).
    console.error(`notifyApplicant: failed to notify applicant for application #${applicationId}:`, err.message);
  }
};

module.exports = { notifyApplicant };