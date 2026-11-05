/**
 * backfill-employee-codes.mjs — assign an Employee ID to rows that have none.
 *
 *   node scripts/hr/backfill-employee-codes.mjs --report    # what is wrong today
 *   node scripts/hr/backfill-employee-codes.mjs --dry-run   # exact codes, writes nothing
 *   node scripts/hr/backfill-employee-codes.mjs --apply     # writes, inside one transaction
 *
 * ── Why a script and not a migration ────────────────────────────────────────
 * An Employee ID is printed on an ID card, quoted in an offer letter and typed
 * into payroll queries by people. Assigning them is a business decision with a
 * paper trail, not schema. `--report` and `--dry-run` exist so the list can be
 * read and approved before anything changes.
 *
 * ── What it will and will not touch ─────────────────────────────────────────
 * ONLY rows where office_id IS NULL or blank. An existing code is never
 * rewritten — renumbering someone who already has an ID is strictly worse than a
 * gap in the series, because everything printed or filed under the old number
 * silently stops matching.
 *
 * ⚠ This script minted 35 codes in the wrong format (`EMP-0013`…) when
 * `formatEmployeeCode` was wrong. It takes its format from
 * shared/employeeCode.js, so it is correct now that that module is — but the
 * lesson is that a backfill is only as right as the generator behind it, and a
 * dry run's output should be read against the codes ALREADY in the table, not
 * just checked for collisions. `renumber-employee-codes.mjs` repaired it.
 *
 * Codes are minted by `shared/employeeCode.js` — the same generator the API
 * uses — so the backfill continues the company's existing numbering instead of
 * opening a third one. Ordered by id, so the oldest employee gets the lowest
 * new code and the sequence reads chronologically.
 *
 * Idempotent: a second `--apply` finds nothing to do.
 */
import 'dotenv/config';
import pool from '../../src/config/db.js';
import { nextEmployeeCode, codeSeq, formatEmployeeCode, isValidEmployeeCode } from '../../src/shared/employeeCode.js';

const args = new Set(process.argv.slice(2));
const APPLY  = args.has('--apply');
const DRY    = args.has('--dry-run') || (!APPLY && !args.has('--report'));
const REPORT = args.has('--report') || DRY || APPLY;

const MISSING = `(office_id IS NULL OR TRIM(office_id) = '')`;

async function report() {
  const { rows: missing } = await pool.query(
    `SELECT COALESCE(company_id, 0) AS company_id, COUNT(*)::int AS n
       FROM employees WHERE ${MISSING} AND deleted_at IS NULL
      GROUP BY 1 ORDER BY 1`);
  const { rows: dupes } = await pool.query(
    `SELECT COALESCE(company_id, 0) AS company_id, LOWER(office_id) AS code, COUNT(*)::int AS n
       FROM employees WHERE office_id IS NOT NULL AND deleted_at IS NULL
      GROUP BY 1, 2 HAVING COUNT(*) > 1 ORDER BY n DESC`);
  const { rows: shapes } = await pool.query(
    `SELECT office_id FROM employees
      WHERE office_id IS NOT NULL AND deleted_at IS NULL ORDER BY id`);

  const nonCanonical = shapes.map(r => r.office_id).filter(c => !isValidEmployeeCode(c));

  console.log('\n── Employee ID integrity ─────────────────────────────────────');
  console.log(`missing (NULL or blank) : ${missing.reduce((n, r) => n + r.n, 0)}`);
  for (const r of missing) console.log(`   company ${r.company_id}: ${r.n}`);
  console.log(`duplicates              : ${dupes.length}`);
  for (const d of dupes) console.log(`   company ${d.company_id}: ${d.code} x${d.n}`);
  // There is no tolerated "legacy" shape any more: `^EMP[0-9]{3,}$` is the only
  // format, and the DB constraint enforces it. Anything listed here is a defect.
  console.log(`NOT in the EMP001 format : ${nonCanonical.length}${nonCanonical.length ? ` — ${nonCanonical.join(', ')}  (run renumber-employee-codes.mjs)` : ''}`);
  return { dupes };
}

async function plan(client) {
  const { rows } = await client.query(
    `SELECT id, company_id, first_name, last_name, company_email, department, designation
       FROM employees WHERE ${MISSING} AND deleted_at IS NULL
      ORDER BY COALESCE(company_id, 0), id`);
  if (!rows.length) return [];

  // One walking counter per company. Calling nextEmployeeCode() per row inside
  // a single transaction would return the SAME code every time — the rows it
  // reads its MAX() from are not committed yet, so the max never moves. Seed
  // once from the generator, then increment in memory.
  const seq = new Map();
  const out = [];
  for (const r of rows) {
    const key = r.company_id ?? 0;
    if (!seq.has(key)) {
      seq.set(key, codeSeq(await nextEmployeeCode(client, r.company_id ?? null)));
    }
    const n = seq.get(key);
    seq.set(key, n + 1);
    out.push({ ...r, code: formatEmployeeCode(n) });
  }
  return out;
}

const { dupes } = await report();

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const rows = await plan(client);

  if (!rows.length) {
    console.log('\nNothing to backfill — every employee already has an Employee ID.');
    await client.query('ROLLBACK');
  } else {
    console.log(`\n── ${APPLY ? 'Applying' : 'Would assign'} ${rows.length} Employee ID${rows.length === 1 ? '' : 's'} ──`);
    for (const r of rows) {
      const gaps = [!r.department && 'no dept', !r.designation && 'no role'].filter(Boolean);
      console.log(
        `  ${r.code}  id=${String(r.id).padEnd(5)} co=${String(r.company_id ?? '-').padEnd(5)} ` +
        `${`${r.first_name || ''} ${r.last_name || ''}`.trim().padEnd(22)} ${r.company_email || ''}` +
        (gaps.length ? `   [${gaps.join(', ')}]` : ''),
      );
    }

    if (APPLY) {
      if (dupes.length) {
        // Backfilling around an existing duplicate would hand out a code the
        // generator believes is free. Refuse rather than make it worse.
        throw new Error('Duplicate Employee IDs exist — resolve those before backfilling.');
      }
      for (const r of rows) {
        // `AND ${MISSING}` makes each write a compare-and-set: if another
        // process assigned a code since the plan was built, this row is skipped
        // rather than overwritten.
        const res = await client.query(
          `UPDATE employees SET office_id = $1, updated_at = NOW()
            WHERE id = $2 AND ${MISSING} RETURNING id`,
          [r.code, r.id],
        );
        if (!res.rowCount) console.log(`  ! id=${r.id} changed underneath the plan — skipped`);
      }
      await client.query('COMMIT');
      console.log(`\nCommitted. ${rows.length} rows updated.`);
      console.log('Employee IDs are already NOT NULL (20260928000003) and format-checked (20260928000004).');
    } else {
      await client.query('ROLLBACK');
      console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.');
    }
  }
} catch (err) {
  await client.query('ROLLBACK');
  console.error('\nFAILED (rolled back):', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
