-- ============================================================
-- Migration 002 (slot-model v2): DB-level duplicate-application guard
-- Enforces "one ACTIVE application per student per program" in the
-- database itself (the app-level guard in Application.submit() has a
-- race window under concurrent submits).
-- ISOLATED FILE: if existing data violates the constraint this migration
-- fails alone and can be fixed without rolling back 001.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_applications_one_active
  ON applications (student_id, scholarship_id)
  WHERE status NOT IN ('rejected', 'withdrawn');
