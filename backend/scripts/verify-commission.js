import pool from '../src/config/db.js';

for (const tbl of ['commission_plans', 'commission_entries', 'commission_payouts']) {
  const c = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`,
    [tbl]
  );
  console.log(`\n${tbl}:`, c.rows.map(r => r.column_name).join(', '));
  const n = await pool.query(`SELECT COUNT(*) FROM ${tbl}`);
  console.log(`  rows: ${n.rows[0].count}`);
}

await pool.end();
