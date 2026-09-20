const express = require('express');
const router = express.Router();
const {
  getScholarshipStats,
  getApplicationStats,
  getUserStats,
  exportScholarships,
  exportApplications,
  getApplicationTimeline,
  getStatusDistribution,
} = require('../controllers/reportController');
const { authenticate, authorize } = require('../middleware/auth');

// Get scholarship statistics (admin only)
router.get('/scholarships', 
  authenticate, 
  authorize(['admin']), 
  getScholarshipStats
);

// Get application statistics (admin only)
router.get('/applications', 
  authenticate, 
  authorize(['admin']), 
  getApplicationStats
);

// Get user statistics (admin only)
router.get('/users', 
  authenticate, 
  authorize(['admin']), 
  getUserStats
);

// Export scholarships to CSV (admin only)
router.get('/export/scholarships', 
  authenticate, 
  authorize(['admin']), 
  exportScholarships
);

// Export applications to CSV (admin only)
router.get('/export/applications', 
  authenticate, 
  authorize(['admin']), 
  exportApplications
);

// Get application timeline (admin only)
router.get('/timeline', 
  authenticate, 
  authorize(['admin']), 
  getApplicationTimeline
);

// Get status distribution (admin only)
router.get('/status-distribution', 
  authenticate, 
  authorize(['admin']), 
  getStatusDistribution
);

module.exports = router;