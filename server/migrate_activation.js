const pool = require('./src/config/db');

async function run() {
  try {
    console.log('Running activation migrations...');
    
    // Modify status enum
    await pool.query(`
      ALTER TABLE users 
      MODIFY COLUMN status ENUM('pending', 'approved', 'rejected', 'activated') NOT NULL DEFAULT 'pending'
    `);
    console.log('✓ Modified status column enum');

    // Add is_first_login
    try {
      await pool.query(`
        ALTER TABLE users 
        ADD COLUMN is_first_login TINYINT(1) NOT NULL DEFAULT 1
      `);
      console.log('✓ Added is_first_login column');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME' || e.code === 'ER_DUP_COLUMN_NAME') {
        console.log('is_first_login column already exists');
      } else {
        throw e;
      }
    }

    // Add activated_at
    try {
      await pool.query(`
        ALTER TABLE users 
        ADD COLUMN activated_at TIMESTAMP NULL DEFAULT NULL
      `);
      console.log('✓ Added activated_at column');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME' || e.code === 'ER_DUP_COLUMN_NAME') {
        console.log('activated_at column already exists');
      } else {
        throw e;
      }
    }

    console.log('Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

run();
