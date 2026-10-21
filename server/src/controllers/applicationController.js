const { applicationSchema, statusUpdateSchema } = require('../validators/applicationValidator');
const Application = require('../models/applicationModel');
const { uploadApplication, handleMulterError } = require('../utils/upload');
const pool = require('../config/db');
const { notifyApplicant } = require('../utils/notifyApplicant');

// Notify every active Scholarship Reviewer (committee) that a new application
// needs a decision. Written AFTER the submission transaction has committed so a
// notification failure can never roll back a successful application.
const notifyReviewersOfNewApplication = async (application, applicantName, scholarshipName) => {
  try {
    const [reviewers] = await pool.query(
      "SELECT id FROM users WHERE role = 'committee' AND is_active = TRUE AND status = 'approved'"
    );
    for (const reviewer of reviewers || []) {
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type, reference_type, reference_id)
         VALUES (?, ?, ?, 'info', 'application', ?)`,
        [
          reviewer.id,
          'New application awaiting review',
          `${applicantName} submitted an application for "${scholarshipName}" (#${application.application_number || application.id}). It is awaiting your decision.`,
          application.id,
        ]
      );
    }
  } catch (err) {
    // Non-fatal: the application is already saved; just log the miss.
    console.error('Failed to notify reviewers of new application:', err.message);
  }
};

// Submit a new application
const submitApplication = async (req, res) => {
  try {
    // Parse answers from JSON string
    const answers = typeof req.body.answers === 'string' 
      ? JSON.parse(req.body.answers)
      : req.body.answers;
    
    const validatedData = applicationSchema.parse({
      scholarshipId: req.body.scholarshipId,
      answers,
    });
    
    // Get uploaded files
    const documents = req.files || [];
    
    const application = await Application.submit(
      validatedData,
      req.user.id,
      documents
    );

    // Fire-and-forget: alert all committee members so the queue is never silent
    const applicantName = [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || 'An applicant';
    notifyReviewersOfNewApplication(application, applicantName, (application && application.scholarship_name) || validatedData.scholarshipId);
    
    res.status(201).json({
      success: true,
      data: application,
    });
  } catch (error) {
    res.status(error.status || 400).json({
      success: false,
      message: error.errors?.[0]?.message || error.message || 'Failed to submit application',
    });
  }
};

// Get all applications for the current user
const getMyApplications = async (req, res) => {
  try {
    const applications = await Application.getByUser(req.user.id);
    res.json({
      success: true,
      data: applications,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch applications',
    });
  }
};

// Get a specific application
const getApplication = async (req, res) => {
  try {
    const application = await Application.getById(req.params.id);
    
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found',
      });
    }
    
    // Check if the user owns this application or is an admin/committee member
    if (Number(application.user_id) !== Number(req.user.id) && !['admin', 'committee'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this application',
      });
    }

    // Parse the JSON answers column into an object for the client
    let answers = application.answers;
    if (typeof answers === 'string') {
      try {
        answers = JSON.parse(answers);
      } catch {
        answers = {};
      }
    }

    // Reviewer feedback — surface the latest reviewer's remarks so an applicant
    // understands WHY they were rejected/waitlisted before choosing to fix &
    // resubmit. Applicant name is not exposed; only the substantive feedback.
    let reviewerFeedback = null;
    try {
      const [feedbackRows] = await require('../config/db').query(
        `SELECT cr.score, cr.remarks, cr.recommendation, cr.created_at
           FROM committee_reviews cr
          WHERE cr.application_id = ? AND cr.remarks IS NOT NULL AND cr.remarks != ''
          ORDER BY cr.created_at DESC
          LIMIT 1`,
        [application.id]
      );
      if (feedbackRows && feedbackRows.length > 0) reviewerFeedback = feedbackRows[0];
    } catch (feedbackErr) {
      console.error('Failed to load reviewer feedback:', feedbackErr.message);
    }

    res.json({
      success: true,
      data: { ...application, answers, reviewer_feedback: reviewerFeedback },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch application',
    });
  }
};

// Update a rejected/withdrawn applicant's answers and/or documents
// (the "fix" half of "fix & resubmit").
const updateApplication = async (req, res) => {
  try {
    const answers = typeof req.body.answers === 'string'
      ? JSON.parse(req.body.answers)
      : req.body.answers;

    // New files, if any, arrive via multer under the `documents` field.
    const documents = req.files || [];

    const application = await Application.update(
      req.params.id,
      req.user.id,
      { answers: answers || {}, documents }
    );

    res.json({
      success: true,
      data: application,
    });
  } catch (error) {
    res.status(error.status || 400).json({
      success: false,
      message: error.message || 'Failed to update application',
    });
  }
};

// Get applications for a scholarship (for committee)
const getScholarshipApplications = async (req, res) => {
  try {
    const applications = await Application.getByScholarship(req.params.scholarshipId);
    res.json({
      success: true,
      data: applications,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch applications',
    });
  }
};

// Update application status (for committee)
const updateApplicationStatus = async (req, res) => {
  try {
    const validatedData = statusUpdateSchema.parse(req.body);
    const result = await Application.updateStatus(req.params.id, validatedData.status);
    
    if (!result) {
      return res.status(404).json({
        success: false,
        message: 'Application not found',
      });
    }

    // Admin raw status change — notify the owning applicant of the new state.
    notifyApplicant(
      req.params.id,
      'Application Status Updated',
      (app) => `${app.scholarship_name || 'This program'} (${app.application_number || `#${req.params.id}`}) status changed to "${validatedData.status.replace(/_/g, ' ')}".`,
      'info'
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.errors?.[0]?.message || 'Failed to update application status',
    });
  }
};

// Withdraw an application (applicant owner only, pre-decision)
const WITHDRAWABLE_STATUSES = ['submitted', 'under_review', 'committee_review'];

const withdrawApplication = async (req, res) => {
  try {
    const applicationId = req.params.id;
    const userId = req.user.id;

    // Ownership + current status resolved in one query
    const [rows] = await require('../config/db').query(
      `SELECT a.id, a.status
         FROM applications a
         JOIN students st ON st.id = a.student_id
        WHERE a.id = ? AND st.user_id = ?
        LIMIT 1`,
      [applicationId, userId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Application not found',
      });
    }

    const { status } = rows[0];
    if (!WITHDRAWABLE_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: status === 'withdrawn'
          ? 'This application has already been withdrawn.'
          : `An application in "${status}" state can no longer be withdrawn.`,
      });
    }

    const updated = await Application.updateStatus(
      applicationId,
      'withdrawn',
      userId,
      'Withdrawn by applicant'
    );

    res.json({
      success: true,
      data: updated,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to withdraw application',
    });
  }
};

// Resubmit a rejected/withdrawn application (applicant owner only). Re-opens the
// existing application to 'submitted' and re-decrements a scholarship slot,
// recording the resubmission in the status-history timeline.
const resubmitApplication = async (req, res) => {
  try {
    const result = await Application.resubmit(req.params.id, req.user.id);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(error.status || 400).json({
      success: false,
      message: error.message || 'Failed to resubmit application',
    });
  }
};

// List the authenticated applicant's notifications (newest first).
// These are written when their application status changes (decision by
// committee/admin, promotion, recall/reopen, withdrawal, resubmission).
const listNotifications = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ success: true, notifications: rows });
  } catch (error) {
    console.error('Error listing applicant notifications:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Mark one of the authenticated applicant's notifications as read.
// Owner-scoped: an applicant can only mark their own notifications read.
const markNotificationRead = async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (error) {
    console.error('Error marking applicant notification read:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
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
};
