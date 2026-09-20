const pool = require('./src/config/db');

async function test() {
  try {
    const [rows] = await pool.query('DESCRIBE users');
    console.log('Columns in users:', rows);
    const [createTable] = await pool.query('SHOW CREATE TABLE users');
    console.log('Create table users:', createTable[0]);
    process.exit(0);
  } catch (error) {
    console.error('Database test failed:', error.message);
    process.exit(1);
  }
}

test();
