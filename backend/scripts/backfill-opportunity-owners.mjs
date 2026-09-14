/**
 * backfill-opportunity-owners.mjs — give unowned opportunities an owner and a
 * territory, using the system's OWN assignment rules.
 *
 * WHY
 * ---
 * Every opportunity in this database has `assigned_to = NULL`. The consequence
 * is not an error anywhere — it is that every rep-level view is empty:
 * /forecasting/by-rep shows one "Unassigned" row, a forecast submission has no
 * deals behind it, territory attainment reads zero, and "my pipeline" is blank
 * for everyone.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not invent an owner. It runs `resolveAssignment()` — the same resolver
 * a newly captured lead goes through — so the answer is whatever the configured
 * rules say:
 *
 *   1. crm_assignment_rules, if any match
 *   2. the matching sales territory's owner
 *   3. round-robin across employees holding sales_exec / sales_manager
 *
 * Geography comes from the opportunity's originating LEAD (zone, location,
 * industry), because that is where the record's real location lives — an
 * opportunity row carries only `region`, and it is null on every row here.
 *
 * CLOSED DEALS ARE SKIPPED by default. Assigning an owner to a deal that was
 * won or lost months ago attributes someone else's outcome to them, and every
 * historical rep metric shifts. `--include-closed` overrides that deliberately.
 *
 *   node backend/scripts/backfill-opportunity-owners.mjs           # dry run
 *   node backend/scripts/backfill-opportunity-owners.mjs --apply
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const pool = (await import('../src/config/db.js')).default;
const { resolveAssignment } = await import('../src/modules/crm/services/leadAssignment.service.js');

const APPLY = process.argv.includes('--apply');
const INCLUDE_CLOSED = process.argv.includes('--include-closed');

const { rows: opps } = await pool.query(`
  SELECT o.id, o.opportunity_name, o.stage, o.expected_value, o.company_id,
         o.assigned_to, o.territory_id,
         l.zone, l.location, l.industry, l.assigned_to AS lead_owner,
         a.name AS account_name
    FROM opportunities o
    LEFT JOIN leads l    ON l.id = o.lead_id
    LEFT JOIN accounts a ON a.id = o.account_id
   WHERE o.deleted_at IS NULL
     AND (o.assigned_to IS NULL OR o.territory_id IS NULL)
   ORDER BY o.id
`);

if (!opps.length) {
  console.log('Nothing to do — every live opportunity already has an owner and a territory.');
  await pool.end();
  process.exit(0);
}

const plan = [];
for (const o of opps) {
  const closed = ['won', 'lost'].includes(String(o.stage ?? '').toLowerCase());
  if (closed && !INCLUDE_CLOSED) {
    plan.push({ ...o, action: 'skip', reason: `stage is ${o.stage} — pass --include-closed to assign it anyway` });
    continue;
  }

  // The lead's own owner wins if it has one: whoever worked the enquiry owns the
  // deal it became, regardless of what the rules would say today.
  if (o.lead_owner != null && o.assigned_to == null) {
    plan.push({ ...o, action: 'assign', owner: o.lead_owner, territory: o.territory_id, source: 'inherited from the lead' });
    continue;
  }

  let resolved = { assigned_to: null, territory_id: null, source: 'unresolved' };
  try {
    resolved = await resolveAssignment(o.company_id, 'round_robin', {
      zone: o.zone, location: o.location, industry: o.industry,
    });
  } catch (err) {
    plan.push({ ...o, action: 'error', reason: err.message });
    continue;
  }

  if (resolved.assigned_to == null && resolved.territory_id == null) {
    plan.push({ ...o, action: 'skip', reason: 'no rule, no territory and no eligible sales employee matched' });
  } else {
    plan.push({
      ...o, action: 'assign',
      owner: o.assigned_to ?? resolved.assigned_to,
      territory: o.territory_id ?? resolved.territory_id,
      source: resolved.source,
    });
  }
}

// Names, so the plan is readable rather than a list of ids.
const empIds = [...new Set(plan.map(p => p.owner).filter(v => v != null))];
const terrIds = [...new Set(plan.map(p => p.territory).filter(v => v != null))];
const names = new Map();
if (empIds.length) {
  const { rows } = await pool.query(`SELECT id, name FROM employees WHERE id = ANY($1::int[])`, [empIds]);
  rows.forEach(r => names.set(`e${r.id}`, r.name));
}
if (terrIds.length) {
  const { rows } = await pool.query(`SELECT id, name FROM sales_territories WHERE id = ANY($1::int[])`, [terrIds]);
  rows.forEach(r => names.set(`t${r.id}`, r.name));
}

console.log(`${opps.length} opportunit${opps.length === 1 ? 'y' : 'ies'} without a complete assignment:\n`);
for (const p of plan) {
  const where = [p.zone, p.location].filter(Boolean).join(' / ') || 'no geography on the lead';
  if (p.action === 'assign') {
    console.log(`  ASSIGN  #${String(p.id).padEnd(5)} ${String(p.opportunity_name).slice(0, 34).padEnd(34)} ${where.padEnd(22)}`);
    console.log(`          owner -> ${names.get(`e${p.owner}`) ?? p.owner ?? '(none)'}   territory -> ${names.get(`t${p.territory}`) ?? p.territory ?? '(none)'}   [${p.source}]`);
  } else {
    console.log(`  ${p.action.toUpperCase().padEnd(6)}  #${String(p.id).padEnd(5)} ${String(p.opportunity_name).slice(0, 34).padEnd(34)} ${p.reason}`);
  }
}

const toApply = plan.filter(p => p.action === 'assign');
if (!APPLY) {
  console.log(`\nDry run — ${toApply.length} would be updated. Pass --apply to write.`);
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
let n = 0;
try {
  await client.query('BEGIN');
  for (const p of toApply) {
    // COALESCE so an owner or territory already set is never overwritten.
    const { rowCount } = await client.query(
      `UPDATE opportunities
          SET assigned_to  = COALESCE(assigned_to, $1),
              territory_id = COALESCE(territory_id, $2),
              updated_at   = NOW()
        WHERE id = $3 AND deleted_at IS NULL`,
      [p.owner ?? null, p.territory ?? null, p.id]
    );
    n += rowCount;
  }
  await client.query('COMMIT');
  console.log(`\nUpdated ${n} opportunit${n === 1 ? 'y' : 'ies'}.`);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('FAILED —', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
