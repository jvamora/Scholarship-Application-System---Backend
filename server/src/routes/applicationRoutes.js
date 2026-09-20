const express = require('express');
const router = express.Router();
const {
  uploadApplication,
  handleMulterError,
  submitApplication,
  getMyApplications,
    getApplication,
  updateApplication,
  getScholarshipApplications,
  updateApplicationStatus,
  withdrawApplication,
  resubmitApplication,
  listNotifications,
  markNotificationRead,
} = require('../controllers/applicationController');
const { authenticate, authorize } = require('../middleware/auth');
const { acceptAward, declineAward, SelectionError } = require('../services/selectionService');

// Submit a new application (applicants only)
router.post('/', 
  authenticate, 
  authorize(['applicant']), 
  uploadApplication.array('documents'),
  handleMulterError,
  submitApplication
);

// Get all applications for the current user
router.get('/me', authenticate, authorize(['applicant']), getMyApplications);

// Applicant's notifications (application-status / decision events).
// MUST be mounted before the catch-all GET /:id route so the literal
// "notifications" segment is not mistaken for an application id.
router.get('/notifications', authenticate, authorize(['applicant']), listNotifications);
router.post('/notifications/:id/read', authenticate, authorize(['applicant']), markNotificationRead);

// Get a specific application
router.get('/:id', authenticate, getApplication);

// Update a rejected/withdrawn applicant's answers and/or documents (the "fix"
// half of "fix & resubmit"). Owner-guarded; only rejected/withdrawn allowed.
router.put('/:id',
  authenticate,
  authorize(['applicant']),
  uploadApplication.array('documents'),
  handleMulterError,
  updateApplication
);

// Get applications for a scholarship (for committee)
router.get('/scholarship/:scholarshipId/applications', 
  authenticate, 
  authorize(['admin', 'committee']), 
  getScholarshipApplications
);

// Update application status — ADMIN ONLY.
// Committee members (Scholarship Reviewers) must NOT use this raw-status route:
// all decisions have to flow through POST /api/committee/applications/:id/review
// so every approve/reject is a recorded, auditable evaluation (score +
// recommendation + notes). Allowing reviewers to set statuses directly would
// bypass that governance entirely.
router.put('/:id/status',
  authenticate,
  authorize(['admin']),
  updateApplicationStatus
);

// Withdraw an application (applicant owner only, pre-decision)
router.post('/:id/withdraw',
  authenticate,
  authorize(['applicant']),
  withdrawApplication
);

// Resubmit a rejected/withdrawn application (applicant owner only)
router.post('/:id/resubmit',
  authenticate,
  authorize(['applicant']),
  resubmitApplication
);

// Accept an awarded scholarship — digital signature → Active Scholar.
// Body: { signature: string (applicant's full name) }
// NOTE: selectionService.acceptAward/declineAward take *data* arguments
// (applicationId, userId, signature), NOT (req, res, next). Wrapping them
// here translates the HTTP request into the service's argument list.
const wrapAwardAction = (handler) => async (req, res, next) => {
  try {
    const result = await handler(
      Number(req.params.id),
      req.user.id,
      (req.body && req.body.signature) || undefined
    );
    res.json({ success: true, data: result });
  } catch (err) {
    // Expected validation failures (wrong signature, award already accepted,
    // not awarded, etc.) arrive as SelectionError — respond with their status
    // and message directly instead of routing through the global error handler,
    // which would log a full stack trace for an intentional, user-facing 400.
    if (err instanceof SelectionError) {
      const payload = { success: false, error: err.message, message: err.message };
      if (err.ties) payload.ties = err.ties;
      if (err.forfeited) payload.forfeited = err.forfeited;
      if (err.promoted) payload.promoted = err.promoted;
      return res.status(err.status || 400).json(payload);
    }
    next(err);
  }
};

// Accept an awarded scholarship — digital signature → Active Scholar.
// Body: { signature: string (applicant's full name) }
router.post('/:id/accept-award',
  authenticate,
  authorize(['applicant']),
  wrapAwardAction(acceptAward)
);

// Decline an awarded scholarship — slot freed → next waitlisted promoted.
router.post('/:id/decline-award',
  authenticate,
  authorize(['applicant']),
  wrapAwardAction(declineAward)
);

module.exports = router;