const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const auth = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Immediate-lockout enforcement: a cheap primary-key lookup so accounts
    // suspended by an administrator lose access instantly (not just at token
    // expiry). Deliberately scoped to 'suspended' ONLY — other statuses are
    // handled by their own flows (login gating / first-login activation), so
    // this middleware can never lock out legacy or pending-state edge cases.
        const [rows] = await pool.query(
      'SELECT status, token_version FROM users WHERE id = ? AND deleted_at IS NULL',
      [decoded.id]
    );
    if (rows.length === 0) {
            return res.status(401).json({ error: 'Account no longer exists or access has been revoked' });
    }
    if (rows[0].status === 'suspended') {
      return res.status(403).json({ error: 'Your account has been suspended. Please contact an administrator.' });
    }

        // Revoke tokens issued before a logout / password-reset (tv mismatch).
    // Skipped for legacy tokens that predate the tv claim (backward compat).
    if ('tv' in decoded && Number(decoded.tv) !== Number(rows[0].token_version)) {
      return res.status(401).json({ error: 'Session revoked. Please log in again.' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const role = (roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

module.exports = { auth, role, authenticate: auth, authorize: role };
