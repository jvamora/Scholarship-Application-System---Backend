// Phase 0 — Runtime verification of the transaction layer against the live
// Postgres (Supabase) database. Proves (or disproves) that:
//   1. The project's transaction() helper commits atomically.
//   2. The transaction() helper rolls back completely on error.
//   3. The raw-pool BEGIN/COMMIT pattern (used by committeeRoutes review) works.
//   4. Raw BEGIN + forced error rolls back (the promote-endpoint pattern, fixed).
//   5. `?` placeholder conversion and IN (?) array expansion behave.
//   6. pool.getConnection() does NOT exist on pg (documents the broken promote).
// Creates a throwaway table, cleans up after itself, exits 0 on success.
require('dotenv').config();
const db = require('../src/config/database'); // { pool, query, execute, transaction }
const shimPool = require('../src/config/db'); // the shimmed pg pool itself

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

(async () => {
  await db.execute(`CREATE TABLE IF NOT EXISTS _txn_smoke_test (
    id SERIAL PRIMARY KEY,
    label TEXT
  )`);

  // ---- 1. transaction() helper: COMMIT persists ----
  try {
    await db.transaction(async (conn) => {
      await conn.execute(`INSERT INTO _txn_smoke_test (label) VALUES (?)`, ['helper-commit-a']);
      await conn.execute(`INSERT INTO _txn_smoke_test (label) VALUES (?)`, ['helper-commit-b']);
    });
    const [row] = await db.query(
      `SELECT COUNT(*)::int AS c FROM _txn_smoke_test WHERE label LIKE 'helper-commit-%'`
    );
    record('transaction() helper COMMIT persists rows', row.c === 2, `${row.c} rows visible`);
  } catch (e) {
    record('transaction() helper COMMIT persists rows', false, e.message);
  }

  // ---- 2. transaction() helper: error forces full ROLLBACK ----
  try {
    await db.transaction(async (conn) => {
      await conn.execute(`INSERT INTO _txn_smoke_test (label) VALUES (?)`, ['helper-rollback']);
      throw new Error('forced-rollback');
    });
    record('transaction() helper ROLLBACK on throw', false, 'callback error was swallowed');
  } catch (e) {
    if (e.message === 'forced-rollback') {
      const [row] = await db.query(
        `SELECT COUNT(*)::int AS c FROM _txn_smoke_test WHERE label = 'helper-rollback'`
      );
      record('transaction() helper ROLLBACK on throw', row.c === 0, `${row.c} rows after rollback`);
    } else {
      record('transaction() helper ROLLBACK on throw', false, `unexpected error: ${e.message}`);
    }
  }

  // ---- 3. raw client BEGIN/COMMIT (review-endpoint pattern) ----
  {
    const client = await shimPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO _txn_smoke_test (label) VALUES ($1)`, ['raw-commit']);
      await client.query('COMMIT');
      const [row] = await db.query(
        `SELECT COUNT(*)::int AS c FROM _txn_smoke_test WHERE label = 'raw-commit'`
      );
      record('raw client BEGIN/COMMIT (review pattern)', row.c === 1, `${row.c} rows visible`);
    } catch (e) {
      record('raw client BEGIN/COMMIT (review pattern)', false, e.message);
    } finally {
      client.release();
    }
  }

  // ---- 4. raw client BEGIN + forced error + ROLLBACK ----
  {
    const client = await shimPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO _txn_smoke_test (label) VALUES ($1)`, ['raw-rollback']);
      await client.query(`INSERT INTO _txn_smoke_test (no_such_column) VALUES ($1)`, ['x']); // force error
      await client.query('COMMIT');
      record('raw client rollback-on-error', false, 'error was not raised');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
      const [row] = await db.query(
        `SELECT COUNT(*)::int AS c FROM _txn_smoke_test WHERE label = 'raw-rollback'`
      );
      record('raw client rollback-on-error', row.c === 0, `${row.c} rows after rollback`);
    } finally {
      client.release();
    }
  }

  // ---- 5. ? placeholder conversion + IN (?) array expansion ----
  try {
    await db.execute(`INSERT INTO _txn_smoke_test (label) VALUES (?)`, ['ph-test']);
    const rows = await db.query(`SELECT id FROM _txn_smoke_test WHERE label = ?`, ['ph-test']);
    record('? placeholder conversion (query/execute)', rows.length === 1, `${rows.length} row`);
    const ids = rows.map((r) => r.id);
    const [row2] = await db.query(
      `SELECT COUNT(*)::int AS c FROM _txn_smoke_test WHERE id IN (?)`, [ids]
    );
    record('IN (?) array expansion', Number(row2.c) === ids.length, `${row2.c}/${ids.length}`);
  } catch (e) {
    record('? placeholder / IN (?) tests', false, e.message);
  }

  // ---- 6. pool.getConnection() must NOT exist (documents promote bug) ----
  record(
    'pool.getConnection() absent on pg pool (promote endpoint bug confirmed)',
    typeof shimPool.getConnection !== 'function',
    typeof shimPool.getConnection
  );

  // ---- cleanup ----
  await db.execute(`DROP TABLE IF EXISTS _txn_smoke_test`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} checks passed ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
