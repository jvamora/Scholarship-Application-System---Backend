const User = require('../models/userModel');
const pool = require('../config/db');
const { logAdminAction } = require('../utils/auditLogger');

function generateTempPassword(length = 8) {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const symbols = '!@#$%&*';
  const allChars = upper + lower + numbers + symbols;

  let password = '';
  password += upper[Math.floor(Math.random() * upper.length)];
  password += lower[Math.floor(Math.random() * lower.length)];
  password += numbers[Math.floor(Math.random() * numbers.length)];
  password += symbols[Math.floor(Math.random() * symbols.length)];

  for (let i = 4; i < length; i++) {
    password += allChars[Math.floor(Math.random() * allChars.length)];
  }

  return password.split('').sort(() => 0.5 - Math.random()).join('');
}

// Create a new applicant (staff only)
const createApplicant = async (req, res) => {
  try {
    const staffId = req.user.id;
    let { first_name, middle_name, last_name, name_suffix, student_number, phone, email, address, password } = req.body;

    if (!middle_name || !String(middle_name).trim()) {
      return res.status(400).json({ error: 'Middle name is required.' });
    }
    if (!student_number || !String(student_number).trim()) {
      return res.status(400).json({ error: 'Student ID is required.' });
    }

    let isManual = true;
    if (!password) {
      password = generateTempPassword(8);
      isManual = false;
    }

    const existingUser = await User.findByEmail(email);
    if (existingUser) {
      return res.status(400).json({ error: 'Email already in use by another account.' });
    }

    const userId = await User.create({
      email,
      password,
      role: 'applicant',
      first_name,
      middle_name: middle_name || null,
      last_name,
      name_suffix: name_suffix || null,
      student_number,
      phone: phone || null,
      address: address || null,
      status: 'pending',
      remark: null,
      createdBy: staffId,
      is_first_login: 1,
    });
    const applicant = await User.findById(userId);
    res.status(201).json({ applicant, tempPassword: password, isManual });
  } catch (error) {
    console.error('Error creating applicant:', error);
    res.status(400).json({ error: error.message });
  }
};

// List applicants created by the logged-in staff
const listMyApplicants = async (req, res) => {
  try {
    const staffId = req.user.id;
    const applicants = await User.findByStaff(staffId);
    res.json({ applicants });
  } catch (error) {
    console.error('Error fetching staff applicants:', error);
    res.status(400).json({ error: error.message });
  }
};

// Update an applicant (staff only, if still pending)
const updateApplicant = async (req, res) => {
  try {
    const staffId = req.user.id;
    const { id } = req.params;
    const { first_name, middle_name, last_name, name_suffix, student_number, phone, email, address, password } = req.body;

    if (!middle_name || !String(middle_name).trim()) {
      return res.status(400).json({ error: 'Middle name is required.' });
    }

    const applicant = await User.findById(id);
    if (!applicant) {
      return res.status(404).json({ error: 'Applicant not found' });
    }

    if (Number(applicant.created_by) !== Number(staffId)) {
      return res.status(403).json({ error: 'Forbidden: You did not create this applicant account' });
    }

    if (applicant.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending applicant accounts can be edited' });
    }

    await User.update(id, { first_name, middle_name, last_name, name_suffix, student_number, phone, email, address, password });
    const updatedApplicant = await User.findById(id);
    res.json({ applicant: updatedApplicant });
  } catch (error) {
    console.error('Error updating applicant:', error);
    res.status(400).json({ error: error.message });
  }
};

