-- ============================================================
-- Migration 003 (weighted component scoring): near-zero ties.
-- Adds per-review weighted sub-scores to committee_reviews (academics
-- 40%, financial need 30%, statement 30%) so an application's total
-- score is precise rather than a rounded integer — making exact ties
-- statistically negligible. Also adds a precise total-score column to
-- applications that ranking sorts on.
--
-- Isolated/idempotent: uses ADD COLUMN IF NOT EXISTS / CREATE INDEX IF
-- NOT EXISTS so it is safe to re-run.
-- ============================================================

-- Per-reviewer weighted component scores (1-5 each; UI sends stars).
ALTER TABLE committee_reviews
  ADD COLUMN IF NOT EXISTS academics_score  DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS need_score       DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS statement_score  DECIMAL(5,2);

-- Precise application-level score (0-100 at 4 decimal places) derived from
-- the weighted average of all reviewers' composites. Ranking sorts on this
-- instead of the rounded legacy total_score.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS total_score_precise DECIMAL(8,4);

CREATE INDEX IF NOT EXISTS idx_applications_scholarship_precise
  ON applications (scholarship_id, total_score_precise DESC);