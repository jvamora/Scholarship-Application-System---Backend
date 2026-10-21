// ============================================================
// disbursementService — staff fund-release ledger (post-award).
//
// The award pipeline (selectionService) ends at `scholars.status = 'active'`.
// This service owns everything AFTER that point: scheduling a per-term fund
// release, moving it through pending → processing → released (or cancelled),
// and telling the scholar what happened. Money never moves silently — every
// mutation is written to `audit_logs` (auditLogger) and announced to the
// scholar's in-app notification inbox.
//
// Tables (existing — created by migrations-pg/001_selection_awarding.sql):
//   scholars       one row per accepted award
//                  (status: active | renewal_pending | completed | revoked)
//   disbursements  one row per scheduled/paid term release
//                  (+ walk-in receipt columns from 005_disbursement_receipts.sql:
//                   claimed_by / recipient_name / claimant_id_note / id_verified
//                   and the scholar's own acknowledgment:
//                   acknowledged_at / acknowledged_signature / acknowledged_by)
//   audit_logs     immutable action trail
//   notifications  per-user in-app inbox
//
// Business guards enforced here (single owner of disbursement state):
//   • a release is only schedulable for a scholar in good standing
//   • one open (pending/processing) release per scholar + term
//   • funds are only releasable while the scholar is active/renewal_pending
//   • a released disbursement can never be cancelled (record a reversal)
// ============================================================
const { query, transaction } = require('../config/database');
const { logAdminAction } = require('../utils/auditLogger');

const TERM_MAX = 50;
const REFERENCE_MAX = 100;
const NOTES_MAX = 2000;
const AMOUNT_MAX = 99999999.99; // NUMERIC(12,2) ceiling
const RECIPIENT_MAX = 150;      // disbursements.recipient_name / acknowledged_signature
const CLAIMANT_NOTE_MAX = 200;  // disbursements.claimant_id_note

// Who physically collected the funds at the counter (walk-in payout).
const CLAIMANT_TYPES = ['self', 'representative'];

// Scholar standing values that still permit money to leave the system.
const RELEASABLE_SCHOLAR_STATUSES = ['active', 'renewal_pending'];

const SCHOLAR_STATUS_LABELS = {
  active: 'Active Scholar',
  renewal_pending: 'Renewal Pending',
  completed: 'Completed',
  revoked: 'Revoked',
};

