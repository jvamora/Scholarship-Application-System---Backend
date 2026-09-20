const dotenv = require('dotenv');
dotenv.config({ path: __dirname + '/.env' });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'scholarship', 'database', 'migrations', 'supabase_schema.sql');
const connectionString = process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME}`;
const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

async function run() {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');

  // Extract CREATE TABLE statements
  const tableRegex = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\)\s*;/g;
  const tables = {};
  let m;
  while ((m = tableRegex.exec(sql)) !== null) {
    const name = m[1];
    const body = m[2];
    const cols = [];
    body.split('\n').forEach(line => {
      line = line.trim().replace(/,$/, '').trim();
      if (!line || /PRIMARY KEY|FOREIGN KEY|UNIQUE|REFERENCES|CONSTRAINT/i.test(line)) return;
      const cm = line.match(/^(\w+)\s+/);
      if (cm) cols.push(cm[1]);
    });
    tables[name] = cols;
  }

  // Query live table list
  const res = await pool.query(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('spatial_ref_sys','schema_migrations','supabase_functions','supabase_migrations') ORDER BY tablename;
  `);
  const liveTables = res.rows.map(r => r.tablename);

  const missing = Object.keys(tables).filter(t => !liveTables.includes(t));
  const extra = liveTables.filter(t => !tables[t]);

  console.log('=== SCHEMA PARITY CHECK ===');
  console.log('Tables in SQL file:', Object.keys(tables).length);
  console.log('Tables live in DB:', liveTables.length);
  console.log('Missing:', missing);
  console.log('Extra/unexpected:', extra);

  // Check enums
  const enumRes = await pool.query(`
    SELECT typname FROM pg_type WHERE typtype = 'e' AND typname IN ('user_role','user_status','student_gender','scholarship_status','application_status','committee_recommendation','notification_type') ORDER BY typname;
  `);
  const liveEnums = enumRes.rows.map(r => r.typname);
  console.log('\n=== ENUM CHECK ===');
  console.log('Expected enums: 7');
  console.log('Live enums found:', liveEnums.length);
  const expectedEnums = ['application_status','committee_recommendation','notification_type','scholarship_status','student_gender','user_role','user_status'];
  const missingEnums = expectedEnums.filter(e => !liveEnums.includes(e));
  console.log('Missing enums:', missingEnums);

  // Column-level check on key tables
  console.log('\n=== COLUMN CHECK (key tables) ===');
  const keyTables = ['users', 'students', 'colleges', 'courses', 'academic_years', 'scholarship_programs', 'requirements', 'applications', 'committee_reviews', 'notifications'];
  for (const tbl of keyTables) {
    if (!tables[tbl]) {
      console.log(`Table ${tbl}: NOT in SQL file`);
      continue;
    }
    const q = await pool.query(`
      SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position;
    `, [tbl]);
    const liveCols = q.rows.map(r => r.column_name);
    const fileCols = tables[tbl];
    const missingCols = fileCols.filter(c => !liveCols.includes(c));
    const extraCols = liveCols.filter(c => !fileCols.includes(c));
    if (missingCols.length === 0 && extraCols.length === 0) {
      console.log(`Table ${tbl}: MATCH (${fileCols.length} cols)`);
    } else {
      console.log(`Table ${tbl}: MISMATCH`);
      if (missingCols.length) console.log(`  Missing: ${missingCols.join(', ')}`);
      if (extraCols.length) console.log(`  Extra: ${extraCols.join(', ')}`);
    }
  }

  // Final verdict
  const tableMatch = missing.length === 0 && extra.length === 0;
  const enumMatch = missingEnums.length === 0;
  const allGood = tableMatch && enumMatch;
  console.log('\n=== FINAL VERDICT ===');
  console.log(allGood ? 'PASS: Schema fully matches live database!' : 'FAIL: Mismatches detected!');

  await pool.end();
}

run().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});