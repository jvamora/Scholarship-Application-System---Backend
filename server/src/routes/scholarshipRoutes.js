const express = require('express');
const router = express.Router();
const {
  createScholarship,
  getAllScholarships,
  getScholarship,
  updateScholarship,
  deleteScholarship,
} = require('../controllers/scholarshipController');
const { authenticate, authorize } = require('../middleware/auth');

// Create a new scholarship (admin only)
router.post('/', authenticate, authorize(['admin']), createScholarship);

// Get all scholarships
router.get('/', getAllScholarships);

// Get a single scholarship
router.get('/:id', getScholarship);

// Update a scholarship (admin only)
router.put('/:id', authenticate, authorize(['admin']), updateScholarship);

// Delete a scholarship (admin only)
router.delete('/:id', authenticate, authorize(['admin']), deleteScholarship);

module.exports = router;
