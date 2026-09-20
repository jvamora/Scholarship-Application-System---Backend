const express = require('express');
const router = express.Router();
const {
  searchScholarships,
  getSearchFilters,
  saveSearchPreferences,
  getSearchPreferences,
  searchApplications,
} = require('../controllers/searchController');
const { authenticate, authorize } = require('../middleware/auth');

// Search scholarships
router.get('/scholarships/search', searchScholarships);

// Get search filters
router.get('/scholarships/filters', getSearchFilters);

// Save search preferences (authenticated)
router.post('/search/preferences', authenticate, saveSearchPreferences);

// Get search preferences (authenticated)
router.get('/search/preferences', authenticate, getSearchPreferences);

// Search applications (committee only)
router.get('/applications/search',
  authenticate,
  authorize(['admin', 'committee']),
  searchApplications
);

module.exports = router;