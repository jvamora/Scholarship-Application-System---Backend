const User = require('../models/userModel');
const pool = require('../config/db');
const { logAdminAction } = require('../utils/auditLogger');

// Notify the staff member who created an applicant about an admin decision. In
// the no-email design this staff member is the human who hands the applicant
// their credentials, so they need to know when the account's status changes so
// they can inform the applicant. Non-fatal: a notification failure must never
// roll back the admin action itself.
const notifyApplicantCreator = async (user, title, message, type = 'info') => {
  try {
    if (!user || user.role !== 'applicant' || !user.created_by) return;
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)',
      [user.created_by, title, message, type, 'user', user.id]
    );
  } catch (err) {
    console.error('Failed to notify staff:', err.message);
  }
};

const applicantDisplayName = (user) => `${user.first_name || ''} ${user.last_name || ''}`.trim() || (user.email || 'Applicant');

// List pending applicant accounts (admin only)
const listPendingUsers = async (req, res) => {
  try {
    const users = await User.findPending();
    res.json({ success: true, users });
  } catch (error) {
    console.error('Error fetching pending users:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// List all users (admin only)
const listAllUsers = async (req, res) => {
  try {
    const users = await User.findAll();
    res.json({ success: true, users });
  } catch (error) {
    console.error('Error fetching all users:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Approve user account (admin only)
const approveUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

        await User.setStatus(id, 'approved');
    await logAdminAction({ actorId: req.user.id, action: 'USER_APPROVED', entityType: 'user', entityId: id, details: {}, req });
    await notifyApplicantCreator(user, 'Applicant Approved', `${applicantDisplayName(user)} is approved and can now log in with their temporary password.`, 'success');
    res.json({ success: true, message: 'User account approved successfully' });
  } catch (error) {
    console.error('Error approving user:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Reject user account (admin only)
const rejectUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { remark } = req.body;
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

        await User.setStatusAndRemark(id, 'rejected', remark || null);
    await logAdminAction({ actorId: req.user.id, action: 'USER_REJECTED', entityType: 'user', entityId: id, details: { remark: remark || null }, req });
    await notifyApplicantCreator(user, 'Applicant Rejected', `${applicantDisplayName(user)} was rejected.${remark ? ` Reason: ${remark}.` : ''} You may correct the details and resubmit.`, 'error');
    res.json({ success: true, message: 'User account rejected successfully' });
  } catch (error) {
    console.error('Error rejecting user:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Suspend user account (admin only) — blocks login AND live sessions.
const suspendUser = async (req, res) => {
  try {
    const { id } = req.params;

    if (String(req.user.id) === String(id)) {
      return res.status(400).json({ success: false, error: 'You cannot suspend your own account' });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (user.status === 'suspended') {
      return res.status(400).json({ success: false, error: 'Account is already suspended' });
    }

        await User.setStatusAndRemark(id, 'suspended', user.remark || null);
    await logAdminAction({ actorId: req.user.id, action: 'ACCOUNT_SUSPENDED', entityType: 'user', entityId: id, details: {}, req });
    await notifyApplicantCreator(user, 'Applicant Suspended', `${applicantDisplayName(user)} has been suspended and can no longer log in.`, 'warning');
    res.json({ success: true, message: 'User account suspended successfully' });
  } catch (error) {
    console.error('Error suspending user:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Reactivate a suspended account (admin only).
const reactivateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (user.status !== 'suspended') {
      return res.status(400).json({ success: false, error: 'Account is not suspended' });
    }

    // Applicants return to the activated lifecycle state; every other role was
    // 'approved' before suspension.
    const restoredStatus = user.role === 'applicant' ? 'activated' : 'approved';
        await User.setStatusAndRemark(id, restoredStatus, user.remark || null);
    await logAdminAction({ actorId: req.user.id, action: 'ACCOUNT_REACTIVATED', entityType: 'user', entityId: id, details: { restoredStatus }, req });
    await notifyApplicantCreator(user, 'Applicant Reactivated', `${applicantDisplayName(user)} has been reactivated and can log in again.`, 'success');
    res.json({ success: true, message: 'User account reactivated successfully' });
  } catch (error) {
    console.error('Error reactivating user:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Reset user password (admin only)
const resetPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters long' });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Forced reset: is_first_login=1 so the temp password must be changed at
    // next login instead of silently becoming permanent.
        // Forced reset: is_first_login=1 so the temp password must be changed at
    // next login instead of silently becoming permanent.
        await User.resetPasswordForced(id, newPassword);
    // Revoke any outstanding sessions so the user must sign in with the temp
    // password (is_first_login=1) and cannot reuse their old token.
    await User.bumpTokenVersion(id);
    await logAdminAction({ actorId: req.user.id, action: 'PASSWORD_RESET', entityType: 'user', entityId: id, details: {}, req });
    res.json({ success: true, message: 'Password reset successfully. The user will be asked to change it at next login.' });
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Create a staff or committee account directly (admin only)
const createStaff = async (req, res) => {
  try {
    const { first_name, last_name, email, password, role = 'staff' } = req.body;

    if (!['staff', 'committee'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Role must be staff or committee' });
    }

    if (!first_name || !last_name || !email || !password) {
      return res.status(400).json({ success: false, error: 'All fields are required' });
    }

    if (String(password).length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }

    const existingUser = await User.findByEmail(email);
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Email already in use' });
    }

    const userId = await User.create({
      first_name,
      last_name,
      email,
      password,
      role,                    // 'staff' | 'committee'
      status: 'approved',
      createdBy: req.user.id
    });

        const account = await User.findById(userId);
    await logAdminAction({ actorId: req.user.id, action: 'STAFF_CREATED', entityType: 'user', entityId: userId, details: {}, req });
    res.status(201).json({ success: true, staff: account });
  } catch (error) {
    console.error('Error creating user account:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

const bulkApproveUsers = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) {
      return res.status(400).json({ success: false, error: 'No user IDs provided' });
    }
        await User.bulkUpdateStatus(ids, 'approved');
    for (const uid of ids) {
      await logAdminAction({ actorId: req.user.id, action: 'USERS_BULK_APPROVED', entityType: 'user', entityId: uid, details: {}, req });
    }
    // Notify each applicant's creating staff (only applicant rows have creators to notify).
    if (ids && ids.length) {
      const [rows] = await pool.query(
        'SELECT id, role, created_by, first_name, last_name, email FROM users WHERE id IN (?)',
        [ids]
      );
      for (const u of rows) {
        await notifyApplicantCreator(u, 'Applicant Approved', `${applicantDisplayName(u)} is approved and can now log in with their temporary password.`, 'success');
      }
    }
    res.json({ success: true, message: `${ids.length} accounts approved successfully` });
  } catch (error) {
    console.error('Error in bulk approval:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

const bulkRejectUsers = async (req, res) => {
  try {
    const { ids, remark } = req.body;
    if (!ids || !ids.length) {
      return res.status(400).json({ success: false, error: 'No user IDs provided' });
    }
        await User.bulkUpdateStatus(ids, 'rejected', remark || null);
    for (const uid of ids) {
      await logAdminAction({ actorId: req.user.id, action: 'USERS_BULK_REJECTED', entityType: 'user', entityId: uid, details: { remark: remark || null }, req });
    }
    // Notify each applicant's creating staff.
    if (ids && ids.length) {
      const [rows] = await pool.query(
        'SELECT id, role, created_by, first_name, last_name, email FROM users WHERE id IN (?)',
        [ids]
      );
      for (const u of rows) {
        await notifyApplicantCreator(u, 'Applicant Rejected', `${applicantDisplayName(u)} was rejected.${remark ? ` Reason: ${remark}.` : ''} You may correct the details and resubmit.`, 'error');
      }
    }
    res.json({ success: true, message: `${ids.length} accounts rejected successfully` });
  } catch (error) {
    console.error('Error in bulk rejection:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

const listNotifications = async (req, res) => {
  try {
    const adminId = req.user.id;
    const pool = require('../config/db');
    const [rows] = await pool.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [adminId]
    );
    res.json({ success: true, notifications: rows });
  } catch (error) {
    console.error('Error listing notifications:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

const markNotificationRead = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;
    const pool = require('../config/db');
    await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
      [id, adminId]
    );
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (error) {
    console.error('Error marking notification read:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Retrieve audit trail entries for admin review.
const listAuditLogs = async (req, res) => {
  try {
    const { entityType, entityId, actorId, action, search, limit = 100 } = req.query;
    const args = [];
    let sql = `
      SELECT a.id, a.user_id AS actor_id, a.action, a.entity_type, a.entity_id,
             a.details, a.ip_address, a.user_agent, a.created_at,
             u.first_name AS actor_first_name, u.last_name AS actor_last_name, u.email AS actor_email
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE 1=1
    `;
    if (action) {
      sql += ' AND a.action = ?';
      args.push(action);
    }
    if (entityType) {
      sql += ' AND a.entity_type = ?';
      args.push(entityType);
    }
    if (entityId) {
      sql += ' AND a.entity_id = ?';
      args.push(Number(entityId));
    }
    if (actorId) {
      sql += ' AND a.user_id = ?';
      args.push(Number(actorId));
    }
    if (search) {
      sql += ' AND (a.action ILIKE ? OR u.first_name ILIKE ? OR u.last_name ILIKE ? OR u.email ILIKE ?)';
      const term = `%${search}%`;
      args.push(term, term, term, term);
    }
    sql += ' ORDER BY a.created_at DESC LIMIT ?';
    args.push(Number(limit) > 0 ? Number(limit) : 100);

    const pool = require('../config/db');
    const [rows] = await pool.query(sql, args);
    res.json({ success: true, logs: rows || [] });
  } catch (error) {
    console.error('Error listing audit logs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Fetch a single user by id (admin only). Exposes the full profile
// (incl. phone/address/middle_name) for the user-detail/edit modal.
const getUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Edit a user's profile (admin only). Role and is_active are intentionally
// excluded here — role changes live in updateUserRole, account status in
// suspend/reactivate, so there is a single audited path per concern.
const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const allowed = ['first_name', 'middle_name', 'last_name', 'email', 'phone', 'address'];
    const fields = {};
    for (const f of allowed) {
      if (req.body[f] !== undefined) fields[f] = req.body[f];
    }
    if (!fields.first_name || !fields.last_name) {
      return res.status(400).json({ success: false, error: 'First name and last name are required' });
    }
    await User.update(id, fields);
    const updated = await User.findById(id);
    await logAdminAction({ actorId: req.user.id, action: 'USER_UPDATED', entityType: 'user', entityId: id, details: { fields: Object.keys(fields) }, req });
    res.json({ success: true, user: updated });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Change a user's role (admin only). Admin accounts cannot be assigned here
// (admin is provisioned via bootstrap-admin only) to prevent escalation.
const assignableRoles = ['staff', 'committee'];
const updateUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    if (!assignableRoles.includes(role)) {
      return res.status(400).json({ success: false, error: 'Role must be staff or committee' });
    }
    if (String(req.user.id) === String(id)) {
      return res.status(400).json({ success: false, error: 'You cannot change your own role' });
    }
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    await User.updateRole(id, role);
    const updated = await User.findById(id);
    await logAdminAction({ actorId: req.user.id, action: 'USER_ROLE_CHANGED', entityType: 'user', entityId: id, details: { from: user.role, to: role }, req });
    res.json({ success: true, user: updated });
  } catch (error) {
    console.error('Error updating role:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Soft-delete a user (admin only): revokes sessions and marks the account
// deleted_at. The row is retained for audit/history integrity.
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    if (String(req.user.id) === String(id)) {
      return res.status(400).json({ success: false, error: 'You cannot delete your own account' });
    }
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    await User.bumpTokenVersion(id);     // revoke outstanding sessions
    await User.softDelete(id);           // set deleted_at (excludes from login/lists)
    await logAdminAction({ actorId: req.user.id, action: 'USER_DELETED', entityType: 'user', entityId: id, details: { role: user.role }, req });
    res.json({ success: true, message: 'User account deleted' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  listPendingUsers,
  listAllUsers,
  approveUser,
  rejectUser,
  resetPassword,
  createStaff,
  bulkApproveUsers,
  bulkRejectUsers,
  listNotifications,
  markNotificationRead,
  listAuditLogs,
  suspendUser,
  reactivateUser,
  getUser,
  updateUser,
  updateUserRole,
  deleteUser,
};

