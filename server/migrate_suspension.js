// Suspension migration: extends users.status enum with 'suspended'.
// Idempotent — safe to run repeatedly (mirrors migrate_activation.js style).
const pool = require('./src/config/db');

async function run() {
  try {
    console.log('Running suspension migrations...');

    await pool.query(`
      ALTER TABLE users
      MODIFY COLUMN status ENUM('pending', 'approved', 'rejected', 'activated', 'suspended') NOT NULL DEFAULT 'pending'
    `);
    console.log('✓ Modified status column enum (added suspended)');

    console.log('Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

run();
