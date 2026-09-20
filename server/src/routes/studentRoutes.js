const express = require('express');
const router = express.Router();
const {
  getMyStudent,
  updateMyStudent,
  listCourses,
} = require('../controllers/studentController');
const { authenticate, authorize } = require('../middleware/auth');

// Applicant's own student record (auto-provisioned if missing)
router.get('/me', authenticate, authorize(['applicant']), getMyStudent);
router.put('/me', authenticate, authorize(['applicant']), updateMyStudent);

// Courses + colleges for the applicant profile form
router.get('/courses', authenticate, listCourses);

module.exports = router;