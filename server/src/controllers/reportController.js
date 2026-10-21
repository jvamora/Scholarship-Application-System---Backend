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

// ------------------------------------------------------------
// Applications-over-time report.
//
// Granularities: month | quarter | semester | year.
// Default is "semester" because this is a scholarship system: intake and
// awarding follow the academic calendar (Philippine AY = Jun 1 -> Mar 31, two
// semesters), so per-semester buckets match how the office actually plans.
//
// The query always aggregates by calendar month (cheap + tz-safe), then rolls
// those month buckets up in JS. Keeping the roll-up in one readable place
// avoids fragile SQL date math.
// ------------------------------------------------------------

// Rolling window (in months) used when the caller does not pass an explicit
// academicYearId / from / to range.
const TIMELINE_WINDOW_MONTHS = {
  month: 12,
  quarter: 12,
  semester: 24, // ~2 academic years so the trend has enough points to be useful
  year: 60,
};

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Roll month-grouped rows up into the requested bucket, returning
// chronologically sorted { label, period_start, count } objects.
function bucketTimeline(monthlyRows, granularity, from, to) {
  const buckets = new Map();

  if (from && to) {
    const current = new Date(from);
    current.setDate(1);
    const end = new Date(to);
    end.setDate(1);

    while (current <= end) {
      const year = current.getFullYear();
      const monthNum = current.getMonth() + 1;
      const monthIndex = current.getMonth();
      const yStr = String(year);
      const mStr = String(monthNum).padStart(2, '0');

      let key, label, periodStartIso;

      if (granularity === 'month') {
        key = `${yStr}-${mStr}`;
        label = `${MONTH_ABBR[monthIndex]} ${year}`;
        periodStartIso = `${yStr}-${mStr}-01`;
      } else if (granularity === 'quarter') {
        const quarter = Math.floor(monthIndex / 3) + 1;
        key = `${year}-Q${quarter}`;
        label = `Q${quarter} ${year}`;
        periodStartIso = `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}-01`;
      } else if (granularity === 'year') {
        key = `${year}`;
        label = `${year}`;
        periodStartIso = `${year}-01-01`;
      } else {
        let semester;
        let ayStart;
        if (monthNum >= 6 && monthNum <= 10) {
          semester = 1; ayStart = year; periodStartIso = `${year}-06-01`;
        } else if (monthNum === 11 || monthNum === 12) {
          semester = 2; ayStart = year; periodStartIso = `${year}-11-01`;
        } else if (monthNum <= 3) {
          semester = 2; ayStart = year - 1; periodStartIso = `${year - 1}-11-01`;
        } else {
          semester = 0; ayStart = year - 1; periodStartIso = `${yStr}-${mStr}-01`;
        }
        key = `${ayStart}-S${semester}`;
        const ayLabel = `${ayStart}-${ayStart + 1}`;
        label = semester === 0 ? `Break ${ayLabel}` : `${semester === 1 ? '1st' : '2nd'} Sem ${ayLabel}`;
      }

      if (!buckets.has(key)) {
        buckets.set(key, { label, period_start: periodStartIso, count: 0 });
      }
      current.setMonth(current.getMonth() + 1);
    }
  }

  for (const row of monthlyRows || []) {
    // row.month is 'YYYY-MM'
    const [yStr, mStr] = String(row.month).split('-');
    const year = Number(yStr);
    const monthNum = Number(mStr); // 1-12
    if (!year || !monthNum) continue;
    const monthIndex = monthNum - 1;
    const count = Number(row.count || 0);

    let key;
    let label;
    let periodStartIso;

    if (granularity === 'month') {
      key = row.month;
      label = `${MONTH_ABBR[monthIndex]} ${year}`;
      periodStartIso = `${yStr}-${mStr}-01`;
    } else if (granularity === 'quarter') {
      const quarter = Math.floor(monthIndex / 3) + 1;
      key = `${year}-Q${quarter}`;
      label = `Q${quarter} ${year}`;
      periodStartIso = `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}-01`;
    } else if (granularity === 'year') {
      key = `${year}`;
      label = `${year}`;
      periodStartIso = `${year}-01-01`;
    } else {
      // semester (default): 1st Sem = Jun-Oct, 2nd Sem = Nov-Mar, Apr-May = Break.
      let semester; // 1 | 2 | 0 (break)
      let ayStart;
      if (monthNum >= 6 && monthNum <= 10) {
        semester = 1;
        ayStart = year;
        periodStartIso = `${year}-06-01`;
      } else if (monthNum === 11 || monthNum === 12) {
        semester = 2;
        ayStart = year;
        periodStartIso = `${year}-11-01`;
      } else if (monthNum <= 3) {
        semester = 2;
        ayStart = year - 1;
        periodStartIso = `${year - 1}-11-01`;
      } else {
        semester = 0; // Apr-May — outside the AY; kept so nothing is silently dropped
        ayStart = year - 1;
        periodStartIso = `${yStr}-${mStr}-01`;
      }
      key = `${ayStart}-S${semester}`;
      const ayLabel = `${ayStart}-${ayStart + 1}`;
      label = semester === 0
        ? `Break ${ayLabel}`
        : `${semester === 1 ? '1st' : '2nd'} Sem ${ayLabel}`;
    }

    const existing = buckets.get(key);
    if (existing) {
      existing.count += count;
    } else {
      buckets.set(key, { label, period_start: periodStartIso, count });
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.period_start.localeCompare(b.period_start));
}

// Get application timeline. Query params (all optional):
//   granularity=month|quarter|semester|year   (default: semester)
//   academicYearId=<id>                        (range + filter by that AY)
//   from=YYYY-MM-DD & to=YYYY-MM-DD            (explicit inclusive range)
const getApplicationTimeline = async (req, res) => {
  try {
    const granularity = Object.prototype.hasOwnProperty.call(TIMELINE_WINDOW_MONTHS, req.query.granularity)
      ? req.query.granularity
      : 'semester';

    let from = req.query.from || null;
    let to = req.query.to || null;
    let academicYearId = null;

    if (req.query.academicYearId) {
      const candidate = Number(req.query.academicYearId);
      if (Number.isInteger(candidate) && candidate > 0) {
        academicYearId = candidate;
        const ay = await query(
          'SELECT start_date, end_date FROM academic_years WHERE id = ? LIMIT 1',
          [academicYearId]
        );
        if (ay && ay[0]) {
          if (!from) from = String(ay[0].start_date).slice(0, 10);
          if (!to) to = String(ay[0].end_date).slice(0, 10);
        }
      }
    }

    if (!from) {
      const months = TIMELINE_WINDOW_MONTHS[granularity];
      const start = new Date();
      start.setMonth(start.getMonth() - months);
      from = start.toISOString().slice(0, 10);
    }
    if (!to) {
      to = new Date().toISOString().slice(0, 10);
    }

    const params = [from, to];
    let where = `submitted_at IS NOT NULL
        AND submitted_at >= $1::date
        AND submitted_at < ($2::date + INTERVAL '1 day')`;
    if (academicYearId) {
      params.push(academicYearId);
      where += ` AND academic_year_id = $${params.length}`;
    }

    const monthlyRows = await query(
      `SELECT TO_CHAR(DATE_TRUNC('month', submitted_at), 'YYYY-MM') AS month,
              COUNT(*)::int AS count
         FROM applications
        WHERE ${where}
        GROUP BY month
        ORDER BY month`,
      params
    );

    const buckets = bucketTimeline(monthlyRows, granularity, from, to);
    res.json({ success: true, granularity, data: buckets });
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