// Regenerate a temporary password for an applicant the staff created — but ONLY
// while they have not yet activated. In the no-email design the temp password is
// shown exactly once at creation and there is no way to retrieve it, so staff
// must be able to mint a fresh one if it is lost before the applicant logs in.
const resetApplicantPassword = async (req, res) => {
  try {
    const staffId = req.user.id;
    const { id } = req.params;

    const applicant = await User.findById(id);
    if (!applicant) {
      return res.status(404).json({ error: 'Applicant not found' });
    }
    if (applicant.role !== 'applicant') {
      return res.status(400).json({ error: 'Not an applicant account' });
    }
    if (Number(applicant.created_by) !== Number(staffId)) {
      return res.status(403).json({ error: 'Forbidden: You did not create this applicant account' });
    }
    if (!['pending', 'approved'].includes(applicant.status)) {
      return res.status(400).json({ error: 'Only applicants who have not yet activated can have their password reset by staff. Activated applicants should use the Change Password flow.' });
    }

    const tempPassword = generateTempPassword(8);
    await User.resetPasswordForced(id, tempPassword); // is_first_login=1 so it must be changed at next login
    await User.bumpTokenVersion(id); // revoke any outstanding session so they must sign in fresh

    await logAdminAction({ actorId: staffId, action: 'STAFF_APPLICANT_PASSWORD_RESET', entityType: 'user', entityId: id, details: {}, req });
    res.json({ applicant: await User.findById(id), tempPassword });
  } catch (error) {
    console.error('Error resetting applicant password:', error);
    res.status(400).json({ error: error.message });
  }
};

// Delete (soft-delete) an applicant the staff created — but only while still
// pending — so a duplicate or mistaken registration can be removed before the
// admin gets involved. Non-admin staff cannot ever hard-delete accounts.
const deleteApplicant = async (req, res) => {
  try {
    const staffId = req.user.id;
    const { id } = req.params;

    const applicant = await User.findById(id);
    if (!applicant) {
      return res.status(404).json({ error: 'Applicant not found' });
    }
    if (applicant.role !== 'applicant') {
      return res.status(400).json({ error: 'Not an applicant account' });
    }
    if (Number(applicant.created_by) !== Number(staffId)) {
      return res.status(403).json({ error: 'Forbidden: You did not create this applicant account' });
    }
    if (applicant.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending applicant accounts can be deleted' });
    }

    await User.bumpTokenVersion(id); // revoke any outstanding session
    await User.softDelete(id);       // mark deleted; row retained for audit/activity integrity

    await logAdminAction({ actorId: staffId, action: 'STAFF_APPLICANT_DELETED', entityType: 'user', entityId: id, details: {}, req });
    res.json({ success: true, message: 'Applicant account deleted' });
  } catch (error) {
    console.error('Error deleting applicant:', error);
    res.status(400).json({ error: error.message });
  }
};

// List this staff member's notifications (newest first). These are emitted when
// an admin approves/rejects/suspends/reactivates one of their applicants or when
// an applicant activates — so the staff member knows to hand over credentials.
const listNotifications = async (req, res) => {
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
};

// Mark one of this staff member's notifications as read.
const markNotificationRead = async (req, res) => {
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
};

// Read-only view for staff: scholarship applications submitted by applicants this
// staff member created. Lets the on-boarding registrar see whether their
// applicants actually applied, and to which program, and the current decision.
const listMyApplicantsApplications = async (req, res) => {
  try {
    const staffId = req.user.id;
    const [rows] = await pool.query(
      `SELECT
         a.id,
         a.application_number,
         a.status AS app_status,
         a.submitted_at,
         u.id AS applicant_id,
         u.first_name,
         u.last_name,
         u.email,
         s.id AS scholarship_id,
         s.name AS scholarship_name,
         s.amount,
         s.status AS scholarship_status
       FROM applications a
       JOIN students st   ON st.id = a.student_id
       JOIN users u       ON u.id = st.user_id
       JOIN scholarship_programs s ON s.id = a.scholarship_id
       WHERE u.created_by = ? AND u.deleted_at IS NULL
       ORDER BY a.created_at DESC
       LIMIT 200`,
      [staffId]
    );
    res.json({ success: true, applications: rows });
  } catch (error) {
    console.error('Error fetching staff applicants applications:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  createApplicant,
  listMyApplicants,
  updateApplicant,
  resetApplicantPassword,
  deleteApplicant,
  listNotifications,
  markNotificationRead,
  listMyApplicantsApplications,
};