class DisbursementError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// ₱1,234.56 — used in notification copy only.
function peso(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '₱0.00';
  return `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function cleanTerm(term) {
  const value = String(term == null ? '' : term).trim();
  if (!value) throw new DisbursementError('A term is required (e.g. "1st Semester 2025-2026").', 400);
  if (value.length > TERM_MAX) {
    throw new DisbursementError(`Term must be ${TERM_MAX} characters or fewer.`, 400);
  }
  return value;
}

function cleanAmount(amount) {
  if (amount === undefined || amount === null || String(amount).trim() === '') return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new DisbursementError('Amount must be a number.', 400);
  if (n <= 0) throw new DisbursementError('Amount must be greater than zero.', 400);
  if (n > AMOUNT_MAX) throw new DisbursementError('Amount exceeds the maximum allowed value.', 400);
  return round2(n);
}

function cleanDate(value, label = 'Scheduled date') {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new DisbursementError(`${label} must be a valid date (YYYY-MM-DD).`, 400);
  }
  return raw.slice(0, 10);
}

function cleanNotes(notes, label = 'Notes') {
  if (notes === undefined || notes === null) return null;
  const value = String(notes).trim();
  if (!value) return null;
  if (value.length > NOTES_MAX) {
    throw new DisbursementError(`${label} must be ${NOTES_MAX} characters or fewer.`, 400);
  }
  return value;
}

function cleanReference(referenceNo) {
  const value = String(referenceNo == null ? '' : referenceNo).trim();
  if (!value) {
    throw new DisbursementError('A reference number is required to mark funds as released.', 400);
  }
  if (value.length < 3) {
    throw new DisbursementError('The reference number must be at least 3 characters.', 400);
  }
  if (value.length > REFERENCE_MAX) {
    throw new DisbursementError(`The reference number must be ${REFERENCE_MAX} characters or fewer.`, 400);
  }
  return value;
}

// ------------------------------------------------------------
// Walk-in receipt helpers (migration 005).
// A payout is handed over across the counter, so the release records WHO
// collected it: the scholar in person ('self') or an authorized
// 'representative' (whose name + presented ID must then be captured).
// ------------------------------------------------------------
function cleanClaimedBy(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 'self';
  const normalized = String(value).trim().toLowerCase();
  if (!CLAIMANT_TYPES.includes(normalized)) {
    throw new DisbursementError("Claimed-by must be either 'self' or 'representative'.", 400);
  }
  return normalized;
}

function cleanRecipientName(recipientName, { required = false, label = 'Recipient name' } = {}) {
  const value = String(recipientName == null ? '' : recipientName).trim().replace(/\s+/g, ' ');
  if (!value) {
    if (required) {
      throw new DisbursementError(
        `${label} is required when a representative collects the funds.`, 400
      );
    }
    return null;
  }
  if (value.length < 3) {
    throw new DisbursementError(`${label} must be at least 3 characters.`, 400);
  }
  if (value.length > RECIPIENT_MAX) {
    throw new DisbursementError(`${label} must be ${RECIPIENT_MAX} characters or fewer.`, 400);
  }
  return value;
}

function cleanClaimantNote(note, { required = false } = {}) {
  const value = String(note == null ? '' : note).trim();
  if (!value) {
    if (required) {
      throw new DisbursementError(
        'Record which ID was presented (or its reference) for a representative claim.', 400
      );
    }
    return null;
  }
  if (value.length > CLAIMANT_NOTE_MAX) {
    throw new DisbursementError(`The ID note must be ${CLAIMANT_NOTE_MAX} characters or fewer.`, 400);
  }
  return value;
}

// Accepts true/false, 'true'/'false', 1/0 — anything else is false.
function cleanBoolean(value) {
  if (value === true || value === false) return value;
  if (value === undefined || value === null || value === '') return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

// Typed full-name signature (same rule as selectionService.acceptAward).
function cleanSignature(signature) {
  const value = String(signature == null ? '' : signature).trim().replace(/\s+/g, ' ');
  if (value.length < 3) {
    throw new DisbursementError('Type your full name as your signature (min 3 characters).', 400);
  }
  if (value.length > RECIPIENT_MAX) {
    throw new DisbursementError(`The signature must be ${RECIPIENT_MAX} characters or fewer.`, 400);
  }
  return value;
}

function standingError(scholarStatus) {
  return new DisbursementError(
    `Funds cannot be released — this scholar's standing is "${
      SCHOLAR_STATUS_LABELS[scholarStatus] || scholarStatus
    }".`,
    409
  );
}

// ------------------------------------------------------------
// Scholar notification — fire-and-forget so a notification failure can
// never roll back or break the primary money-movement action (same
// philosophy as utils/notifyApplicant.js).
// `referenceId` defaults to the scholar id but callers that act on a
// specific ledger row pass the DISBURSEMENT id so the inbox link is precise.
// ------------------------------------------------------------
async function notifyScholar(scholarId, title, message, type = 'info', referenceId = null) {
  try {
    const rows = await query(
      `SELECT s.user_id, sp.name AS program_name
         FROM scholars s
         JOIN scholarship_programs sp ON sp.id = s.scholarship_id
        WHERE s.id = ? LIMIT 1`,
      [scholarId]
    );
    const scholar = rows && rows[0];
    if (!scholar) return;

    const text = typeof message === 'function' ? message(scholar) : message;
    await query(
      `INSERT INTO notifications (user_id, title, message, type, reference_type, reference_id)
       VALUES (?, ?, ?, ?, 'disbursement', ?)`,
      [scholar.user_id, title, text, type, referenceId != null ? referenceId : scholarId]
    );
  } catch (err) {
    console.error(`disbursementService: failed to notify scholar #${scholarId}:`, err.message);
  }
}

// Load one scholar with program/student/user context, locking ONLY the
// `scholars` row so a concurrent release cannot slip past a standing check.
async function lockScholar(connection, scholarId) {
  const [rows] = await connection.query(
    `SELECT s.id, s.application_id, s.student_id, s.scholarship_id, s.user_id,
            s.status, s.awarded_at, s.accepted_at,
            u.first_name, u.middle_name, u.last_name, u.email,
            st.student_number,
            sp.name AS program_name, sp.amount AS program_amount, sp.status AS program_status
       FROM scholars s
       JOIN users u  ON u.id  = s.user_id
       JOIN students st ON st.id = s.student_id
       JOIN scholarship_programs sp ON sp.id = s.scholarship_id
      WHERE s.id = ?
      FOR UPDATE OF s`,
    [scholarId]
  );
  return rows && rows[0];
}

