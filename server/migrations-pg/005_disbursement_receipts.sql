-- ============================================================
-- Migration 005: Walk-in proof of receipt for disbursements.
--
-- The ledger (001) records the RELEASE of funds (money out). A walk-in
-- payout also needs the RECEIVING half of the paper trail:
--   • who physically collected the cash at the counter (scholar or an
--     authorized representative) and whether their ID was checked
--   • whether the scholar themselves later confirmed receipt in-app
--     (an independent, non-repudiable acknowledgment).
--
-- Both halves are additive — existing rows keep claiming 'self' with no
-- acknowledgment, so the staff ledger and its totals are unaffected.
-- Idempotent (safe to re-run). Apply with: node scripts/migrate-pg.js
-- ============================================================

-- 1. Counter record captured by staff at release time.
ALTER TABLE disbursements
  ADD COLUMN IF NOT EXISTS claimed_by       VARCHAR(20) NOT NULL DEFAULT 'self',
  ADD COLUMN IF NOT EXISTS recipient_name   VARCHAR(150),
  ADD COLUMN IF NOT EXISTS claimant_id_note VARCHAR(200),
  ADD COLUMN IF NOT EXISTS id_verified      BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Scholar self-service acknowledgment ("I received these funds").
ALTER TABLE disbursements
  ADD COLUMN IF NOT EXISTS acknowledged_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_signature VARCHAR(150),
  ADD COLUMN IF NOT EXISTS acknowledged_by        INT;

-- 3. Constraints (added conditionally so the file stays re-runnable).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'disbursements_claimed_by_check'
  ) THEN
    ALTER TABLE disbursements
      ADD CONSTRAINT disbursements_claimed_by_check
      CHECK (claimed_by IN ('self', 'representative'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'disbursements_acknowledged_by_fkey'
  ) THEN
    ALTER TABLE disbursements
      ADD CONSTRAINT disbursements_acknowledged_by_fkey
      FOREIGN KEY (acknowledged_by) REFERENCES users(id)
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 4. Scholar-side "awaiting my confirmation" lookups.
CREATE INDEX IF NOT EXISTS idx_disbursements_acknowledgment
  ON disbursements (status, acknowledged_at);
