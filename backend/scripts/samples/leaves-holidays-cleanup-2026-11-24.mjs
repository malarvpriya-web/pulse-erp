/**
 * Leaves / holidays data fixes, owner's decisions of 2026-11-24.
 *
 * Writes a JSON backup (+ .sha256) to ../_backups/leaves_2026-11-24/ FIRST, then
 * in one transaction, each change with an audit_logs row:
 *   1. deletes leave balances that sit on DELETED leave types (te1, Annual,
 *      Maternity, Compensatory Leave …) — shown nowhere, counted nowhere;
 *   2. the 20 Oct 2026 row named "Diwali" (Dussehra's date — the real Diwali,
 *      8 Nov, is its own row) becomes "Ayudha Pooja" on 19 Oct 2026;
 *   3. there are no optional / restricted holidays: such rows become 'Company'
 *      (a day off for everyone it covers).
 *
 * Run:  node scripts/samples/leaves-holidays-cleanup-2026-11-24.mjs [--dry]
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pool from '../../src/config/db.js';

const DRY = process.argv.includes('--dry');
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../../../_backups/leaves_2026-11-24');

async function main() {
  const { rows: balances } = await pool.query(`
    SELECT lb.* FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id
     WHERE lt.deleted_at IS NOT NULL ORDER BY lb.id`);
  const { rows: inUse } = await pool.query(`
    SELECT COUNT(*)::int AS n FROM leave_applications la JOIN leave_types lt ON lt.id = la.leave_type_id
     WHERE lt.deleted_at IS NOT NULL`);
  if (inUse[0].n) throw new Error(`${inUse[0].n} leave application(s) use a deleted type — not touching their balances.`);
  const { rows: diwali } = await pool.query(
    `SELECT * FROM holidays WHERE name = 'Diwali' AND date = '2026-10-20'`);
  const { rows: optional } = await pool.query(
    `SELECT * FROM holidays WHERE LOWER(type) IN ('optional', 'restricted') ORDER BY id`);

  console.log(`balances on deleted types: ${balances.length}; 20-Oct "Diwali": ${diwali.length}; optional/restricted holidays: ${optional.length}`);
  if (DRY) return;

  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `leaves-holidays-${Date.now()}.json`);
  const text = JSON.stringify({ taken_at: new Date().toISOString(), balances, diwali, optional }, null, 2);
  fs.writeFileSync(file, text);
  fs.writeFileSync(file + '.sha256', crypto.createHash('sha256').update(text).digest('hex') + '  ' + path.basename(file) + '\n');
  console.log('backup:', file);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [admin] } = await client.query(`
      SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
       WHERE LOWER(r.code) = 'super_admin' AND u.is_active = TRUE ORDER BY u.id LIMIT 1`);
    const audit = (module, action, ref, oldData, newData, co) => client.query(
      `INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type, old_data_json, new_data_json, company_id)
       VALUES ($1, $2, $3, $4, 'cleanup', $5, $6, $7) RETURNING id`,
      [admin?.id ?? null, module, action, ref, JSON.stringify(oldData), JSON.stringify(newData), co ?? null]);
    const ids = [];

    if (balances.length) {
      await client.query('DELETE FROM leave_balances WHERE id = ANY($1::int[])', [balances.map(b => b.id)]);
      ids.push((await audit('leaves', 'delete', null,
        { leave_balance_ids: balances.map(b => b.id), leave_type_ids: [...new Set(balances.map(b => b.leave_type_id))] },
        { reason: 'Balances on deleted leave types (owner, 2026-11-24)', backup: path.basename(file) }, 1)).rows[0].id);
    }
    for (const h of diwali) {
      await client.query(`UPDATE holidays SET name = 'Ayudha Pooja', date = '2026-10-19' WHERE id = $1`, [h.id]);
      ids.push((await audit('holidays', 'update', String(h.id), { name: h.name, date: '2026-10-20' },
        { name: 'Ayudha Pooja', date: '2026-10-19', reason: '"Diwali" on Dussehra\'s date — owner: Ayudha Pooja, 19 Oct', backup: path.basename(file) }, h.company_id)).rows[0].id);
    }
    for (const h of optional) {
      await client.query(`UPDATE holidays SET type = 'Company' WHERE id = $1`, [h.id]);
      ids.push((await audit('holidays', 'update', String(h.id), { type: h.type },
        { type: 'Company', reason: 'No optional holidays (owner, 2026-11-24)', backup: path.basename(file) }, h.company_id)).rows[0].id);
    }
    await client.query('COMMIT');
    console.log('audit_logs:', ids.join(', '));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

main().then(() => pool.end()).catch(async (e) => { console.error(e.message); await pool.end(); process.exit(1); });
