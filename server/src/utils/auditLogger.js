// Lightweight audit logger — writes to the `audit_logs` table (schema ships
// in migrations/001 but was previously unwired).
//
// FAIL-OPEN BY DESIGN: audit logging is a side effect of a real action. A
// logging failure must NEVER fail or roll back the admin operation itself,
// so this function swallows its own errors and only console.warns/errors.
const pool = require('../config/db');

const ACTIONS = new Set([
  'USER_APPROVED',
  'USER_REJECTED',
  'PASSWORD_RESET',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_REACTIVATED',
  'STAFF_CREATED',
  'USERS_BULK_APPROVED',
  'USERS_BULK_REJECTED',
  'USER_UPDATED',
  'USER_ROLE_CHANGED',
  'USER_DELETED',
  'STAFF_APPLICANT_PASSWORD_RESET',
  'STAFF_APPLICANT_DELETED',
  'SELECTION_RUN',
  'TIE_RESOLVED',
  'AWARDEES_APPROVED',
  'AWARD_ACCEPTED',
  'AWARD_DECLINED',
  'DISBURSEMENT_SCHEDULED',
  'DISBURSEMENT_UPDATED',
  'DISBURSEMENT_PROCESSING',
  'DISBURSEMENT_RELEASED',
  'DISBURSEMENT_CANCELLED',
  'DISBURSEMENT_RECEIVED',
  'SCORE_UPDATED',
  'SCHOLARSHIP_CREATED',
  'SCHOLARSHIP_UPDATED',
  'SCHOLARSHIP_DELETED',
]);

const logAdminAction = async ({ actorId, action, entityType, entityId, details = {}, req } = {}) => {
  if (!ACTIONS.has(action)) {
    console.warn(`auditLogger: unknown action "${action}" — not recorded`);
    return;
  }
  try {
    const ip = req && req.ip;
    const ua = typeof req?.get === 'function' ? req.get('user-agent') : (req && req.headers && req.headers['user-agent']);
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        actorId,
        action,
        entityType,
        entityId || null,
        JSON.stringify(details || {}),
        ip || null,
        (ua || '').slice(0, 1000),
      ]
    );
  } catch (err) {
    // Intentionally swallowed — audit logging never breaks the primary action.
    console.error('auditLogger: failed to write audit log:', err.message);
  }
};

module.exports = { logAdminAction, ACTIONS };
