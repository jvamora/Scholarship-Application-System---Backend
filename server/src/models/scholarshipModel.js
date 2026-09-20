const { query, execute, transaction } = require('../config/database');

class Scholarship {
  // Create a new scholarship
  static async create(d) {
    const {
      name,
      description,
      eligibility,
      benefits,
      slots,
      available_slots,
      deadline,
      status,
      isActive,
      amount,
      image_url = null,
      createdBy = null,
      requirements,
    } = d;

    // Explicit status wins; otherwise derive from the isActive toggle (default open)
    const finalStatus = status || (isActive === false ? 'draft' : 'open');

    const result = await execute(`
      INSERT INTO scholarship_programs
        (name, description, eligibility, benefits, slots, available_slots, deadline, status, amount, image_url, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, description, eligibility, benefits || null, slots || 0, available_slots || slots || 0, deadline, finalStatus, amount ?? null, image_url, createdBy]);

    const newId = result.insertId;
    await this.replaceRequirements(newId, requirements);

    return this.findById(newId);
  }

  // Find scholarship by ID
  static async findById(id) {
    const rows = await query(`
      SELECT 
        sp.*,
        u.first_name as created_by_first_name,
        u.last_name as created_by_last_name
      FROM scholarship_programs sp
      LEFT JOIN users u ON sp.created_by = u.id
      WHERE sp.id = ?
    `, [id]);

    if (!rows || rows.length === 0) return null;
    const s = rows[0];

    // Get requirements
    const requirements = await query(
      'SELECT * FROM requirements WHERE scholarship_id = ?',
      [id]
    );

    return {
      ...s,
      requirements,
      created_by: s.created_by ? {
        id: s.created_by,
        first_name: s.created_by_first_name,
        last_name: s.created_by_last_name,
      } : null,
    };
  }

  // Find all scholarships with optional filters
  static async findAll(filters = {}) {
    const {
      status,
      search,
      isActive,
      minAmount,
      maxAmount,
      deadlineFrom,
      deadlineTo,
      excludeDraft,
      limit = 100,
      offset = 0,
    } = filters;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (excludeDraft) {
      whereClause += " AND sp.status != 'draft'";
    }

    if (status) {
      whereClause += ' AND sp.status = ?';
      params.push(status);
    }

    // The search UI exposes an "Active" toggle, which maps onto the program
    // status lifecycle: true → open programs only, false → everything else.
    if (isActive !== undefined && isActive !== null) {
      whereClause += isActive
        ? " AND sp.status = 'open'"
        : " AND sp.status != 'open'";
    }

    if (search) {
      whereClause += ' AND (sp.name LIKE ? OR sp.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    if (minAmount !== undefined && minAmount !== null) {
      whereClause += ' AND sp.amount >= ?';
      params.push(minAmount);
    }

    if (maxAmount !== undefined && maxAmount !== null) {
      whereClause += ' AND sp.amount <= ?';
      params.push(maxAmount);
    }

    if (deadlineFrom) {
      whereClause += ' AND sp.deadline >= ?';
      params.push(deadlineFrom);
    }

    if (deadlineTo) {
      whereClause += ' AND sp.deadline <= ?';
      params.push(deadlineTo);
    }

    const sql = `
      SELECT 
        sp.*,
        u.first_name as created_by_first_name,
        u.last_name as created_by_last_name
      FROM scholarship_programs sp
      LEFT JOIN users u ON sp.created_by = u.id
      ${whereClause}
      ORDER BY sp.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const scholarships = await query(sql, [...params, limit, offset]);
    return scholarships.map(s => ({
      ...s,
      created_by: s.created_by ? {
        id: s.created_by,
        first_name: s.created_by_first_name,
        last_name: s.created_by_last_name,
      } : null,
    }));
  }

  // Update scholarship (partial-safe: only sets provided fields)
  static async update(id, d) {
    const allowed = ['name', 'description', 'eligibility', 'benefits', 'slots', 'available_slots', 'deadline', 'status', 'amount', 'image_url'];

    // Derive status from isActive when provided without an explicit status
    if (d.status === undefined && d.isActive !== undefined) {
      d.status = d.isActive === false ? 'draft' : 'open';
    }

    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (d[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(key === 'benefits' ? (d[key] || null) : d[key]);
      }
    }

    if (sets.length > 0) {
      await execute(
        `UPDATE scholarship_programs SET ${sets.join(', ')} WHERE id = ?`,
        [...params, id]
      );
    }

    if (d.requirements !== undefined) {
      await this.replaceRequirements(id, d.requirements);
    }

    return this.findById(id);
  }

  // Replace the requirement rows for a scholarship from an array of names
  static async replaceRequirements(scholarshipId, requirements) {
    if (!Array.isArray(requirements)) return;
    await execute('DELETE FROM requirements WHERE scholarship_id = ?', [scholarshipId]);
    for (const raw of requirements) {
      const reqName = typeof raw === 'string' ? raw.trim() : (raw?.name || '').trim();
      if (reqName) {
        await execute(
          'INSERT INTO requirements (scholarship_id, name, required, max_file_size_mb) VALUES (?, ?, TRUE, 10)',
          [scholarshipId, reqName]
        );
      }
    }
  }

  // Delete scholarship
  static async delete(id) {
    const result = await execute(
      'DELETE FROM scholarship_programs WHERE id = ?',
      [id]
    );
    return { success: result.affectedRows > 0 };
  }

  // Count scholarships
  static async count(filters = {}) {
    const { status } = filters;
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (status) {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    const result = await query(
      `SELECT COUNT(*) as count FROM scholarship_programs ${whereClause}`,
      params
    );
    return result[0].count;
  }

  // Find open scholarships
  static async findOpen() {
    return this.findAll({ status: 'open' });
  }
}

module.exports = Scholarship;
