// Migration: add `token_version` column to users (JWT revocation).
// Idempotent — safe to run repeatedly (mirrors migrate_suspension.js style).
const pool = require('./src/config/db');

async function run() {
  try {
    console.log('Running token_version migration...');

    // Guard: only add the column if it is missing.
    const [cols] = await pool.query(
      "SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'token_version'"
    );
    if (cols[0]?.c === 0) {
      await pool.query('ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0');
      console.log('\u2713 Added users.token_version');
    } else {
      console.log('\u00b7 users.token_version already present');
    }

    console.log('Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

run();
