const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME}`;
const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

// Helper to convert mysql2 style ? placeholders to pg style $1, $2, etc.
// Also automatically appends 'RETURNING id' to INSERT statements if not present.
function convertSql(sql) {
  let converted = sql;
  let index = 1;
  converted = converted.replace(/\?/g, () => `$${index++}`);
  
  if (converted.trim().toLowerCase().startsWith('insert') && !converted.toLowerCase().includes('returning')) {
    converted = converted.trim();
    if (converted.endsWith(';')) {
      converted = converted.slice(0, -1) + ' RETURNING id;';
    } else {
      converted = converted + ' RETURNING id';
    }
  }
  return converted;
}


// Expand any Array parameter inside `?` placeholders into a Postgres
// $1, $2, ... list so mysql2-style callers (passing an `ids` array to
// pool.query(... WHERE id IN (?), [ids])) work against node-pg.
function expandInArrays(sql, params) {
  const p = Array.isArray(params) ? params : [];
  if (p.length === 0 || !p.some(x => Array.isArray(x))) return { sql, params };
  const out = [];
  const newParams = [];
  let paramIndex = 0;
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inStr) {
      out.push(ch);
      if (ch === String.fromCharCode(92)) { out.push(sql[++i]); continue; }
      if (ch === String.fromCharCode(39)) {
        if (sql[i + 1] === String.fromCharCode(39)) { out.push(sql[++i]); } else inStr = false;
      }
      continue;
    }
    if (ch === String.fromCharCode(39)) { inStr = true; out.push(ch); continue; }
    if (ch === String.fromCharCode(63)) { /* ? */
      const val = p[paramIndex] === undefined ? null : p[paramIndex];
      if (Array.isArray(val)) {
        val.forEach((v, j) => { newParams.push(v); out.push(String.fromCharCode(36) + newParams.length); if (j < val.length - 1) out.push(String.fromCharCode(44) + String.fromCharCode(32)); });
      } else {
        newParams.push(val);
        out.push(String.fromCharCode(36) + newParams.length);
      }
      paramIndex++;
    } else { out.push(ch); }
  }
    return { sql: out.join(''), params: newParams };
}

// Override query to emulate mysql2's return structure: [rows, fields]
const originalQuery = pool.query.bind(pool);
pool.query = async function (sql, params = []) {
  const expanded = expandInArrays(sql, params);
  const convertedSql = convertSql(expanded.sql);
  const res = await originalQuery(convertedSql, expanded.params);
  
  const trimmed = sql.trim().toLowerCase();
  const isInsert = trimmed.startsWith('insert');
  const isUpdateOrDelete = trimmed.startsWith('update') || trimmed.startsWith('delete');
  
  if (isInsert || isUpdateOrDelete) {
    const insertId = res.rows && res.rows[0] ? (res.rows[0].id || null) : null;
    const resultHeader = {
      affectedRows: res.rowCount,
      insertId: insertId
    };
    return [resultHeader, null];
  }
  
  return [res.rows, null];
};

// Test connection
const testConnection = async () => {
  try {
    const res = await originalQuery('SELECT NOW()');
    console.log('✅ Database connected successfully via pg:', res.rows[0].now);
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
  }
};

testConnection();

pool.expandInArrays = expandInArrays;
module.exports = pool;
