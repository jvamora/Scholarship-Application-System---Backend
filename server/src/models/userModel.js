const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

class User {
  static async create(userData) {
    const { email, password, role, first_name, last_name, middle_name, name_suffix, student_number, phone, address, status, remark, createdBy, is_first_login } = userData;
    const uuid = uuidv4();
    // Hash password if provided
    const hashedPassword = password
      ? await bcrypt.hash(password, 10)
      : await bcrypt.hash(uuidv4(), 10); // random placeholder

    const isFirstLoginVal = is_first_login !== undefined ? is_first_login : (role === 'applicant' ? 1 : 0);

    const [result] = await pool.query(
      'INSERT INTO users (uuid, email, password, role, first_name, middle_name, last_name, name_suffix, student_number, phone, address, status, remark, created_by, is_first_login, activated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      [
        uuid, email, hashedPassword,
        role || 'applicant',
        first_name, middle_name || null, last_name,
        name_suffix || null, student_number || null,
        phone || null, address || null,
        status || 'pending', remark || null,
        createdBy || null,
        isFirstLoginVal
      ]
    );
    return result.insertId;
  }

  static async findByEmail(email) {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL', [email]);
    return rows[0];
  }

  static async findById(id) {
    const [rows] = await pool.query(
      'SELECT id, uuid, email, role, first_name, middle_name, last_name, name_suffix, student_number, phone, address, avatar_url, is_active, status, remark, created_by, is_first_login, activated_at FROM users WHERE id = ? AND deleted_at IS NULL',
      [id]
    );
    return rows[0];
  }

  static async comparePassword(candidatePassword, hashedPassword) {
    return await bcrypt.compare(candidatePassword, hashedPassword);
  }

  static async setStatus(id, status) {
    await pool.query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
  }

  static async setStatusAndRemark(id, status, remark) {
    await pool.query('UPDATE users SET status = ?, remark = ? WHERE id = ?', [status, remark, id]);
  }

  static async setRemark(id, remark) {
    await pool.query('UPDATE users SET remark = ? WHERE id = ?', [remark, id]);
  }

      static async update(id, fields) {
    const { first_name, middle_name, last_name, name_suffix, student_number, email, phone, address, password } = fields;
    // Partial update: only SET the columns the caller actually provided, so a
    // sparse body (e.g. admin profile edit with just first_name/last_name) can't
    // clobber NOT-NULL columns like `email` with NULL. Same behavior as before for
    // full-object callers (staff updateApplicant), which all pass every field.
    const sets = [];
    const params = [];
    if (first_name !== undefined) { sets.push('first_name = ?'); params.push(first_name); }
    if (last_name !== undefined)  { sets.push('last_name = ?');  params.push(last_name); }
    if (middle_name !== undefined) { sets.push('middle_name = ?'); params.push(middle_name || null); }
    if (name_suffix !== undefined) { sets.push('name_suffix = ?'); params.push(name_suffix || null); }
    if (student_number !== undefined) { sets.push('student_number = ?'); params.push(student_number || null); }
    if (email !== undefined)      { sets.push('email = ?');        params.push(email); }
    if (phone !== undefined)      { sets.push('phone = ?');        params.push(phone || null); }
    if (address !== undefined)    { sets.push('address = ?');      params.push(address || null); }
    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      sets.push('password = ?'); params.push(hashedPassword);
    }
    if (sets.length === 0) return; // nothing to update
    const query = 'UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?';
    params.push(id);
    await pool.query(query, params);
  }

  static async delete(id) {
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }

  static async updateRole(id, role) {
    await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  }

  // Soft-delete: mark the account deleted without removing the row, so
  // audit logs, applications and foreign keys remain intact.
  static async softDelete(id) {
    await pool.query("UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
  }

  // JWT revocation: bump token_version so any token whose embedded `tv`
  // is now stale is rejected by auth.js on the next request.
  static async bumpTokenVersion(id) {
    await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [id]);
  }

  static async getTokenVersion(id) {
    const [rows] = await pool.query('SELECT token_version FROM users WHERE id = ?', [id]);
    return rows[0]?.token_version ?? 0;
  }

  static async findByStaff(staffId) {
    const [rows] = await pool.query(
      'SELECT id, uuid, email, role, first_name, middle_name, last_name, name_suffix, student_number, status, remark, created_by, created_at FROM users WHERE created_by = ? AND deleted_at IS NULL ORDER BY created_at DESC',
      [staffId]
    );
    return rows;
  }

  static async findPending() {
    const [rows] = await pool.query(
      "SELECT id, uuid, email, role, first_name, middle_name, last_name, name_suffix, student_number, status, remark, created_by, created_at FROM users WHERE status = 'pending' AND deleted_at IS NULL ORDER BY created_at DESC"
    );
    return rows;
  }

  static async findAll() {
    const [rows] = await pool.query(
      'SELECT id, uuid, email, role, first_name, middle_name, last_name, name_suffix, student_number, status, remark, created_by, created_at FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC'
    );
    return rows;
  }

  static async updatePassword(id, password) {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, id]);
  }

  // Admin-issued password reset: forces the user through the first-login
  // password-change flow on next sign-in (temp password is NOT permanent).
  static async resetPasswordForced(id, password) {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password = ?, is_first_login = 1 WHERE id = ?', [
      hashedPassword,
      id,
    ]);
  }


  static async updateProfile(id, fields) {
    const { first_name, last_name, middle_name, name_suffix, student_number, phone, address } = fields;
    let sql = 'UPDATE users SET first_name = ?, last_name = ?';
    const params = [first_name, last_name];
    if (middle_name !== undefined)   { sql += ', middle_name = ?';    params.push(middle_name || null); }
    if (name_suffix !== undefined)   { sql += ', name_suffix = ?';    params.push(name_suffix || null); }
    if (student_number !== undefined){ sql += ', student_number = ?'; params.push(student_number || null); }
    if (phone       !== undefined) { sql += ', phone = ?';       params.push(phone || null); }
    if (address     !== undefined) { sql += ', address = ?';     params.push(address || null); }
    sql += ' WHERE id = ?';
    params.push(id);
    await pool.query(sql, params);
  }

  static async activate(id, newPassword) {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query(
      "UPDATE users SET password = ?, is_first_login = 0, status = 'activated', activated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [hashedPassword, id]
    );
  }

  static async bulkUpdateStatus(ids, status, remark = null) {
    if (!ids || !ids.length) return;
    await pool.query(
      'UPDATE users SET status = ?, remark = ? WHERE id IN (?)',
      [status, remark, ids]
    );
  }

  static async count() {
    const [rows] = await pool.query('SELECT COUNT(*) as count FROM users');
    return rows[0].count;
  }
}

module.exports = User;
