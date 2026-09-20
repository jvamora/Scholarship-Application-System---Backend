const express = require('express');
const router = express.Router();
const staffController = require('../controllers/staffController');
const { auth, role } = require('../middleware/auth');

// Staff can create and list applicants they created
router.post('/applicants', auth, role(['staff']), staffController.createApplicant);
router.get('/applicants', auth, role(['staff']), staffController.listMyApplicants);
router.put('/applicants/:id', auth, role(['staff']), staffController.updateApplicant);

// Regenerate a lost temp password for an applicant this staff created (no-email recovery).
router.post('/applicants/:id/reset-password', auth, role(['staff']), staffController.resetApplicantPassword);

// Delete a still-pending applicant this staff created (mistake/duplicate cleanup).
router.delete('/applicants/:id', auth, role(['staff']), staffController.deleteApplicant);

// Read-only: scholarship applications submitted by this staff's applicants.
router.get('/applicants/applications', auth, role(['staff']), staffController.listMyApplicantsApplications);

// Staff notification inbox (approve/reject/suspend/reactivate/activate events).
router.get('/notifications', auth, role(['staff']), staffController.listNotifications);
router.post('/notifications/:id/read', auth, role(['staff']), staffController.markNotificationRead);

module.exports = router;
