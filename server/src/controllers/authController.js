const User = require('../models/userModel');

const { generateToken, verifyToken } = require('../utils/jwt');
const { registerSchema, loginSchema } = require('../validators/authValidator');

const register = async (req, res) => {
  try {
    const data = registerSchema.parse(req.body);

    // Defense-in-depth: the zod schema already restricts roles to staff, but re-check here so nothing can ever mint an elevated account through public registration. Runs BEFORE any DB access.
    if (data.role !== 'staff') {
      return res.status(403).json({ error: 'Self-registration is limited to staff accounts. Applicant accounts are created by staff, and admin/committee accounts are provisioned internally by an administrator.' });
    }

    const existingUser = await User.findByEmail(data.email);
    if (existingUser) {
      return res.status(400).json({ error: 'Email already in use' });
    }

    const userId = await User.create(data);
    const user = await User.findById(userId);

        const token = generateToken(user.id, user.role, user.token_version);

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        middle_name: user.middle_name,
        last_name: user.last_name,
        name_suffix: user.name_suffix,
        student_number: user.student_number,
        role: user.role,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const login = async (req, res) => {
  try {
    const data = loginSchema.parse(req.body);

    const user = await User.findByEmail(data.email);
    if (!user) {
      return res.status(404).json({ error: 'Account not found. Please contact staff.' });
    }

    const isMatch = await User.comparePassword(data.password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    if (user.status === 'pending') {
      return res.status(403).json({ error: '⚠️ You cannot login now because your account is pending for approval. Please wait for admin approval.' });
    }

    if (user.status === 'rejected') {
      return res.status(403).json({ error: '❌ Your account has been rejected. Please contact support.' });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ error: '⛔ Your account has been suspended. Please contact an administrator.' });
    }

        const token = generateToken(user.id, user.role, user.token_version);
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        middle_name: user.middle_name,
        last_name: user.last_name,
        name_suffix: user.name_suffix,
        student_number: user.student_number,
        role: user.role,
        status: user.status,
        is_first_login: user.is_first_login,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const me = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Logout is now real: bump the user's token_version so the outstanding JWT
// (which carries the old `tv`) is rejected by auth.js on the next request.
const logout = async (req, res) => {
  try {
    if (req.user?.id) {
      await User.bumpTokenVersion(req.user.id);
    }
  } catch (e) {
    console.error('Error during logout revocation:', e);
  }
  res.json({ message: 'Logout successful' });
};

const updateProfile = async (req, res) => {
  try {
    const { first_name, last_name, middle_name, name_suffix, student_number, phone, address } = req.body;
    if (!first_name || !last_name) {
      return res.status(400).json({ error: 'First name and last name are required.' });
    }
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    await User.updateProfile(userId, { first_name, last_name, middle_name, name_suffix, student_number, phone, address });
    const updated = await User.findById(userId);
    res.json({ success: true, user: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Both current and new password are required.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    // Fetch full user (including hashed password) by querying directly
    const [rows] = await require('../config/db').query('SELECT * FROM users WHERE id = ?', [userId]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const isMatch = await User.comparePassword(currentPassword, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Current password is incorrect.' });
    await User.updatePassword(userId, newPassword);
    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const activateApplicantAccount = async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // First-login password change now serves BOTH the applicant activation
    // lifecycle AND admin-issued forced password resets for any role.
    if (user.role === 'applicant') {
      await User.activate(userId, password); // sets status='activated', clears flag, stamps activated_at
    } else {
      // Non-applicants keep their current status; just set the new password
      // and clear the forced-change flag.
      const hashedPassword = await require('bcryptjs').hash(password, 10);
      await require('../config/db').query(
        'UPDATE users SET password = ?, is_first_login = 0 WHERE id = ?',
        [hashedPassword, userId]
      );
    }

    // Activity log
    const pool = require('../config/db');
    const fullName = `${user.first_name} ${user.last_name}`;
    await pool.query(
      'INSERT INTO activity_logs (user_id, action, description) VALUES (?, ?, ?)',
      [userId, 'ACCOUNT_ACTIVATION', `Applicant ${fullName} activated their account`]
    );

    // Notify Admins
    const [admins] = await pool.query("SELECT id FROM users WHERE role = 'admin'");
    for (const admin of admins) {
      await pool.query(
        "INSERT INTO notifications (user_id, title, message, type, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)",
        [admin.id, 'Account Activated', `Applicant ${fullName} has activated their account.`, 'success', 'user', userId]
      );
    }

    // Notify the staff member who created this applicant (if any) — they are the
    // human who shared the temp password, so they should know the applicant has
    // activated and can now use the portal.
    if (user.created_by) {
      await pool.query(
        "INSERT INTO notifications (user_id, title, message, type, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)",
        [user.created_by, 'Applicant Activated', `Applicant ${fullName} has activated their account and can sign in.`, 'success', 'user', userId]
      );
    }

    res.json({ success: true, message: 'Your password has been changed and your account is now activated!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = { register, login, me, logout, updateProfile, changePassword, activateApplicantAccount };

