const express = require('express');
const router = express.Router();
const path = require('path');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');

// GET /api/documents/:id
// Authenticated download of an uploaded application document.
// Access: the applicant who owns the application, or admin / committee.
router.get('/:id', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ad.*, u.id AS owner_user_id
         FROM application_documents ad
         JOIN applications a ON a.id = ad.application_id
         JOIN students st    ON st.id = a.student_id
         JOIN users u        ON u.id = st.user_id
        WHERE ad.id = ?
        LIMIT 1`,
      [req.params.id]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    const doc = rows[0];

    const isOwner = Number(doc.owner_user_id) === Number(req.user.id);
    const isPrivileged = ['admin', 'committee'].includes(req.user.role);
    if (!isOwner && !isPrivileged) {
      return res.status(403).json({ success: false, message: 'Not authorized to access this document' });
    }

    // Rebuild the path server-side from the stored basename to prevent traversal
    const base = path.basename(doc.file_path || '');
    if (!base) {
      return res.status(404).json({ success: false, message: 'File missing on server' });
    }
    const abs = path.join(__dirname, '..', 'uploads', 'applications', base);

    res.download(abs, doc.file_name || base);
  } catch (error) {
    console.error('Error downloading document:', error);
    res.status(500).json({ success: false, message: 'Failed to download document' });
  }
});

module.exports = router;