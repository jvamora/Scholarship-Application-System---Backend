const { exportScholarshipSchema, exportApplicationSchema } = require('../validators/reportValidator');
const Scholarship = require('../models/Scholarship');
const Application = require('../models/Application');
const User = require('../models/User');
const { query } = require('../config/database');

// RFC-4180-safe CSV cell helper: null/undefined render as empty cells and
// embedded quotes/newlines never corrupt the row structure.
function csvCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  const q = String.fromCharCode(34); // the double-quote character
  return q + str.split(q).join(q + q) + q;
}

// Get scholarship statistics
const getScholarshipStats = async (req, res) => {
  try {
    const totalScholarships = await Scholarship.count();

    // Active programs: open is the only lifecycle status currently accepting
    // applications (draft/closed/completed all count as inactive).
    const activeScholarships = await Scholarship.count({ status: 'open' });

    // Average advertised amount (programs without an amount are excluded)
    const amountStats = await query(
      'SELECT AVG(amount) AS avgAmount FROM scholarship_programs WHERE amount IS NOT NULL'
    );

    // Programs grouped by lifecycle status
    const statusStats = await query(
      'SELECT status, COUNT(*) AS count FROM scholarship_programs GROUP BY status'
    );

    res.json({
      success: true,
      data: {
        totalScholarships,
        activeScholarships,
        inactiveScholarships: totalScholarships - activeScholarships,
        averageAmount: Number(amountStats[0].avgAmount) || 0,
        // Keys remain active/inactive because the AdminDashboard donut chart
        // reads exactly those two fields.
        statusDistribution: statusStats.reduce((acc, s) => {
          const key = s.status === 'open' ? 'active' : 'inactive';
          acc[key] = (Number(acc[key]) || 0) + Number(s.count);
          return acc;
        }, {}),
      },
    });
  } catch (error) {
    console.error('Error fetching scholarship stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch scholarship statistics',
    });
  }
};

// Get application statistics
const getApplicationStats = async (req, res) => {
  try {
    // Total applications
    const totalApplications = await Application.count();

    // Applications by status
    const statusStats = await query(
      'SELECT status, COUNT(*) as count FROM applications GROUP BY status'
    );

    // Top 5 programs ranked by submission volume (real table name)
    const scholarshipStats = await query(
      'SELECT s.id, s.name, COUNT(a.id) AS count FROM scholarship_programs s LEFT JOIN applications a ON s.id = a.scholarship_id GROUP BY s.id, s.name ORDER BY count DESC LIMIT 5'
    );

    res.json({
      success: true,
      data: {
        totalApplications,
        statusDistribution: statusStats.reduce((acc, s) => {
          acc[s.status] = Number(s.count);
          return acc;
        }, {}),
        topScholarships: scholarshipStats,
      },
    });
  } catch (error) {
    console.error('Error fetching application stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch application statistics',
    });
  }
};

// Get user statistics
const getUserStats = async (req, res) => {
  try {
    const totalUsers = await User.count();
    const roleStats = await query('SELECT role, COUNT(*) as count FROM users GROUP BY role');
    const recentUsers = await query('SELECT id, first_name, last_name, email, role, created_at FROM users ORDER BY created_at DESC LIMIT 5');

    // Applicant activation funnel, built from grouped counts.
    const applicantRows = await query('SELECT status, COUNT(*) AS c FROM users WHERE role = ? GROUP BY status', ['applicant']);

    const byStatus = {};
    applicantRows.forEach((r) => { byStatus[r.status] = Number(r.c); });

    const activationStats = {
      totalApplicants: applicantRows.reduce((sum, r) => sum + Number(r.c), 0),
      pendingApplicants: byStatus.pending || 0,
      rejectedApplicants: byStatus.rejected || 0,
      approvedApplicants: byStatus.approved || 0,
      activatedApplicants: byStatus.activated || 0,
    };

    res.json({
      success: true,
      data: {
        totalUsers,
        roleDistribution: roleStats.reduce((acc, r) => {
          acc[r.role] = r.count;
          return acc;
        }, {}),
        recentUsers,
        activationStats,
      },
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user statistics',
    });
  }
};


