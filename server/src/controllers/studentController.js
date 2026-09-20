const { query, execute } = require('../config/database');

// Make sure an applicant has a `students` row, creating one if missing.
// Student number is derived from the account email prefix + user id.
const ensureStudent = async (userId) => {
  let rows = await query('SELECT id FROM students WHERE user_id = ?', [userId]);
  if (rows.length > 0) return rows[0];

  const users = await query('SELECT id, email FROM users WHERE id = ?', [userId]);
  const emailPrefix = (users[0]?.email || 'STU').split('@')[0].replace(/[^a-z0-9]/gi, '') || 'STU';
  const studentNumber = `STU-${emailPrefix}-${userId}`;
  await execute(
    'INSERT INTO students (user_id, student_number) VALUES (?, ?)',
    [userId, studentNumber]
  );
  rows = await query('SELECT id FROM students WHERE user_id = ?', [userId]);
  return rows[0];
};

const studentWithMeta = `
  SELECT s.*,
         c.name AS course_name, c.code AS course_code,
         col.name AS college_name
    FROM students s
    LEFT JOIN courses c   ON s.course_id = c.id
    LEFT JOIN colleges col ON c.college_id = col.id
`;

const getMyStudent = async (req, res) => {
  try {
    const student = await ensureStudent(req.user.id);
    const rows = await query(`${studentWithMeta} WHERE s.id = ? LIMIT 1`, [student.id]);
    res.json({ success: true, data: rows[0] || null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const updateMyStudent = async (req, res) => {
  try {
    const { course_id, year_level, gender, phone, address } = req.body;
    const student = await ensureStudent(req.user.id);
    await execute(
      `UPDATE students
          SET course_id = ?, year_level = ?, gender = ?, phone = ?, address = ?
        WHERE id = ?`,
      [
        course_id || null,
        year_level || null,
        gender || null,
        phone || null,
        address || null,
        student.id,
      ]
    );
    const rows = await query(`${studentWithMeta} WHERE s.id = ? LIMIT 1`, [student.id]);
    res.json({ success: true, data: rows[0] || null });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

const listCourses = async (req, res) => {
  try {
    const rows = await query(
      `SELECT c.id, c.name, c.code, col.name AS college_name
         FROM courses c
         LEFT JOIN colleges col ON c.college_id = col.id
        ORDER BY col.name, c.name`
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { getMyStudent, updateMyStudent, listCourses };