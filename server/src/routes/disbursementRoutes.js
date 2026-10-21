// ============================================================
// disbursementRoutes — staff/admin fund-release ledger (post-award).
//
// Mounted at /api/disbursements (see src/app.js). Access is limited to
// STAFF (who hand over funds) and ADMIN (who oversees the money). Committee
// members and applicants never see this ledger.
//
// All state transitions flow through disbursementService so the guards
// (standing checks, one-open-release-per-term, reference-number requirement)
// cannot be bypassed by a client.
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const service = require('../services/disbursementService');
const { DisbursementError } = service;

// Async handler wrapper: expected DisbursementErrors become clean 400/404/409
// JSON responses (no stack-trace noise); anything unexpected escalates to the
// global error handler in app.js.
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (err instanceof DisbursementError) {
      return res.status(err.status || 400).json({
        success: false,
        error: err.message,
        message: err.message,
      });
    }
    console.error('[disbursementRoutes] unexpected error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Positive integer path param → 400 instead of a Postgres cast error.
function idParam(value, label = 'id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new DisbursementError(`A valid ${label} is required.`, 400);
  }
  return id;
}

// ------------------------------------------------------------
// SCHOLAR SELF-SERVICE — the receiving half of a walk-in payout.
//
// Declared BEFORE the staff/admin guard below so an applicant-role user
// (which is what a scholar is — see scholars.user_id) can reach exactly
// these two endpoints and nothing else in this router. The scholar's own
// identity comes from the JWT; no scholar id is ever accepted from the
// client, so one scholar can never read or confirm another's money.
// ------------------------------------------------------------

// GET /api/disbursements/my — the signed-in scholar's releases + totals.
router.get(
  '/my',
  authenticate,
  authorize(['applicant']),
  handle(async (req, res) => {
    const data = await service.listMyDisbursements(req.user.id);
    res.json({ success: true, data });
  })
);

// POST /api/disbursements/my/:id/acknowledge
// Confirm receipt with a typed full-name signature. Body: { signature }
router.post(
  '/my/:id/acknowledge',
  authenticate,
  authorize(['applicant']),
  handle(async (req, res) => {
    const signature = (req.body && req.body.signature) || '';
    const row = await service.acknowledgeReceipt(
      idParam(req.params.id, 'disbursement id'),
      req.user.id,
      signature
    );
    res.json({ success: true, data: row, message: 'Receipt confirmed — thank you!' });
  })
);

router.use(authenticate, authorize(['staff', 'admin']));

// ------------------------------------------------------------
// GET /api/disbursements/summary
// Dashboard counters + peso totals for the disbursement workspace.
// Declared before /:id so the literal segment is never read as an id.
// ------------------------------------------------------------
router.get(
  '/summary',
  handle(async (req, res) => {
    const summary = await service.getSummary();
    res.json({ success: true, data: summary });
  })
);

// ------------------------------------------------------------
// GET /api/disbursements/scholars
// Active Scholar roster with lifetime funding totals.
// Query: scholarship_id, status, search
// ------------------------------------------------------------
router.get(
  '/scholars',
  handle(async (req, res) => {
    const scholars = await service.listScholars(req.query || {});
    res.json({ success: true, scholars });
  })
);

// ------------------------------------------------------------
// GET /api/disbursements/scholars/:id
// One scholar + their full disbursement history.
// ------------------------------------------------------------
router.get(
  '/scholars/:id',
  handle(async (req, res) => {
    const data = await service.getScholarDetail(idParam(req.params.id, 'scholar id'));
    res.json({ success: true, data });
  })
);


// ------------------------------------------------------------
// GET /api/disbursements
// Ledger list + totals.
// Query: scholar_id, scholarship_id, status, term, search
// ------------------------------------------------------------
router.get(
  '/',
  handle(async (req, res) => {
    const { disbursements, totals } = await service.listDisbursements(req.query || {});
    res.json({ success: true, disbursements, totals });
  })
);

// ------------------------------------------------------------
// GET /api/disbursements/:id
// Single ledger row (with scholar + releaser context).
// ------------------------------------------------------------
router.get(
  '/:id',
  handle(async (req, res) => {
    const row = await service.getDisbursementRow(idParam(req.params.id));
    if (!row) throw new DisbursementError('Disbursement not found.', 404);
    res.json({ success: true, data: row });
  })
);

// ------------------------------------------------------------
// POST /api/disbursements
// Schedule a release. Body: { scholar_id, term, amount?, scheduled_date?, notes? }
// `amount` defaults to the program's configured award amount.
// ------------------------------------------------------------
router.post(
  '/',
  handle(async (req, res) => {
    const row = await service.scheduleDisbursement(req.body || {}, req.user.id);
    res.status(201).json({ success: true, data: row, message: 'Disbursement scheduled.' });
  })
);

// ------------------------------------------------------------
// PUT /api/disbursements/:id
// Edit a still-pending release: { term?, amount?, scheduled_date?, notes? }
// ------------------------------------------------------------
router.put(
  '/:id',
  handle(async (req, res) => {
    const row = await service.updateDisbursement(
      idParam(req.params.id),
      req.body || {},
      req.user.id
    );
    res.json({ success: true, data: row, message: 'Disbursement updated.' });
  })
);

// ------------------------------------------------------------
// POST /api/disbursements/:id/processing
// Pending → processing (funds being prepared).
// ------------------------------------------------------------
router.post(
  '/:id/processing',
  handle(async (req, res) => {
    const row = await service.markProcessing(idParam(req.params.id), req.user.id);
    res.json({ success: true, data: row, message: 'Disbursement marked as processing.' });
  })
);

// ------------------------------------------------------------
// POST /api/disbursements/:id/release
// Release the funds (money out). Body: { reference_no, notes? }
// ------------------------------------------------------------
router.post(
  '/:id/release',
  handle(async (req, res) => {
    const row = await service.releaseDisbursement(
      idParam(req.params.id),
      req.body || {},
      req.user.id
    );
    res.json({ success: true, data: row, message: 'Disbursement released.' });
  })
);

// ------------------------------------------------------------
// POST /api/disbursements/:id/cancel
// Cancel an un-released row. Body: { reason } (min 5 chars).
// ------------------------------------------------------------
router.post(
  '/:id/cancel',
  handle(async (req, res) => {
    const reason = (req.body && (req.body.reason ?? req.body.remarks)) || '';
    const row = await service.cancelDisbursement(
      idParam(req.params.id),
      reason,
      req.user.id
    );
    res.json({ success: true, data: row, message: 'Disbursement cancelled.' });
  })
);

module.exports = router;
