// ============================================================
// selectionRoutes — slot-model v2 award pipeline endpoints.
// All award-state transitions flow through selectionService.
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const selectionService = require('../services/selectionService');
const { SelectionError } = selectionService;

// Wrap async handlers so thrown errors reach Express error handling.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Translate a SelectionError into a clean JSON response.
function sendSelectionError(res, err) {
  if (err instanceof SelectionError) {
    const payload = { success: false, error: err.message };
    if (err.ties) payload.ties = err.ties;
    if (err.forfeited) payload.forfeited = err.forfeited;
    if (err.promoted) payload.promoted = err.promoted;
    return res.status(err.status || 400).json(payload);
  }
  console.error('[selectionRoutes] unexpected error:', err);
  return res.status(500).json({ success: false, error: 'Internal server error' });
}

router.use(authenticate);

// ------------------------------------------------------------
// GET /api/selection/:scholarshipId/leaderboard
// Ranked master list + tie flags. Admin + Committee.
// ------------------------------------------------------------
router.get(
  '/:scholarshipId/leaderboard',
  authorize(['admin', 'committee']),
  wrap(async (req, res) => {
    const data = await selectionService.getLeaderboard(Number(req.params.scholarshipId));
    res.json({ success: true, data });
  })
);

// ------------------------------------------------------------
// POST /api/selection/:scholarshipId/run
// System Shortlisting — rank + tag all evaluated applications.
// Admin + Committee.
// ------------------------------------------------------------
router.post(
  '/:scholarshipId/run',
  authorize(['admin', 'committee']),
  wrap(async (req, res) => {
    const result = await selectionService.runSelection(
      Number(req.params.scholarshipId),
      req.user.id
    );
    res.status(201).json({ success: true, data: result });
  })
);

// ------------------------------------------------------------
// PUT /api/selection/:scholarshipId/tie-resolution
// Admin tie-breaking — winners kept inside the cutoff.
// Body: { winners: [applicationId, ...], reason: string }
// ------------------------------------------------------------
router.put(
  '/:scholarshipId/tie-resolution',
  authorize(['admin']),
  wrap(async (req, res) => {
    const { winners, reason } = req.body || {};
    const result = await selectionService.resolveTies(
      Number(req.params.scholarshipId),
      winners,
      reason,
      req.user.id
    );
    res.json({ success: true, data: result });
  })
);

// ------------------------------------------------------------
// POST /api/selection/:scholarshipId/approve-awardees
// Final Approval — lock Top-N, open acceptance windows.
// Admin only.
// ------------------------------------------------------------
router.post(
  '/:scholarshipId/approve-awardees',
  authorize(['admin']),
  wrap(async (req, res) => {
    const { selectedIds } = req.body || {};
    const result = await selectionService.approveAwardees(
      Number(req.params.scholarshipId),
      req.user.id,
      selectedIds
    );
    res.json({ success: true, data: result });
  })
);

// ------------------------------------------------------------
// POST /api/selection/applications/:id/accept
// Applicant award acceptance — converts application to Active Scholar.
// ------------------------------------------------------------
router.post(
  '/applications/:id/accept',
  authorize(['applicant']),
  wrap(async (req, res) => {
    const { signature } = req.body || {};
    const result = await selectionService.acceptAward(
      Number(req.params.id),
      req.user.id,
      signature
    );
    res.json({ success: true, data: result });
  })
);

// ------------------------------------------------------------
// POST /api/selection/applications/:id/decline
// Applicant award decline — returns slot & auto-promotes waitlist.
// ------------------------------------------------------------
router.post(
  '/applications/:id/decline',
  authorize(['applicant']),
  wrap(async (req, res) => {
    const result = await selectionService.declineAward(
      Number(req.params.id),
      req.user.id
    );
    res.json({ success: true, data: result });
  })
);

// ------------------------------------------------------------
// POST /api/selection/:scholarshipId/promote-waitlist
// Admin button — promote the top-ranked waitlisted applicant(s).
// ------------------------------------------------------------
router.post(
  '/:scholarshipId/promote-waitlist',
  authorize(['admin']),
  wrap(async (req, res) => {
    const result = await selectionService.promoteNextWaitlisted(
      Number(req.params.scholarshipId),
      req.user.id,
      'manual promotion'
    );
    res.json({ success: true, data: result });
  })
);

// Error handler (must be last).
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  sendSelectionError(res, err);
});

module.exports = router;
