-- ============================================================
-- Migration 004 (staff applicant fields): name suffix + student ID.
-- Adds optional name_suffix (e.g. Jr., Sr., III) and the applicant's
-- manually-entered Student ID (student_number) to the users table,
-- captured by staff at account-credential creation time.
--
-- Isolated/idempotent: uses ADD COLUMN IF NOT EXISTS / CREATE INDEX IF
-- NOT EXISTS so it is safe to re-run.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS name_suffix    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS student_number VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_users_student_number ON users(student_number);