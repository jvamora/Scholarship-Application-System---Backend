const jwt = require('jsonwebtoken');

// Public routes may receive an optional Authorization header (e.g. a logged-in
// applicant browsing scholarships). This resolves the token if present and valid,
// returning the decoded payload ({ id, role }), or null otherwise — without
// failing the request the way the `authenticate` middleware would.
const resolveOptionalAuth = (req) => {
  const header = req.header('Authorization') || '';
  const token = header.replace('Bearer ', '');
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
};

module.exports = { resolveOptionalAuth };