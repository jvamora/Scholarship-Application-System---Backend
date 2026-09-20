// Migration: add `deleted_at` column to users (soft delete).
// Idempotent — safe to run repeatedly.
const pool = require('./src/config/db');

async function run() {
  try {
    console.log('Running deleted_at migration...');

    const [cols] = await pool.query(
      "SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'deleted_at'"
    );
    if (cols[0]?.c === 0) {
      await pool.query('ALTER TABLE users ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL');
      console.log('\u2713 Added users.deleted_at');
    } else {
      console.log('\u00b7 users.deleted_at already present');
    }

    console.log('Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

run();
