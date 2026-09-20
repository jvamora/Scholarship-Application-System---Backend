const jwt = require('jsonwebtoken');

const generateToken = (userId, role, tokenVersion = 0) => {
  return jwt.sign(
    { id: userId, role, tv: tokenVersion },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

const verifyToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET);
};

module.exports = { generateToken, verifyToken };
