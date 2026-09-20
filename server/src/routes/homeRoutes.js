const express = require('express');
const router = express.Router();
const { getHomeStats } = require('../controllers/homeStatsController');

// Public hero statistics for the landing page.
router.get('/stats', getHomeStats);

module.exports = router;