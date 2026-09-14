/**
 * e2e-lead-to-cash-cleanup.mjs — remove the rows e2e-lead-to-cash.mjs created.
 *
 * The end-to-end run drives the real API against the real database, so it
 * leaves real records behind. Everything it creates is tagged `E2E<digits>` in
 * its name, which is what this deletes — nothing else is touched, and the
 * pattern is anchored so a customer legitimately named "E2E Systems" cannot be
 * caught by it.
 *
 * Deletion order follows the FK graph inward-out; a single transaction so a
 * failure part-way leaves nothing half-removed.
 *
 *   node backend/scripts/e2e-lead-to-cash-cleanup.mjs          # report only
 *   node backend/scripts/e2e-lead-to-cash-cleanup.mjs --apply  # actually delete
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const pool = (await import('../src/config/db.js')).default;

const APPLY = process.argv.includes('--apply');
// Anchored: matches E2E followed by digits at the START of a name, which is the
// shape the harness generates. A substring match would sweep up real records.
const TAG = '^E2E[0-9]{4,}';

const client = await pool.connect();
try {
  await client.query('BEGIN');

  const counts = {};
  const q = async (label, sql, params = []) => {
    const { rows } = await client.query(sql, params);
    counts[label] = rows.length ? Number(rows[0].count ?? rows.length) : 0;
    return rows;
  };

  await q('leads',         `SELECT COUNT(*)::int AS count FROM leads WHERE company_name ~ $1`, [TAG]);
  await q('opportunities', `SELECT COUNT(*)::int AS count FROM opportunities WHERE opportunity_name ~ $1`, [TAG]);
  await q('quotations',    `SELECT COUNT(*)::int AS count FROM quotations WHERE customer_name ~ $1`, [TAG]);
  await q('accounts',      `SELECT COUNT(*)::int AS count FROM accounts WHERE name ~ $1`, [TAG]);
  await q('parties',       `SELECT COUNT(*)::int AS count FROM parties WHERE name ~ $1`, [TAG]);
  await q('tickets',       `SELECT COUNT(*)::int AS count FROM support_tickets WHERE title ~ $1`, [TAG]);
  await q('workflow_rules',`SELECT COUNT(*)::int AS count FROM workflow_rules WHERE name ~ $1`, [TAG]);

  console.log('Rows matching the E2E tag:');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(16)} ${v}`);

  if (!APPLY) {
    await client.query('ROLLBACK');
    console.log('\nDry run — pass --apply to delete.');
  } else {
    // Children first. sales_orders/quotations reference opportunities, and the
    // opportunity FK is not ON DELETE CASCADE.
    await client.query(`DELETE FROM workflow_run_logs WHERE workflow_id IN (SELECT id FROM workflow_rules WHERE name ~ $1)`, [TAG]);
    await client.query(`DELETE FROM workflow_rules WHERE name ~ $1`, [TAG]);
    await client.query(`DELETE FROM notifications WHERE title ~ $1 OR message ~ $1`, [TAG]);
    await client.query(`DELETE FROM ticket_comments WHERE ticket_id IN (SELECT id FROM support_tickets WHERE title ~ $1)`, [TAG]);
    await client.query(`DELETE FROM support_tickets WHERE title ~ $1`, [TAG]);

    await client.query(`DELETE FROM sales_order_items WHERE order_id IN (
      SELECT so.id FROM sales_orders so LEFT JOIN quotations q ON q.id = so.quotation_id
       WHERE so.customer_name ~ $1 OR q.customer_name ~ $1)`, [TAG]);
    await client.query(`DELETE FROM sales_orders WHERE customer_name ~ $1
       OR quotation_id IN (SELECT id FROM quotations WHERE customer_name ~ $1)`, [TAG]);
    await client.query(`DELETE FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE customer_name ~ $1)`, [TAG]);
    await client.query(`DELETE FROM quotations WHERE customer_name ~ $1`, [TAG]);

    await client.query(`DELETE FROM projects WHERE opportunity_id IN (SELECT id FROM opportunities WHERE opportunity_name ~ $1)`, [TAG]);
    await client.query(`DELETE FROM opportunity_stage_history WHERE opportunity_id IN (SELECT id FROM opportunities WHERE opportunity_name ~ $1)`, [TAG]);
    await client.query(`DELETE FROM opportunities WHERE opportunity_name ~ $1`, [TAG]);

    await client.query(`DELETE FROM lead_activities WHERE lead_id IN (SELECT id FROM leads WHERE company_name ~ $1)`, [TAG]);
    await client.query(`DELETE FROM leads WHERE company_name ~ $1`, [TAG]);

    await client.query(`DELETE FROM contacts WHERE account_id IN (SELECT id FROM accounts WHERE name ~ $1)`, [TAG]);
    await client.query(`DELETE FROM accounts WHERE name ~ $1`, [TAG]);
    await client.query(`DELETE FROM parties WHERE name ~ $1`, [TAG]);

    await client.query('COMMIT');
    console.log('\nDeleted.');
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('FAILED —', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
