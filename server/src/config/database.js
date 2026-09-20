const pool = require('./db');
const { expandInArrays } = pool;

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

// Test the database connection
const testConnection = async () => {
  try {
    const client = await pool.connect();
    console.log('✅ Database connected successfully (database.js)');
    client.release();
    return true;
  } catch (error) {
    console.error('❌ Database connection failed (database.js):', error.message);
    return false;
  }
};

// Query helper function (returns rows array directly)
const query = async (sql, params = []) => {
  const { sql: _eSql, params: _eParams } = expandInArrays(sql, params);
  const convertedSql = convertSql(_eSql);
  // Using original query from Pool since our overridden query returns [rows, fields]
  const client = await pool.connect();
  try {
    const res = await client.query(convertedSql, _eParams);
    return res.rows;
  } finally {
    client.release();
  }
};

// Execute helper function for INSERT/UPDATE/DELETE
const execute = async (sql, params = []) => {
  const { sql: _eSql, params: _eParams } = expandInArrays(sql, params);
  const convertedSql = convertSql(_eSql);
  const client = await pool.connect();
  try {
    const res = await client.query(convertedSql, _eParams);
    const insertId = res.rows && res.rows[0] ? (res.rows[0].id || null) : null;
    return {
      affectedRows: res.rowCount,
      insertId: insertId
    };
  } finally {
    client.release();
  }
};

// Transaction helper
const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // We pass a custom connection wrapper to callback so that it executes
    // queries inside the same transaction client.
    const transConnection = {
      query: async (sql, params = []) => {
        const { sql: _eSql, params: _eParams } = expandInArrays(sql, params);
  const convertedSql = convertSql(_eSql);
        const res = await client.query(convertedSql, _eParams);
        // Emulate mysql2 [result, fields] shape (mirrors pool.query override in db.js):
        // writes return a { affectedRows, insertId } header; reads return rows.
        const firstWord = sql.trim().split(/\s+/)[0]?.toLowerCase();
        if (firstWord === 'insert' || firstWord === 'update' || firstWord === 'delete') {
          const insertId = res.rows && res.rows[0] ? (res.rows[0].id || null) : null;
          return [{ affectedRows: res.rowCount, insertId }, null];
        }
        return [res.rows, null];
      },
      execute: async (sql, params = []) => {
        const { sql: _eSql, params: _eParams } = expandInArrays(sql, params);
  const convertedSql = convertSql(_eSql);
        const res = await client.query(convertedSql, _eParams);
        const insertId = res.rows && res.rows[0] ? (res.rows[0].id || null) : null;
        return {
          affectedRows: res.rowCount,
          insertId: insertId
        };
      }
    };

    const result = await callback(transConnection);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  pool,
  testConnection,
  query,
  execute,
  transaction,
};