// Load one disbursement (with its scholar/program context) under a row lock.
async function lockDisbursement(connection, id) {
  const [rows] = await connection.query(
    `SELECT d.*,
            s.user_id, s.status AS scholar_status, s.scholarship_id, s.student_id,
            sp.name AS program_name,
            u.first_name, u.middle_name, u.last_name, u.email
       FROM disbursements d
       JOIN scholars s ON s.id = d.scholar_id
       JOIN scholarship_programs sp ON sp.id = s.scholarship_id
       JOIN users u ON u.id = s.user_id
      WHERE d.id = ?
      FOR UPDATE OF d`,
    [id]
  );
  return rows && rows[0];
}

// Re-read a disbursement (unlocked) for the response body.
async function getDisbursementRow(id) {
  const rows = await query(
    `SELECT d.*,
            s.user_id, s.status AS scholar_status, s.scholarship_id,
            sp.name AS program_name,
            u.first_name, u.middle_name, u.last_name, u.email,
            ru.first_name AS released_by_first_name, ru.last_name AS released_by_last_name
       FROM disbursements d
       JOIN scholars s ON s.id = d.scholar_id
       JOIN scholarship_programs sp ON sp.id = s.scholarship_id
       JOIN users u ON u.id = s.user_id
       LEFT JOIN users ru ON ru.id = d.released_by
      WHERE d.id = ? LIMIT 1`,
    [id]
  );
  return rows && rows[0];
}

// ------------------------------------------------------------
// READ — scholar roster (Active Scholars + their funding totals).
// Filters: scholarship_id, status, search (name / email / student no / program)
// ------------------------------------------------------------
const SCHOLAR_SELECT = `
  SELECT s.id,
         s.application_id,
         s.student_id,
         s.scholarship_id,
         s.user_id,
         s.status AS scholar_status,
         s.awarded_at,
         s.accepted_at,
         s.contract_version,
         u.first_name, u.middle_name, u.last_name, u.email,
         st.student_number, st.year_level,
         sp.name AS program_name,
         sp.amount::float8 AS program_amount,
         sp.status AS program_status,
         COALESCE(agg.total_released, 0)::float8 AS total_released,
         COALESCE(agg.pending_amount, 0)::float8 AS pending_amount,
         COALESCE(agg.released_count, 0)::int AS released_count,
         COALESCE(agg.pending_count, 0)::int  AS pending_count,
         agg.last_released_at
    FROM scholars s
    JOIN users u  ON u.id  = s.user_id
    JOIN students st ON st.id = s.student_id
    JOIN scholarship_programs sp ON sp.id = s.scholarship_id
    LEFT JOIN (
      SELECT scholar_id,
             SUM(CASE WHEN status = 'released' THEN amount ELSE 0 END) AS total_released,
             SUM(CASE WHEN status IN ('pending', 'processing') THEN amount ELSE 0 END) AS pending_amount,
             COUNT(*) FILTER (WHERE status = 'released') AS released_count,
             COUNT(*) FILTER (WHERE status IN ('pending', 'processing')) AS pending_count,
             MAX(released_at) AS last_released_at
        FROM disbursements
       GROUP BY scholar_id
    ) agg ON agg.scholar_id = s.id`;

function scholarFilters(filters = {}) {
  const { scholarship_id: scholarshipId, status, search } = filters;
  const where = [];
  const args = [];
  if (scholarshipId) {
    where.push('s.scholarship_id = ?');
    args.push(Number(scholarshipId));
  }
  if (status) {
    where.push('s.status = ?');
    args.push(String(status));
  }
  if (search && String(search).trim()) {
    const term = `%${String(search).trim()}%`;
    where.push(`(u.first_name ILIKE ? OR u.last_name ILIKE ? OR u.email ILIKE ?
                 OR st.student_number ILIKE ? OR sp.name ILIKE ?)`);
    args.push(term, term, term, term, term);
  }
  return { where, args };
}

async function listScholars(filters = {}) {
  const { where, args } = scholarFilters(filters);
  const rows = await query(
    `${SCHOLAR_SELECT}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY s.awarded_at DESC, s.id DESC
     LIMIT 500`,
    args
  );
  return rows || [];
}

async function getScholarDetail(scholarId) {
  const rows = await query(`${SCHOLAR_SELECT} WHERE s.id = ? LIMIT 1`, [scholarId]);
  const scholar = rows && rows[0];
  if (!scholar) throw new DisbursementError('Scholar not found.', 404);

  const disbursements = await query(
    `SELECT d.id, d.term, d.amount::float8 AS amount, d.status, d.scheduled_date,
            d.released_at, d.released_by, d.reference_no, d.notes, d.created_at,
            d.claimed_by, d.recipient_name, d.claimant_id_note, d.id_verified,
            d.acknowledged_at, d.acknowledged_signature,
            ru.first_name AS released_by_first_name, ru.last_name AS released_by_last_name
       FROM disbursements d
       LEFT JOIN users ru ON ru.id = d.released_by
      WHERE d.scholar_id = ?
      ORDER BY d.created_at DESC, d.id DESC`,
    [scholarId]
  );

  return { scholar, disbursements: disbursements || [] };
}


