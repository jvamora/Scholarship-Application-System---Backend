const { query, execute, transaction } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class Application {
  // Submit a new application
  static async submit(applicationData, userId, documents = []) {
    const { scholarshipId, answers } = applicationData;

    // Get or auto-create student record for user
    let students = await query('SELECT id FROM students WHERE user_id = ?', [userId]);
    if (!students || students.length === 0) {
      // Fetch user info to build a student number
      const users = await query('SELECT id, email FROM users WHERE id = ?', [userId]);
      if (!users || users.length === 0) throw new Error('User not found.');
      const emailPrefix = (users[0].email || '').split('@')[0].replace(/[^a-z0-9]/gi, '').toUpperCase();
      const studentNumber = `STU-${emailPrefix}-${userId}`;
      await query(
        'INSERT INTO students (user_id, student_number) VALUES (?, ?)',
        [userId, studentNumber]
      );
      students = await query('SELECT id FROM students WHERE user_id = ?', [userId]);
    }
    const studentId = students[0].id;

    // Duplicate-application guard: only one active application per scholarship
    const existing = await query(
      "SELECT id FROM applications WHERE student_id = ? AND scholarship_id = ? AND status NOT IN ('rejected', 'withdrawn') LIMIT 1",
      [studentId, scholarshipId]
    );
    if (existing && existing.length > 0) {
      const err = new Error('You have already submitted an application for this scholarship program.');
      err.status = 409;
      throw err;
    }

    // Scholarship availability guard: must be open, before the deadline, and
    // still have slots. This is re-validated server-side on every submit so a
    // direct API call cannot bypass the UI's apply-button checks.
    const programRows = await query(
      'SELECT id, status, deadline, slots, available_slots FROM scholarship_programs WHERE id = ? LIMIT 1',
      [scholarshipId]
    );
    if (!programRows || programRows.length === 0) {
      const err = new Error('Scholarship program not found.');
      err.status = 404;
      throw err;
    }
    const program = programRows[0];

    if (program.status !== 'open') {
      const err = new Error(`This scholarship program is ${program.status} and is not accepting applications.`);
      err.status = 400;
      throw err;
    }

    if (program.deadline) {
      const dl = new Date(`${String(program.deadline).slice(0, 10)}T23:59:59`);
      if (!Number.isNaN(dl.getTime()) && dl < new Date()) {
        const err = new Error('The application deadline for this scholarship has passed.');
        err.status = 400;
        throw err;
      }
    }

    // NOTE (slot-model v2): applications are unlimited — program slots are the
    // award budget consumed by the selection phase, never at submission time.

    // Get active academic year
    const academicYears = await query('SELECT id FROM academic_years WHERE is_active = TRUE LIMIT 1');
    if (!academicYears || academicYears.length === 0) {
      throw new Error('No active academic year found.');
    }
    const academicYearId = academicYears[0].id;

    const appNumber = `APP-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;

    const newApplicationId = await transaction(async (connection) => {
      const [appResult] = await connection.query(`
        INSERT INTO applications 
          (application_number, student_id, scholarship_id, academic_year_id, status, submitted_at)
        VALUES (?, ?, ?, ?, 'submitted', NOW())
      `, [appNumber, studentId, scholarshipId, academicYearId]);

      const applicationId = appResult.insertId;

      // NOTE (slot-model v2): no slot consumption at submission — slots are
      // consumed by selectionService only when awards are finalized.

      // Insert documents — resolve each upload to a requirement of this program
      if (documents.length > 0) {
        const resolveRequirementId = await this.buildRequirementResolver(scholarshipId);

        for (const doc of documents) {
          const dv = [
            applicationId,
          resolveRequirementId(doc),
          doc.originalname,
          doc.path || doc.filename,
          doc.size,
          doc.mimetype,
        ];
          await connection.query(`
            INSERT INTO application_documents 
              (application_id, requirement_id, file_name, file_path, file_size_bytes, mime_type)
            VALUES (?, ?, ?, ?, ?, ?)
          `, dv);
        }
      }

      // Insert status history
      await connection.query(`
        INSERT INTO application_status_history 
          (application_id, status, changed_by, remarks)
        VALUES (?, 'submitted', ?, 'Application submitted')
      `, [applicationId, userId]);

      return appResult.insertId;
    });
    return this.getById(newApplicationId);
  }

  // Find application by ID
  static async getById(id) {
    const rows = await query(`
      SELECT 
        a.*,
        st.user_id,
        sp.name as scholarship_name, sp.deadline,
        u.first_name, u.last_name, u.email
      FROM applications a
      JOIN scholarship_programs sp ON a.scholarship_id = sp.id
      JOIN students st ON a.student_id = st.id
      JOIN users u ON st.user_id = u.id
      WHERE a.id = ?
    `, [id]);

    if (!rows || rows.length === 0) return null;
    const app = rows[0];

    // Attach uploaded documents for this application
    const documents = await query(`
      SELECT ad.id, ad.file_name, ad.file_size_bytes, ad.mime_type, ad.requirement_id
      FROM application_documents ad
      WHERE ad.application_id = ?
      ORDER BY ad.id ASC
    `, [id]);

    // Attach the full status-history timeline with "changed by" names
    const history = await query(`
      SELECT ash.status, ash.remarks, ash.created_at,
             u.first_name, u.last_name
      FROM application_status_history ash
      LEFT JOIN users u ON ash.changed_by = u.id
      WHERE ash.application_id = ?
      ORDER BY ash.created_at ASC
    `, [id]);

    return { ...app, documents: documents || [], history: history || [] };
  }

  // Get applications for a user
  static async getByUser(userId) {
    const rows = await query(`
      SELECT 
        a.*,
        sp.name as scholarship_name, sp.deadline, sp.status as scholarship_status
      FROM applications a
      JOIN scholarship_programs sp ON a.scholarship_id = sp.id
      JOIN students st ON a.student_id = st.id
      WHERE st.user_id = ?
      ORDER BY a.created_at DESC
    `, [userId]);
    return rows || [];
  }

  // Get applications for a scholarship
  static async getByScholarship(scholarshipId) {
    const rows = await query(`
      SELECT 
        a.*,
        u.first_name, u.last_name, u.email
      FROM applications a
      JOIN students st ON a.student_id = st.id
      JOIN users u ON st.user_id = u.id
      WHERE a.scholarship_id = ?
      ORDER BY a.created_at DESC
    `, [scholarshipId]);
    return rows || [];
  }

  // Update application status
  static async updateStatus(applicationId, status, changedBy = null, remarks = '') {
    // NOTE (slot-model v2): statuses no longer carry slot side effects —
    // available_slots is owned exclusively by selectionService.
    await transaction(async (connection) => {
      await connection.query(`
        UPDATE applications 
        SET status = ?, updated_at = NOW()
        WHERE id = ?
      `, [status, applicationId]);

      await connection.query(`
        INSERT INTO application_status_history 
          (application_id, status, changed_by, remarks)
        VALUES (?, ?, ?, ?)
      `, [applicationId, status, changedBy, remarks]);

      // NOTE (slot-model v2): no slot side effects here — available_slots is
      // owned exclusively by selectionService.

    });
    return this.getById(applicationId);
  }

    // Re-open a rejected/withdrawn application to 'submitted', consuming a slot
  // again so the applicant can fix & resubmit without staff intervention.
  static async resubmit(applicationId, userId) {
    // Ownership check + current status in one query. IDOR-safe: returns 404
    // whether the row doesn't exist or belongs to another user.
    const appRows = await query(
      `SELECT a.id, a.student_id, a.scholarship_id, a.status AS current_status
         FROM applications a
         JOIN students st ON st.id = a.student_id
        WHERE a.id = ? AND st.user_id = ?
        LIMIT 1`,
      [applicationId, userId]
    );
    if (!appRows || appRows.length === 0) {
      const err = new Error('Application not found.');
      err.status = 404;
      throw err;
    }
    const app = appRows[0];

    // Only applications that exited the active lifecycle may be resubmitted.
    const RESUBMITTABLE = ['rejected', 'withdrawn'];
    if (!RESUBMITTABLE.includes(app.current_status)) {
      const err = new Error(`Only rejected or withdrawn applications can be resubmitted (current status: "${app.current_status}").`);
      err.status = 400;
      throw err;
    }

    // Re-validate program availability server-side — mirrors submit() so a
    // direct API call cannot bypass the UI's apply-button checks.
    const programRows = await query(
      `SELECT id, status, deadline, slots, available_slots
         FROM scholarship_programs
         WHERE id = ?
         LIMIT 1`,
      [app.scholarship_id]
    );
    if (!programRows || programRows.length === 0) {
      const err = new Error('Scholarship program not found.');
      err.status = 404;
      throw err;
    }
    const program = programRows[0];

    if (program.status !== 'open') {
      const err = new Error(`This scholarship program is ${program.status} and is not accepting applications.`);
      err.status = 400;
      throw err;
    }

    if (program.deadline) {
      const dl = new Date(`${String(program.deadline).slice(0, 10)}T23:59:59`);
      if (!Number.isNaN(dl.getTime()) && dl < new Date()) {
        const err = new Error('The application deadline for this scholarship has passed.');
        err.status = 400;
        throw err;
      }
    }

    // NOTE (slot-model v2): no slot gating on resubmission — the award budget
    // is owned exclusively by the selection phase.

    await transaction(async (connection) => {
      // Move the application back to 'submitted'
      await connection.query(
        `UPDATE applications
            SET status = 'submitted', updated_at = NOW()
          WHERE id = ?`,
        [applicationId]
      );

      // Record the resubmission in the status-history timeline
      await connection.query(
        `INSERT INTO application_status_history
            (application_id, status, changed_by, remarks)
         VALUES (?, 'submitted', ?, 'Application resubmitted by applicant')`,
        [applicationId, userId]
      );

      // NOTE (slot-model v2): no slot consumption on resubmission.
    });
    return this.getById(applicationId);
  }

    // Update a rejected/withdrawn application's answers and/or documents.
  // This is the "fix" half of "fix & resubmit" — an applicant who was
  // rejected/withdrawn repairs the materials that caused the decision before
  // re-opening the application for review. Answers are persisted as a JSON
  // string (consistent with getApplication's JSON.parse on read) and the
  // document set is superseded so the committee reviews the corrected files
  // on the next resubmit. Mirrors submit()'s requirement_id resolution.
  static async update(applicationId, userId, { answers, documents = [] } = {}) {
    // Ownership + status guard in one query — only the owning applicant may
    // edit, and only while the application is rejected/withdrawn.
    const owners = await query(
      `SELECT a.id, a.status, a.scholarship_id
         FROM applications a
         JOIN students st ON st.id = a.student_id
        WHERE a.id = ? AND st.user_id = ?
        LIMIT 1`,
      [applicationId, userId]
    );
    if (!owners || owners.length === 0) {
      const err = new Error('Application not found or you are not authorized to edit it.');
      err.status = 404;
      throw err;
    }
    const { status } = owners[0];
    if (!['rejected', 'withdrawn'].includes(status)) {
      const err = new Error(`This application cannot be edited while in "${status}" state. Only rejected or withdrawn applications can be updated.`);
      err.status = 400;
      throw err;
    }

    await transaction(async (connection) => {
      if (answers !== undefined && answers !== null) {
        await connection.query(
          `UPDATE applications
              SET answers = ?, updated_at = NOW()
            WHERE id = ?`,
          [JSON.stringify(answers), applicationId]
        );
      }

      if (documents && documents.length > 0) {
        // Supersede the previously uploaded documents.
        await connection.query(
          'DELETE FROM application_documents WHERE application_id = ?',
          [applicationId]
        );

        // Resolve each upload to a requirement of this program (mirrors submit).
        const resolveRequirementId = await this.buildRequirementResolver(owners[0].scholarship_id);

        for (const doc of documents) {
          const requirementId = resolveRequirementId(doc);
          await connection.query(
            `INSERT INTO application_documents
               (application_id, requirement_id, file_name, file_path, file_size_bytes, mime_type)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              applicationId,
              requirementId,
              doc.originalname,
              doc.path || doc.filename,
              doc.size,
              doc.mimetype,
            ]
          );
        }
      }

    });
    return this.getById(applicationId);
  }

  // Build a resolver that maps an uploaded file to a requirement_id of ONE
  // program. Matching order: exact normalized name (multer fieldname, or the
  // filename without its extension), then substring containment, then the
  // program's first requirement as a safe fallback. The previous code
  // fell back to a hardcoded id=1, which may not exist and caused FK errors.
  static async buildRequirementResolver(scholarshipId) {
    const rows = await query(
      'SELECT id, name FROM requirements WHERE scholarship_id = ? ORDER BY id',
      [scholarshipId]
    );
    const reqs = (rows || []).map((r) => ({
      id: r.id,
      key: String(r.name || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    }));
    if (reqs.length > 0) {
      const fallbackId = reqs[0].id;
      return (doc) => {
        const fieldKey = String(doc.fieldname || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const fileKey = String(doc.originalname || '').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
        for (const r of reqs) {
          if (r.key && (r.key === fieldKey || r.key === fileKey)) return r.id;
        }
        for (const r of reqs) {
          if (r.key && (fileKey.includes(r.key) || r.key.includes(fileKey))) return r.id;
        }
        return fallbackId;
      };
    }
    // This program has no requirements configured - fall back to any existing
    // requirement row so the NOT NULL foreign key still resolves with a real id.
    const anyRows = await query('SELECT id FROM requirements ORDER BY id LIMIT 1');
    if (anyRows && anyRows[0]) {
      const anyId = anyRows[0].id;
      return () => anyId;
    }
    const err = new Error('No document requirements are configured for this scholarship program yet. Please contact the administrator.');
    err.status = 400;
    throw err;
  }

  // Get all applications with filters
  static async findAll(filters = {}) {
    const { status, scholarshipId, userId, limit = 100, offset = 0 } = filters;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (status) {
      whereClause += ' AND a.status = ?';
      params.push(status);
    }

    if (scholarshipId) {
      whereClause += ' AND a.scholarship_id = ?';
      params.push(scholarshipId);
    }

    if (userId) {
      whereClause += ' AND st.user_id = ?';
      params.push(userId);
    }

    const sql = `
      SELECT 
        a.*,
        sp.name as scholarship_name,
        u.first_name, u.last_name, u.email
      FROM applications a
      JOIN scholarship_programs sp ON a.scholarship_id = sp.id
      JOIN students st ON a.student_id = st.id
      JOIN users u ON st.user_id = u.id
      ${whereClause}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `;

    return query(sql, [...params, limit, offset]);
  }

  // Count applications
  static async count(filters = {}) {
    const { status } = filters;
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (status) {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    const result = await query(
      `SELECT COUNT(*) as count FROM applications ${whereClause}`,
      params
    );
    return result[0].count;
  }
}

module.exports = Application;
module.exports.default = Application;
