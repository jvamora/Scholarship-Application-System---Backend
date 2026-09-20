const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authLimiter = require('../utils/rateLimiter');
const { auth } = require('../middleware/auth');

router.post('/register', authLimiter, authController.register);
router.post('/login', authLimiter, authController.login);
router.get('/me', auth, authController.me);
router.post('/logout', auth, authController.logout);
router.put('/profile', auth, authController.updateProfile);
router.post('/change-password', auth, authController.changePassword);
router.post('/activate', auth, authController.activateApplicantAccount);

module.exports = router;