// ------------------------------------------------------------
// READ — disbursement ledger.
// Filters: scholar_id, scholarship_id, status, term, search
// (scholar name / student no / reference no / program)
// ------------------------------------------------------------
const DISBURSEMENT_SELECT = `
  SELECT d.id,
         d.scholar_id,
         d.term,
         d.amount::float8 AS amount,
         d.status,
         d.scheduled_date,
         d.released_at,
         d.released_by,
         d.reference_no,
         d.notes,
         d.claimed_by,
         d.recipient_name,
         d.claimant_id_note,
         d.id_verified,
         d.acknowledged_at,
         d.acknowledged_signature,
         d.created_at,
         s.scholarship_id,
         s.status AS scholar_status,
         u.first_name, u.middle_name, u.last_name, u.email,
         st.student_number,
         sp.name AS program_name,
         ru.first_name AS released_by_first_name,
         ru.last_name  AS released_by_last_name
    FROM disbursements d
    JOIN scholars s ON s.id = d.scholar_id
    JOIN users u ON u.id = s.user_id
    JOIN students st ON st.id = s.student_id
    JOIN scholarship_programs sp ON sp.id = s.scholarship_id
    LEFT JOIN users ru ON ru.id = d.released_by`;

function disbursementFilters(filters = {}) {
  const { scholar_id: scholarId, scholarship_id: scholarshipId, status, term, search } = filters;
  const where = [];
  const args = [];
  if (scholarId) {
    where.push('d.scholar_id = ?');
    args.push(Number(scholarId));
  }
  if (scholarshipId) {
    where.push('s.scholarship_id = ?');
    args.push(Number(scholarshipId));
  }
  if (status) {
    where.push('d.status = ?');
    args.push(String(status));
  }
  if (term && String(term).trim()) {
    where.push('d.term ILIKE ?');
    args.push(`%${String(term).trim()}%`);
  }
  if (search && String(search).trim()) {
    const value = `%${String(search).trim()}%`;
    where.push(`(u.first_name ILIKE ? OR u.last_name ILIKE ? OR u.email ILIKE ?
                 OR st.student_number ILIKE ? OR COALESCE(d.reference_no, '') ILIKE ?
                 OR sp.name ILIKE ?)`);
    args.push(value, value, value, value, value, value);
  }
  return { where, args };
}

async function listDisbursements(filters = {}) {
  const { where, args } = disbursementFilters(filters);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await query(
    `${DISBURSEMENT_SELECT}
     ${whereSql}
     ORDER BY CASE d.status
                WHEN 'pending' THEN 0
                WHEN 'processing' THEN 1
                WHEN 'released' THEN 2
                ELSE 3
              END,
              COALESCE(d.scheduled_date, d.created_at::date) DESC,
              d.id DESC
     LIMIT 500`,
    args
  );

  // Ledger totals over the SAME filter (independent of the 500-row page cap).
  const totalsRows = await query(
    `SELECT COUNT(*)::int AS total_count,
            COALESCE(SUM(CASE WHEN d.status = 'pending'    THEN d.amount ELSE 0 END), 0)::float8 AS pending_amount,
            COALESCE(SUM(CASE WHEN d.status = 'processing' THEN d.amount ELSE 0 END), 0)::float8 AS processing_amount,
            COALESCE(SUM(CASE WHEN d.status = 'released'   THEN d.amount ELSE 0 END), 0)::float8 AS released_amount,
            COALESCE(SUM(CASE WHEN d.status = 'cancelled'  THEN d.amount ELSE 0 END), 0)::float8 AS cancelled_amount,
            COUNT(*) FILTER (WHERE d.status = 'pending')::int    AS pending_count,
            COUNT(*) FILTER (WHERE d.status = 'processing')::int AS processing_count,
            COUNT(*) FILTER (WHERE d.status = 'released')::int   AS released_count,
            COUNT(*) FILTER (WHERE d.status = 'cancelled')::int  AS cancelled_count
       FROM disbursements d
       JOIN scholars s ON s.id = d.scholar_id
       JOIN users u ON u.id = s.user_id
       JOIN students st ON st.id = s.student_id
       JOIN scholarship_programs sp ON sp.id = s.scholarship_id
       ${whereSql}`,
    args
  );

  return { disbursements: rows || [], totals: (totalsRows && totalsRows[0]) || null };
}