// Export scholarships to CSV
const exportScholarships = async (req, res) => {
  try {
    const filters = exportScholarshipSchema.parse(req.query);
    const scholarships = await Scholarship.findAll(filters);

    // Row/column delimiters built defensively so no quote-balancing bug can
    // ever corrupt the emitted CSV structure.
    const nl = String.fromCharCode(10);
    const cm = String.fromCharCode(44);
    const headerCols = ['ID','Name','Description','Amount','Deadline','Eligibility','Status','Created At','Updated At'];
    const csvHeader = headerCols.map(csvCell).join(cm) + nl;

    // Lifecycle status mapped to a human label: open equals Active.
    const csvRows = scholarships.map((s) => [
      csvCell(s.id),
      csvCell(s.name),
      csvCell(s.description),
      csvCell(s.amount == null ? '' : s.amount),
      csvCell(s.deadline),
      csvCell(s.eligibility),
      csvCell(s.status === 'open' ? 'Active' : String(s.status == null ? '' : s.status).split('_').join(' ')),
      csvCell(s.created_at),
      csvCell(s.updated_at)
    ].join(cm));

    res.header('Content-Type', 'text/csv');
    res.attachment('scholarships.csv');
    res.send(csvHeader + csvRows.join(nl));
  } catch (error) {
    console.error('Error exporting scholarships:', error);
    res.status(400).json({
      success: false,
      message: (error.errors && error.errors[0] && error.errors[0].message) || 'Failed to export scholarships'
    });
  }
};

// Export applications to CSV
const exportApplications = async (req, res) => {
  try {
    const filters = exportApplicationSchema.parse(req.query);
    const applications = await Application.findAll(filters);
    const nl = String.fromCharCode(10);
    const cm = String.fromCharCode(44);
    // Application.findAll exposes owner names as first_name/last_name (joined
    // via students then users), NOT user_first_name/user_last_name.
    const headerCols = ['ID','Application Number','Scholarship','Applicant','Score','Status','Submitted At','Updated At'];
    const csvHeader = headerCols.map(csvCell).join(cm) + nl;
    const csvRows = applications.map((a) => [
      csvCell(a.id),
      csvCell(a.application_number),
      csvCell(a.scholarship_name),
      csvCell([a.first_name, a.last_name].filter(Boolean).join(' ')),
      csvCell(a.total_score == null ? '' : a.total_score),
      csvCell(a.status),
      csvCell(a.submitted_at),
      csvCell(a.updated_at)
    ].join(cm));

    res.header('Content-Type', 'text/csv');
    res.attachment('applications.csv');
    res.send(csvHeader + csvRows.join(nl));
  } catch (error) {
    console.error('Error exporting applications:', error);
    res.status(400).json({
      success: false,
      message: (error.errors && error.errors[0] && error.errors[0].message) || 'Failed to export applications'
    });
  }
};

// Get application timeline (last 30 days)
const getApplicationTimeline = async (req, res) => {
  try {
    const timeline = await query("SELECT submitted_at::date AS date, COUNT(*) as count, status FROM applications WHERE submitted_at >= NOW() - INTERVAL '30 days' GROUP BY submitted_at::date, status ORDER BY date");
    res.json({ success: true, data: timeline });
  } catch (error) {
    console.error('Error fetching application timeline:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch application timeline' });
  }
};

// Get status distribution
const getStatusDistribution = async (req, res) => {
  try {
    const distribution = await query('SELECT status, COUNT(*) as count FROM applications GROUP BY status');
    res.json({ success: true, data: distribution });
  } catch (error) {
    console.error('Error fetching status distribution:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch status distribution' });
  }
};

module.exports = {
  getScholarshipStats,
  getApplicationStats,
  getUserStats,
  exportScholarships,
  exportApplications,
  getApplicationTimeline,
  getStatusDistribution,
};
