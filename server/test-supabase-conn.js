require('dotenv').config({ path: __dirname + '/.env' });
const pool = require('./src/config/db');

async function run() {
  try {
    console.log('Testing Supabase PostgreSQL connection...');
    const [rows] = await pool.query('SELECT NOW() as current_time');
    console.log('Successfully queried database! Current server time:', rows[0].current_time);
    process.exit(0);
  } catch (error) {
    console.error('Supabase query failed:', error.message);
    process.exit(1);
  }
}

run();
