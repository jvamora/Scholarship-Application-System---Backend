const { query } = require('../config/database');

// Aggregates the public hero stats shown on the landing (Home) page from real
// data. All queries are read-only. Returns:
//   fundingAwarded    - ₱ sum of amounts for awarded/active-scholar applications
//   activeScholarships - count of scholarship_programs currently open
//   successRate       - % of applications that reached an approved/awarded/scholar_active outcome
//   applicationsTracked - total application count
const getHomeStats = async (req, res) => {
  try {
    const [scholarshipRow, fundingRow, outcomeRow, appsRow] = await Promise.all([
      query("SELECT COUNT(*)::int AS count FROM scholarship_programs WHERE status = 'open'"),
      query(`SELECT COALESCE(SUM(sp.amount), 0)::numeric AS total
             FROM applications a
             JOIN scholarship_programs sp ON sp.id = a.scholarship_id
             WHERE a.status IN ('awarded', 'scholar_active')`),
      query(`SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE status IN ('approved', 'awarded', 'scholar_active'))::int AS successful
             FROM applications`),
      query('SELECT COUNT(*)::int AS total FROM applications'),
    ]);

    const totalApps = appsRow[0]?.total || 0;
    const successful = outcomeRow[0]?.successful || 0;
    const successRate = totalApps > 0 ? Math.round((successful / totalApps) * 1000) / 10 : 0;

    res.json({
      success: true,
      data: {
        fundingAwarded: Number(fundingRow[0]?.total) || 0,
        activeScholarships: scholarshipRow[0]?.count || 0,
        successRate,
        applicationsTracked: totalApps,
      },
    });
  } catch (error) {
    console.error('Error fetching home stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch home statistics',
    });
  }
};

module.exports = { getHomeStats };