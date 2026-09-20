const pool = require('../config/db');

// Get notifications for the authenticated user
const getUserNotifications = async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const unreadOnly = req.query.unreadOnly === 'true';

    let sql = 'SELECT id, user_id, title, message, type, is_read, reference_type, reference_id, created_at FROM notifications WHERE user_id = ?';
    const params = [userId];

    if (unreadOnly) {
      sql += ' AND is_read = FALSE';
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const [rows] = await pool.query(sql, params);
    res.json({ success: true, notifications: rows || [] });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get unread notification count
const getUnreadCount = async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = FALSE',
      [userId]
    );
    const count = rows && rows[0] ? Number(rows[0].count) : 0;
    res.json({ success: true, count });
  } catch (error) {
    console.error('Error fetching unread notification count:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Mark a single notification as read
const markRead = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
      [id, userId]
    );
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (error) {
    console.error('Error marking notification read:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Mark all notifications as read for logged in user
const markAllRead = async (req, res) => {
  try {
    const userId = req.user.id;
    await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE user_id = ? AND is_read = FALSE',
      [userId]
    );
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Error marking all notifications read:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  getUserNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
};
