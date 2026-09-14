/**
 * backfill-journal-company.mjs — attribute existing journal entries to a company.
 *
 * WHY
 * ---
 * `journal.repository.js#createEntry` did not include `company_id` in its column
 * list, so every entry written through it — invoices, receipts, payments, bills,
 * COGS, depreciation, across nine call sites — landed with a NULL company. Two
 * other writers (GST RCM self-invoice, opening-balance migration) had the same
 * gap.
 *
 * Every company-scoped financial report filters `je.company_id = $n`, so those
 * entries were invisible to the tenant that created them: the CFO dashboard
 * reported "no journal entries posted for this period" while nine posted entries
 * sat in the table, and net profit / EBITDA read "Not available".
 *
 * The writers are fixed. This attributes the rows already on disk.
 *
 * HOW IT DECIDES
 * --------------
 * 1. Follow `reference_type` / `reference_id` to the source document and take
 *    ITS company. This is evidence, not a guess.
 * 2. Failing that, take the company from the entry's own journal_lines, if they
 *    agree unanimously.
 * 3. Failing that, if the database contains exactly ONE company, use it — an
 *    unambiguous case that cannot attribute anything to the wrong tenant.
 * 4. Otherwise leave it NULL and report it. Guessing between tenants would be
 *    worse than leaving the row unattributed.
 *
 *   node scripts/audit/backfill-journal-company.mjs           # dry run
 *   node scripts/audit/backfill-journal-company.mjs --apply
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BACKEND = path.resolve(import.meta.dirname, '..', '..');
dotenv.config({ path: path.join(BACKEND, '.env'), quiet: true });
const pool = (await import(pathToFileURL(path.join(BACKEND, 'src/config/db.js')).href)).default;

const APPLY = process.argv.includes('--apply');

const SOURCE = {
  invoice: 'invoices',
  bill: 'bills',
  receipt: 'receipts',
  payment: 'payments',
  payment_transaction: 'payment_transactions',
  fixed_asset: 'fixed_assets',
  depreciation: 'fixed_assets',
  asset_disposal: 'fixed_assets',
  sales_order: 'sales_orders',
  purchase_order: 'purchase_orders',
  rcm_self_invoice: 'gst_self_invoices',
};

const { rows: companies } = await pool.query('SELECT id FROM companies ORDER BY id');
const soleCompany = companies.length === 1 ? companies[0].id : null;

const { rows: orphans } = await pool.query(
  `SELECT id, entry_number, entry_type, reference_type, reference_id
     FROM journal_entries WHERE company_id IS NULL ORDER BY id`);

const plan = [];
for (const e of orphans) {
  let cid = null;
  let via = null;

  const table = SOURCE[String(e.reference_type || '').toLowerCase()];
  if (table && e.reference_id != null) {
    const { rows } = await pool.query(
      `SELECT company_id FROM ${table} WHERE id = $1`, [e.reference_id]).catch(() => ({ rows: [] }));
    if (rows[0]?.company_id != null) { cid = rows[0].company_id; via = `${table}.company_id`; }
  }

  if (cid == null) {
    const { rows } = await pool.query(
      `SELECT DISTINCT company_id FROM journal_lines
        WHERE entry_id = $1 AND company_id IS NOT NULL`, [e.id]);
    if (rows.length === 1) { cid = rows[0].company_id; via = 'journal_lines (unanimous)'; }
  }

  if (cid == null && soleCompany != null) { cid = soleCompany; via = 'sole company in database'; }

  plan.push({ id: e.id, entry: e.entry_number, type: e.entry_type,
              ref: `${e.reference_type}:${e.reference_id}`, company_id: cid, via });
}

const resolvable = plan.filter((p) => p.company_id != null);
const unresolved = plan.filter((p) => p.company_id == null);

if (APPLY) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of resolvable) {
      await client.query('UPDATE journal_entries SET company_id = $1 WHERE id = $2 AND company_id IS NULL',
        [p.company_id, p.id]);
      // Lines inherit their entry's company where they have none of their own.
      await client.query(
        `UPDATE journal_lines SET company_id = $1 WHERE entry_id = $2 AND company_id IS NULL`,
        [p.company_id, p.id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const { rows: [after] } = await pool.query(
  `SELECT COUNT(*) FILTER (WHERE company_id IS NULL)::int AS entries_null,
          (SELECT COUNT(*) FILTER (WHERE company_id IS NULL)::int FROM journal_lines) AS lines_null
     FROM journal_entries`);

console.log('---REPORT_BEGIN---');
console.log(JSON.stringify({
  mode: APPLY ? 'apply' : 'dry-run',
  companies: companies.length,
  orphan_entries: orphans.length,
  resolvable: resolvable.length,
  unresolved: unresolved.length,
  remaining_null_entries: after.entries_null,
  remaining_null_lines: after.lines_null,
}));
console.log('---REPORT_END---');

if (!process.argv.includes('--json')) {
  console.error('');
  for (const p of plan) {
    console.error(`  ${p.entry.padEnd(8)} ${String(p.type).padEnd(14)} ${p.ref.padEnd(24)} -> ` +
      (p.company_id == null ? 'UNRESOLVED' : `company ${p.company_id}  (${p.via})`));
  }
  console.error(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${resolvable.length}/${orphans.length} attributable; ` +
    `${after.entries_null} entries and ${after.lines_null} lines still NULL`);
  if (!APPLY && resolvable.length) console.error('Re-run with --apply to write.');
}
await pool.end();
process.exit(unresolved.length ? 1 : 0);
