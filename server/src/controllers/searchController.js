const { searchScholarshipSchema, searchApplicationSchema, searchPreferencesSchema } = require('../validators/searchValidator');
const Scholarship = require('../models/Scholarship');
const Application = require('../models/Application');
const { query } = require('../config/database');
const { resolveOptionalAuth } = require('../utils/optionalAuth');

// Search scholarships with filters
const searchScholarships = async (req, res) => {
  try {
    const filters = searchScholarshipSchema.parse(req.query);
    const authInfo = resolveOptionalAuth(req);
    // Draft programs are internal only — non-admins never see them in search.
    if (authInfo?.role !== 'admin') {
      filters.excludeDraft = true;
    }

    const scholarships = await Scholarship.findAll(filters);
    const count = await Scholarship.count(filters);

    res.json({
      success: true,
      data: scholarships,
      count,
      limit: filters.limit,
      offset: filters.offset,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.errors?.[0]?.message || 'Invalid search parameters',
    });
  }
};

// Get available search filters
const getSearchFilters = async (req, res) => {
  try {
    // Get min/max amounts from the real scholarship table
    const amountStats = await query(
      'SELECT MIN(amount) as min, MAX(amount) as max FROM scholarship_programs'
    );

    // Get available statuses
    const statuses = await query(
      'SELECT DISTINCT status FROM scholarship_programs ORDER BY status'
    );

    res.json({
      success: true,
      data: {
        amountRange: {
          min: amountStats[0]?.min || 0,
          max: amountStats[0]?.max || 10000,
        },
        statuses: statuses.map(s => s.status),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch search filters',
    });
  }
};

// Save search preferences
const saveSearchPreferences = async (req, res) => {
  try {
    const preferences = searchPreferencesSchema.parse(req.body);
    
    // In a real app, save to database
    // For now, return success
    res.json({
      success: true,
      data: preferences,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.errors?.[0]?.message || 'Invalid preferences',
    });
  }
};

// Get saved search preferences
const getSearchPreferences = async (req, res) => {
  try {
    // In a real app, fetch from database
    // For now, return empty array
    res.json({
      success: true,
      data: [],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch preferences',
    });
  }
};

// Search applications (for committee)
const searchApplications = async (req, res) => {
  try {
    const filters = searchApplicationSchema.parse(req.query);
    
    const applications = await Application.findAll(filters);
    const count = await Application.count(filters);
    
    res.json({
      success: true,
      data: applications,
      count,
      limit: filters.limit,
      offset: filters.offset,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.errors?.[0]?.message || 'Invalid search parameters',
    });
  }
};

module.exports = {
  searchScholarships,
  getSearchFilters,
  saveSearchPreferences,
  getSearchPreferences,
  searchApplications,
};