async function getSummary() {
  const rows = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM scholars) AS total_scholars,
       (SELECT COUNT(*)::int FROM scholars WHERE status = 'active') AS active_scholars,
       (SELECT COUNT(*)::int FROM scholars WHERE status = 'renewal_pending') AS renewal_pending_scholars,
       (SELECT COUNT(*)::int FROM scholars WHERE status = 'revoked') AS revoked_scholars,
       (SELECT COUNT(*)::int FROM disbursements WHERE status = 'pending') AS pending_count,
       (SELECT COUNT(*)::int FROM disbursements WHERE status = 'processing') AS processing_count,
       (SELECT COUNT(*)::int FROM disbursements WHERE status = 'released') AS released_count,
       (SELECT COUNT(*)::int FROM disbursements WHERE status = 'cancelled') AS cancelled_count,
       (SELECT COALESCE(SUM(amount), 0)::float8 FROM disbursements WHERE status = 'pending') AS pending_amount,
       (SELECT COALESCE(SUM(amount), 0)::float8 FROM disbursements WHERE status = 'processing') AS processing_amount,
       (SELECT COALESCE(SUM(amount), 0)::float8 FROM disbursements WHERE status = 'released') AS released_amount,
       (SELECT COALESCE(SUM(amount), 0)::float8 FROM disbursements WHERE status = 'cancelled') AS cancelled_amount`,
    []
  );
  return (rows && rows[0]) || null;
}


// ------------------------------------------------------------
// WRITE — schedule a fund release for one scholar + term.
// Pending rows are editable; nothing is final until it is released.
// ------------------------------------------------------------
async function scheduleDisbursement(payload = {}, actorId) {
  const scholarId = Number(payload.scholar_id ?? payload.scholarId);
  if (!Number.isInteger(scholarId) || scholarId <= 0) {
    throw new DisbursementError('A valid scholar is required.', 400);
  }
  const term = cleanTerm(payload.term);
  const requestedAmount = cleanAmount(payload.amount);
  const scheduledDate = cleanDate(payload.scheduled_date ?? payload.scheduledDate);
  const notes = cleanNotes(payload.notes);

  const created = await transaction(async (connection) => {
    const scholar = await lockScholar(connection, scholarId);
    if (!scholar) throw new DisbursementError('Scholar not found.', 404);

    // Only scholars still receiving support may be funded.
    if (!RELEASABLE_SCHOLAR_STATUSES.includes(scholar.status)) throw standingError(scholar.status);

    const [open] = await connection.query(
      `SELECT id, status FROM disbursements
        WHERE scholar_id = ? AND term = ? AND status IN ('pending', 'processing')
        LIMIT 1`,
      [scholarId, term]
    );
    if (open && open.length) {
      throw new DisbursementError(
        `A ${open[0].status} release already exists for "${term}". Complete or cancel it before scheduling another.`,
        409
      );
    }

    // Fall back to the program's configured award amount.
    const amount = requestedAmount != null ? requestedAmount : cleanAmount(scholar.program_amount);
    if (amount == null) {
      throw new DisbursementError(
        'An amount is required — this program has no configured award amount.',
        400
      );
    }

    const header = await connection.execute(
      `INSERT INTO disbursements (scholar_id, term, amount, status, scheduled_date, notes)
       VALUES (?, ?, ?, 'pending', ?, ?)
       RETURNING id`,
      [scholarId, term, amount, scheduledDate, notes]
    );

    return { id: header.insertId, scholar, amount, term };
  });

  await notifyScholar(
    scholarId,
    'Disbursement Scheduled',
    `A ${peso(created.amount)} release for ${term} under "${created.scholar.program_name}" has been queued.` +
      (scheduledDate ? ` Target release date: ${scheduledDate}.` : ''),
    'info'
  );

  await logAdminAction({
    actorId,
    action: 'DISBURSEMENT_SCHEDULED',
    entityType: 'disbursement',
    entityId: created.id,
    details: {
      scholarId,
      scholarshipId: created.scholar.scholarship_id,
      term,
      amount: created.amount,
      scheduledDate,
    },
  });

  return getDisbursementRow(created.id);
}

// ------------------------------------------------------------
// WRITE — edit a still-pending release (amount / term / date / notes).
// ------------------------------------------------------------
async function updateDisbursement(id, payload = {}, actorId) {
  const changed = await transaction(async (connection) => {
    const row = await lockDisbursement(connection, id);
    if (!row) throw new DisbursementError('Disbursement not found.', 404);
    if (row.status !== 'pending') {
      throw new DisbursementError(
        `Only pending releases can be edited. This one is "${row.status}".`,
        409
      );
    }

    const sets = [];
    const args = [];
    const details = {};

    if (payload.term !== undefined) {
      const term = cleanTerm(payload.term);
      sets.push('term = ?');
      args.push(term);
      details.term = term;
    }
    if (payload.amount !== undefined) {
      const amount = cleanAmount(payload.amount);
      if (amount == null) throw new DisbursementError('Amount must be greater than zero.', 400);
      sets.push('amount = ?');
      args.push(amount);
      details.amount = amount;
    }
    if (payload.scheduled_date !== undefined || payload.scheduledDate !== undefined) {
      const scheduledDate = cleanDate(payload.scheduled_date ?? payload.scheduledDate);
      sets.push('scheduled_date = ?');
      args.push(scheduledDate);
      details.scheduledDate = scheduledDate;
    }
    if (payload.notes !== undefined) {
      const notes = cleanNotes(payload.notes);
      sets.push('notes = ?');
      args.push(notes);
      details.notes = notes;
    }

    if (!sets.length) throw new DisbursementError('Nothing to update.', 400);

    await connection.execute(
      `UPDATE disbursements SET ${sets.join(', ')} WHERE id = ?`,
      [...args, id]
    );
    return { id, details };
  });

  await logAdminAction({
    actorId,
    action: 'DISBURSEMENT_UPDATED',
    entityType: 'disbursement',
    entityId: id,
    details: changed.details,
  });

  return getDisbursementRow(id);
}


// ------------------------------------------------------------
// WRITE — pending → processing (funds are being prepared for release).
// ------------------------------------------------------------
async function markProcessing(id, actorId) {
  const row = await transaction(async (connection) => {
    const current = await lockDisbursement(connection, id);
    if (!current) throw new DisbursementError('Disbursement not found.', 404);
    if (current.status !== 'pending') {
      throw new DisbursementError(
        `Only pending releases can move to processing. This one is "${current.status}".`,
        409
      );
    }
    if (!RELEASABLE_SCHOLAR_STATUSES.includes(current.scholar_status)) {
      throw standingError(current.scholar_status);
    }

    await connection.execute(
      `UPDATE disbursements SET status = 'processing' WHERE id = ?`,
      [id]
    );
    return current;
  });

  await notifyScholar(
    row.scholar_id,
    'Disbursement In Process',
    `Your ${peso(row.amount)} release for ${row.term} under "${row.program_name}" is now being processed.`,
    'info',
    id
  );

  await logAdminAction({
    actorId,
    action: 'DISBURSEMENT_PROCESSING',
    entityType: 'disbursement',
    entityId: id,
    details: { scholarId: row.scholar_id, term: row.term, amount: Number(row.amount) },
  });

  return getDisbursementRow(id);
}

// ------------------------------------------------------------
// WRITE — release the funds. This is the money-out moment:
//   • scholar must still be in good standing (standing re-checked under lock)
//   • a reference number is mandatory for accountability
//   • released_at / released_by are stamped for the audit trail
//   • the counter receipt is recorded too (who collected the cash): the
//     scholar in person, or a representative whose name + ID are captured
// ------------------------------------------------------------
async function releaseDisbursement(id, payload = {}, actorId) {
  const referenceNo = cleanReference(payload.reference_no ?? payload.referenceNo);
  const extraNotes = cleanNotes(payload.notes);

  // Walk-in receipt — validated BEFORE the transaction so a bad payload
  // never takes a row lock.
  const claimedBy = cleanClaimedBy(payload.claimed_by ?? payload.claimedBy);
  const isRepresentative = claimedBy === 'representative';
  const requestedRecipient = cleanRecipientName(
    payload.recipient_name ?? payload.recipientName,
    { required: isRepresentative }
  );
  const claimantIdNote = cleanClaimantNote(
    payload.claimant_id_note ?? payload.claimantIdNote ?? payload.id_note,
    { required: isRepresentative }
  );
  // For a self-claim the staff member is looking at the scholar, so identity
  // is verified by definition; a representative must be explicitly checked.
  const idVerified = isRepresentative
    ? cleanBoolean(payload.id_verified ?? payload.idVerified ?? payload.identity_verified)
    : true;
  if (isRepresentative && !idVerified) {
    throw new DisbursementError(
      "Confirm that the representative's ID was verified before releasing the funds.", 400
    );
  }

  const row = await transaction(async (connection) => {
    const current = await lockDisbursement(connection, id);
    if (!current) throw new DisbursementError('Disbursement not found.', 404);

    if (current.status === 'released') {
      throw new DisbursementError('These funds have already been released.', 409);
    }
    if (current.status === 'cancelled') {
      throw new DisbursementError('This release was cancelled and cannot be paid out.', 409);
    }
    if (!RELEASABLE_SCHOLAR_STATUSES.includes(current.scholar_status)) {
      throw standingError(current.scholar_status);
    }

    // A self-claim defaults to the scholar's own registered name; a
    // representative claim always carries the name captured above.
    const recipientName =
      requestedRecipient ||
      `${current.first_name || ''} ${current.last_name || ''}`.trim() ||
      'Scholarship recipient';

    await connection.execute(
      `UPDATE disbursements
          SET status = 'released',
              released_at = NOW(),
              released_by = ?,
              reference_no = ?,
              notes = COALESCE(?, notes),
              claimed_by = ?,
              recipient_name = ?,
              claimant_id_note = ?,
              id_verified = ?
        WHERE id = ?`,
      [actorId, referenceNo, extraNotes, claimedBy, recipientName, claimantIdNote, idVerified, id]
    );
    // `current` still holds the pre-release status — used for the audit trail.
    return { ...current, recipient_name: recipientName, claimed_by: claimedBy };
  });

  await notifyScholar(
    row.scholar_id,
    'Disbursement Released 💸',
    `Your ${peso(row.amount)} release for ${row.term} under "${row.program_name}" has been released to ` +
      `${row.recipient_name}${claimedBy === 'representative' ? ' (authorized representative)' : ''}. ` +
      `Reference No: ${referenceNo}. Please open My Funds to confirm that you received it.`,
    'success',
    id
  );

  await logAdminAction({
    actorId,
    action: 'DISBURSEMENT_RELEASED',
    entityType: 'disbursement',
    entityId: id,
    details: {
      scholarId: row.scholar_id,
      scholarshipId: row.scholarship_id,
      term: row.term,
      amount: Number(row.amount),
      referenceNo,
      previousStatus: row.status,
      claimedBy,
      recipientName: row.recipient_name,
      claimantIdNote,
      idVerified,
    },
  });

  return getDisbursementRow(id);
}

// ------------------------------------------------------------
// WRITE — cancel an un-released disbursement. A documented reason is
// mandatory, and released money can never be cancelled here (it is already
// out of the door — record a separate reversal instead).
// ------------------------------------------------------------
async function cancelDisbursement(id, reason, actorId) {
  const cleanReason = String(reason == null ? '' : reason).trim();
  if (cleanReason.length < 5) {
    throw new DisbursementError('A documented reason (min 5 characters) is required to cancel.', 400);
  }
  if (cleanReason.length > NOTES_MAX) {
    throw new DisbursementError(`The reason must be ${NOTES_MAX} characters or fewer.`, 400);
  }

  const row = await transaction(async (connection) => {
    const current = await lockDisbursement(connection, id);
    if (!current) throw new DisbursementError('Disbursement not found.', 404);
    if (current.status === 'released') {
      throw new DisbursementError(
        'Released funds cannot be cancelled — record a reversal instead.',
        409
      );
    }
    if (current.status === 'cancelled') {
      throw new DisbursementError('This release is already cancelled.', 409);
    }

    await connection.execute(
      `UPDATE disbursements
          SET status = 'cancelled',
              notes = CONCAT(COALESCE(notes || ' | ', ''), 'Cancelled: ', ?::text)
        WHERE id = ?`,
      [cleanReason, id]
    );
    return current;
  });

  await notifyScholar(
    row.scholar_id,
    'Disbursement Cancelled',
    `Your ${peso(row.amount)} release for ${row.term} under "${row.program_name}" was cancelled. Reason: ${cleanReason}`,
    'warning',
    id
  );

  await logAdminAction({
    actorId,
    action: 'DISBURSEMENT_CANCELLED',
    entityType: 'disbursement',
    entityId: id,
    details: {
      scholarId: row.scholar_id,
      term: row.term,
      amount: Number(row.amount),
      previousStatus: row.status,
      reason: cleanReason,
    },
  });

  return getDisbursementRow(id);
}

// ------------------------------------------------------------
// READ — the signed-in scholar's own money trail (self-service).
// A "scholar" is an applicant-role user whose `scholars` row links here.
// ------------------------------------------------------------
async function listMyDisbursements(userId) {
  const scholarRows = await query(
    `SELECT s.id, s.status AS scholar_status, s.awarded_at, s.accepted_at,
            sp.name AS program_name, sp.amount::float8 AS program_amount,
            st.student_number
       FROM scholars s
       JOIN scholarship_programs sp ON sp.id = s.scholarship_id
       JOIN students st ON st.id = s.student_id
      WHERE s.user_id = ?
      ORDER BY s.id DESC
      LIMIT 1`,
    [userId]
  );
  const scholar = scholarRows && scholarRows[0];
  if (!scholar) {
    throw new DisbursementError('No scholarship record is linked to this account.', 404);
  }

  const disbursements = await query(
    `SELECT d.id, d.term, d.amount::float8 AS amount, d.status, d.scheduled_date,
            d.released_at, d.reference_no, d.notes, d.created_at,
            d.claimed_by, d.recipient_name, d.claimant_id_note, d.id_verified,
            d.acknowledged_at, d.acknowledged_signature,
            ru.first_name AS released_by_first_name, ru.last_name AS released_by_last_name
       FROM disbursements d
       LEFT JOIN users ru ON ru.id = d.released_by
      WHERE d.scholar_id = ?
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT 200`,
    [scholar.id]
  );

  const totalsRows = await query(
    `SELECT COALESCE(SUM(CASE WHEN status = 'released' THEN amount ELSE 0 END), 0)::float8 AS released_amount,
            COALESCE(SUM(CASE WHEN status IN ('pending', 'processing') THEN amount ELSE 0 END), 0)::float8 AS pending_amount,
            COUNT(*) FILTER (WHERE status = 'released' AND acknowledged_at IS NULL)::int AS awaiting_acknowledgment_count,
            COUNT(*) FILTER (WHERE status = 'released' AND acknowledged_at IS NOT NULL)::int AS acknowledged_count
       FROM disbursements
      WHERE scholar_id = ?`,
    [scholar.id]
  );

  return {
    scholar,
    disbursements: disbursements || [],
    totals: (totalsRows && totalsRows[0]) || null,
  };
}

// ------------------------------------------------------------
// WRITE — the scholar confirms they received the funds.
// Deliberately independent of the staff release record: the counter receipt
// says what staff handed over, this says the scholar agrees they got it.
// Signature rule mirrors selectionService.acceptAward (typed full name).
// ------------------------------------------------------------
async function acknowledgeReceipt(id, userId, signature) {
  const sig = cleanSignature(signature);

  const row = await transaction(async (connection) => {
    const current = await lockDisbursement(connection, id);
    // A scholar may only touch their OWN row — missing and foreign rows are
    // indistinguishable to the caller, so ids cannot be probed.
    if (!current || Number(current.user_id) !== Number(userId)) {
      throw new DisbursementError('Disbursement not found.', 404);
    }
    if (current.status !== 'released') {
      throw new DisbursementError(
        'These funds have not been released yet, so there is nothing to confirm.', 409
      );
    }
    if (current.acknowledged_at) {
      throw new DisbursementError('You have already confirmed receiving these funds.', 409);
    }

    const fullName = `${current.first_name || ''} ${current.last_name || ''}`
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
    if (sig.toLowerCase() !== fullName) {
      throw new DisbursementError('The signature must match your registered full name.', 400);
    }

    await connection.execute(
      `UPDATE disbursements
          SET acknowledged_at = NOW(),
              acknowledged_signature = ?,
              acknowledged_by = ?
        WHERE id = ?`,
      [sig, userId, id]
    );
    return current;
  });

  await logAdminAction({
    actorId: userId,
    action: 'DISBURSEMENT_RECEIVED',
    entityType: 'disbursement',
    entityId: id,
    details: {
      scholarId: row.scholar_id,
      term: row.term,
      amount: Number(row.amount),
      referenceNo: row.reference_no,
      claimedBy: row.claimed_by,
      recipientName: row.recipient_name,
      signature: sig,
    },
  });

  return getDisbursementRow(id);
}

module.exports = {
  listScholars,
  getScholarDetail,
  listDisbursements,
  getSummary,
  getDisbursementRow,
  scheduleDisbursement,
  updateDisbursement,
  markProcessing,
  releaseDisbursement,
  cancelDisbursement,
  listMyDisbursements,
  acknowledgeReceipt,
  // exported for route validation / tests
  DisbursementError,
  RELEASABLE_SCHOLAR_STATUSES,
  SCHOLAR_STATUS_LABELS,
  CLAIMANT_TYPES,
};

