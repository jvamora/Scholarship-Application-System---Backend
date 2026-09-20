// Debug: why does the transaction read see available_slots = 0?
require('dotenv').config();
const db = require('../src/config/database');

(async () => {
  const rnd = 'DBG' + Math.random().toString(36).slice(2, 8);
  const prog = await db.execute(
    `INSERT INTO scholarship_programs (name, slots, available_slots, deadline, status)
     VALUES ('ZZZ-DEBUG-' || ?, 2, 2, (CURRENT_DATE + INTERVAL '30 days')::date, 'open')`,
    [rnd]
  );
  const programId = prog.insertId;
  console.log('created programId =', programId);

  // Read OUTSIDE transaction (this works)
  const [outside] = await db.query(
    'SELECT id, available_slots FROM scholarship_programs WHERE id = ?', [programId]
  );
  console.log('OUTSIDE transaction read:', JSON.stringify(outside));

  // Read INSIDE transaction with FOR UPDATE (this is what runSelection does)
  await db.transaction(async (connection) => {
    const rows = await connection.query(
      'SELECT id, available_slots FROM scholarship_programs WHERE id = ? FOR UPDATE', [programId]
    );
    console.log('INSIDE transaction read:', JSON.stringify(rows));
    console.log('rows is array?', Array.isArray(rows), 'first row:', JSON.stringify(rows[0]));
  });

  await db.execute('DELETE FROM scholarship_programs WHERE id = ?', [programId]);
  console.log('cleaned up');
})().catch((e) => { console.error('FATAL:', e.stack); process.exit(1); });
