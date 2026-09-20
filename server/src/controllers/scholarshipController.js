const { scholarshipSchema, updateScholarshipSchema } = require('../validators/scholarshipValidator');
const Scholarship = require('../models/scholarshipModel');
const { resolveOptionalAuth } = require('../utils/optionalAuth');
const { query } = require('../config/database');

// Returns a Map of scholarship_id -> application_id for the applications an
// applicant currently owns. An *active* application (submitted/under_review/
// etc.) is preferred so the program list/detail navigate to the in-flight app.
// When the applicant has no active application but does have a rejected or
// withdrawn one, that stale application is returned instead — so the applicant
// is routed to their Resubmit affordance on the application detail page rather
// than being offered a brand-new (duplicate) application via "Apply now".
const getAppliedMap = async (userId, scholarshipIds) => {
  if (!userId || !Array.isArray(scholarshipIds) || scholarshipIds.length === 0) {
    return new Map();
  }
  const rows = await query(
    `SELECT a.scholarship_id, a.id AS application_id, a.status
       FROM applications a
       JOIN students st ON st.id = a.student_id
      WHERE st.user_id = ?
        AND a.scholarship_id IN (?)
      ORDER BY a.created_at DESC`,
    [userId, scholarshipIds]
  );

  const resolved = new Map(); // scholarship_id -> { id, isActive }
  for (const r of rows || []) {
    const key = Number(r.scholarship_id);
    const isActive = !['rejected', 'withdrawn'].includes(r.status);
    const current = resolved.get(key);
    if (!current) {
      resolved.set(key, { id: r.application_id, isActive });
    } else if (isActive && !current.isActive) {
      // Promote an in-flight application over a stale rejected/withdrawn one.
      resolved.set(key, { id: r.application_id, isActive });
    }
  }

  const out = new Map();
  for (const [key, v] of resolved) out.set(key, v.id);
  return out;
};

// Create a new scholarship
const createScholarship = async (req, res) => {
  try {
    const validatedData = scholarshipSchema.parse(req.body);
    const scholarship = await Scholarship.create({
      ...validatedData,
      createdBy: req.user.id,
    });
    
    res.status(201).json({
      success: true,
      data: scholarship,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.issues?.[0]?.message || error.errors?.[0]?.message || 'Failed to create scholarship',
    });
  }
};

// Get all scholarships
const getAllScholarships = async (req, res) => {
  try {
    const authInfo = resolveOptionalAuth(req);
    const isAdmin = authInfo?.role === 'admin';

    // Draft programs are internal only — everyone except admins sees live
    // programs (open / closed / completed) but never drafts.
    const scholarships = isAdmin
      ? await Scholarship.findAll()
      : await Scholarship.findAll({ excludeDraft: true });

    if (authInfo?.id) {
      const appliedMap = await getAppliedMap(
        authInfo.id,
        scholarships.map((s) => s.id)
      );
      return res.json({
        success: true,
        data: scholarships.map((s) => ({
          ...s,
          has_applied: appliedMap.has(Number(s.id)),
          application_id: appliedMap.get(Number(s.id)) || null,
        })),
      });
    }

    res.json({
      success: true,
      data: scholarships,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch scholarships',
    });
  }
};

// Get a single scholarship
const getScholarship = async (req, res) => {
  try {
    const scholarship = await Scholarship.findById(req.params.id);
    if (!scholarship) {
      return res.status(404).json({
        success: false,
        message: 'Scholarship not found',
      });
    }

    const authInfo = resolveOptionalAuth(req);
    const isAdmin = authInfo?.role === 'admin';

    // Draft programs are not public-facing.
    if (!isAdmin && scholarship.status === 'draft') {
      return res.status(404).json({
        success: false,
        message: 'Scholarship not found',
      });
    }

    if (authInfo?.id) {
      const appliedMap = await getAppliedMap(authInfo.id, [scholarship.id]);
      return res.json({
        success: true,
        data: {
          ...scholarship,
          has_applied: appliedMap.has(Number(scholarship.id)),
          application_id: appliedMap.get(Number(scholarship.id)) || null,
        },
      });
    }

    res.json({
      success: true,
      data: scholarship,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch scholarship',
    });
  }
};

// Update a scholarship
const updateScholarship = async (req, res) => {
  try {
    const validatedData = updateScholarshipSchema.parse(req.body);
    const scholarship = await Scholarship.update(req.params.id, validatedData);
    
    if (!scholarship) {
      return res.status(404).json({
        success: false,
        message: 'Scholarship not found',
      });
    }
    
    res.json({
      success: true,
      data: scholarship,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.issues?.[0]?.message || error.errors?.[0]?.message || 'Failed to update scholarship',
    });
  }
};

// Delete a scholarship
const deleteScholarship = async (req, res) => {
  try {
    const result = await Scholarship.delete(req.params.id);
    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: 'Scholarship not found',
      });
    }
    
    res.json({
      success: true,
      message: 'Scholarship deleted successfully',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete scholarship',
    });
  }
};

module.exports = {
  createScholarship,
  getAllScholarships,
  getScholarship,
  updateScholarship,
  deleteScholarship,
};
