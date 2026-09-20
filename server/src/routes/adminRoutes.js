const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticate, authorize } = require('../middleware/auth');

// All admin routes require admin authorization
router.use(authenticate, authorize(['admin']));

router.get('/pending-users', adminController.listPendingUsers);
router.get('/users', adminController.listAllUsers);
router.get('/users/:id', adminController.getUser);
router.put('/users/:id', adminController.updateUser);
router.post('/users/:id/role', adminController.updateUserRole);
router.delete('/users/:id', adminController.deleteUser);
router.post('/users/:id/approve', adminController.approveUser);
router.post('/users/:id/reject', adminController.rejectUser);
router.post('/users/:id/reset-password', adminController.resetPassword);
router.post('/users/:id/suspend', adminController.suspendUser);
router.post('/users/:id/reactivate', adminController.reactivateUser);
router.post('/create-user', adminController.createStaff);
router.post('/create-staff', adminController.createStaff); // legacy alias
router.post('/users/bulk-approve', adminController.bulkApproveUsers);
router.post('/users/bulk-reject', adminController.bulkRejectUsers);
router.get('/notifications', adminController.listNotifications);
router.post('/notifications/:id/read', adminController.markNotificationRead);
router.get('/audit-logs', adminController.listAuditLogs);

module.exports = router;

