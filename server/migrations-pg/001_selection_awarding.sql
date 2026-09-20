-- ============================================================
-- Migration 001 (slot-model v2): Selection & Awarding schema
-- Target: PostgreSQL / Supabase. Each file is idempotent and runs
-- OUTSIDE an explicit transaction (ALTER TYPE ... ADD VALUE cannot
-- run inside one). Apply with: node scripts/migrate-pg.js
-- ============================================================

-- 1. Extend the application lifecycle with selection/awarding states.
--    shortlisted   — within the cutoff (top N), awaiting final approval
--    awarded       — admin locked the awardee list; acceptance window open
--    scholar_active— applicant accepted; converted to an Active Scholar
--    award_declined— applicant declined; slot returns to the waitlist
--    award_forfeited — acceptance deadline passed; slot returns to waitlist
ALTER TYPE application_status ADD VALUE IF NOT EXISTS 'shortlisted';
ALTER TYPE application_status ADD VALUE IF NOT EXISTS 'awarded';
ALTER TYPE application_status ADD VALUE IF NOT EXISTS 'scholar_active';
ALTER TYPE application_status ADD VALUE IF NOT EXISTS 'award_declined';
ALTER TYPE application_status ADD VALUE IF NOT EXISTS 'award_forfeited';

-- 2. Selection-run audit snapshot (one row per ranking execution).
CREATE TABLE IF NOT EXISTS selection_runs (
  id              SERIAL PRIMARY KEY,
  scholarship_id  INT NOT NULL REFERENCES scholarship_programs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  cutoff_rank     INT NOT NULL,
  waitlist_size   INT NOT NULL DEFAULT 10,
  total_evaluated INT NOT NULL DEFAULT 0,
  tie_policy      VARCHAR(50) NOT NULL DEFAULT 'manual',
  created_by      INT REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_selection_runs_scholarship ON selection_runs(scholarship_id);

-- 3. Ranking + award columns on applications.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS selection_rank     INT,
  ADD COLUMN IF NOT EXISTS selection_tie      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS selection_run_id   INT REFERENCES selection_runs(id) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD COLUMN IF NOT EXISTS award_expires_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acceptance_signature TEXT,
  ADD COLUMN IF NOT EXISTS accepted_at        TIMESTAMPTZ;

-- 4. Active Scholar registry (created at acceptance, one per application).
CREATE TABLE IF NOT EXISTS scholars (
  id               SERIAL PRIMARY KEY,
  application_id   INT NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE ON UPDATE CASCADE,
  student_id       INT NOT NULL REFERENCES students(id) ON DELETE CASCADE ON UPDATE CASCADE,
  scholarship_id   INT NOT NULL REFERENCES scholarship_programs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  user_id          INT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  status           VARCHAR(30) NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'renewal_pending', 'completed', 'revoked')),
  awarded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at      TIMESTAMPTZ,
  contract_version INT NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scholars_scholarship ON scholars(scholarship_id);
CREATE INDEX IF NOT EXISTS idx_scholars_user ON scholars(user_id);

-- 5. Disbursement tracking (staff per-term fund releases).
CREATE TABLE IF NOT EXISTS disbursements (
  id             SERIAL PRIMARY KEY,
  scholar_id     INT NOT NULL REFERENCES scholars(id) ON DELETE CASCADE ON UPDATE CASCADE,
  term           VARCHAR(50) NOT NULL,
  amount         NUMERIC(12, 2),
  status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'processing', 'released', 'cancelled')),
  scheduled_date DATE,
  released_at    TIMESTAMPTZ,
  released_by    INT REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  reference_no   VARCHAR(100),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_disbursements_scholar ON disbursements(scholar_id);

-- 6. Renewal submissions (scholars submit grades each term).
CREATE TABLE IF NOT EXISTS renewal_submissions (
  id               SERIAL PRIMARY KEY,
  scholar_id       INT NOT NULL REFERENCES scholars(id) ON DELETE CASCADE ON UPDATE CASCADE,
  academic_year_id INT REFERENCES academic_years(id) ON DELETE SET NULL ON UPDATE CASCADE,
  term             VARCHAR(50) NOT NULL,
  gpa              NUMERIC(4, 2),
  grades_file_path VARCHAR(500),
  status           VARCHAR(20) NOT NULL DEFAULT 'submitted'
                     CHECK (status IN ('submitted', 'approved', 'rejected')),
  remarks          TEXT,
  reviewed_by      INT REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  reviewed_at      TIMESTAMPTZ,
  submitted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_renewals_scholar ON renewal_submissions(scholar_id);

-- 7. Leaderboard query support: rank candidates per program by score.
CREATE INDEX IF NOT EXISTS idx_applications_scholarship_score
  ON applications (scholarship_id, total_score DESC);
