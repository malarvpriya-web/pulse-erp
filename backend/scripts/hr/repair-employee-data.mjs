/**
 * repair-employee-data.mjs — the data defects that are safe to fix without a
 * business decision.
 *
 *   node scripts/hr/repair-employee-data.mjs [--dry-run|--apply] [companyId]
 *
 * Dry-run by default. Every repair below is one where the CORRECT value is
 * determinable from the data itself, not guessed. Anything needing an HR
 * decision is deliberately absent — see §22 of
 * ALL_EMPLOYEES_DATA_INTEGRITY_AUDIT.md for the classification.
 *
 * Repair 1 — sentinel text in reporting_manager
 *   The column holds the four-character STRING 'null' on some rows, written by an
 *   older revision of the Add Employee form that stringified a null before
 *   POSTing. It is not a manager's name; the correct value is SQL NULL. Nothing
 *   is lost, because nothing was ever there.
 *
 * Repair 2 — self-managing employee
 *   `reporting_manager_id = id`. The correct value is NULL: the top of a
 *   hierarchy has no manager, and an employee reporting to themselves is
 *   definitionally wrong rather than merely unknown. Applied ONLY where the
 *   employee is plausibly the top of the org — no other employee reports to
 *   their manager's manager, i.e. they have no manager above them to restore.
 *   If a real manager might have been overwritten, the row is reported and
 *   skipped rather than guessed at.
 *
 * Repair 3 — denormalised manager NAME disagreeing with the FK
 *   `reporting_manager_id` is canonical. Where the name column names someone
 *   other than that person, the name is stale and is rewritten from the FK.
 *   Where there is no FK, the name is left alone — it is the only record of the
 *   relationship on rows that predate the FK column.
 */
import 'dotenv/config';
import pool from '../../src/config/db.js';
import { findHierarchyDefects } from '../../src/shared/employeeHierarchy.js';

const args = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const APPLY = args.has('--apply');
const COMPANY_ID = positional[0] ? Number(positional[0]) : null;

const scope = COMPANY_ID == null ? '' : ' AND ($1::int IS NULL OR company_id = $1)';
const params = COMPANY_ID == null ? [] : [COMPANY_ID];

const SENTINELS = ['null', 'undefined', 'nan'];

const client = await pool.connect();
let changed = 0;

try {
  await client.query('BEGIN');

  // ── Repair 1 ───────────────────────────────────────────────────────────────
  const { rows: sentinelRows } = await client.query(
    `SELECT id, office_id, reporting_manager FROM employees
      WHERE LOWER(TRIM(reporting_manager)) = ANY($${params.length + 1}::text[])${scope}
      ORDER BY id`,
    [...params, SENTINELS],
  );
  console.log(`\n── 1. reporting_manager holding sentinel text: ${sentinelRows.length}`);
  for (const r of sentinelRows) {
    console.log(`     id=${r.id} ${r.office_id ?? '(no code)'}  ${JSON.stringify(r.reporting_manager)} -> NULL`);
  }
  if (sentinelRows.length) {
    const res = await client.query(
      `UPDATE employees SET reporting_manager = NULL, updated_at = NOW()
        WHERE id = ANY($1::int[]) RETURNING id`,
      [sentinelRows.map(r => r.id)],
    );
    changed += res.rowCount;
  }

  // ── Repair 2 ───────────────────────────────────────────────────────────────
  const defects = await findHierarchyDefects(client, COMPANY_ID);
  console.log(`\n── 2. self-managing employees: ${defects.selfManaged.length}`);
  const clearable = [];
  for (const r of defects.selfManaged) {
    // Would clearing this orphan anyone? No — subordinates point at this row's
    // id, not at its manager. The only question is whether a REAL manager was
    // overwritten by the self-reference, and the data cannot answer that. What it
    // CAN say is whether this person sits at the top: nobody above them.
    const { rows: [{ n: above }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM employees
        WHERE id <> $1 AND reporting_manager_id = $1`,
      [r.id],
    );
    const topOfOrg = /chief|ceo|cto|cfo|coo|managing director|founder|chairman|president/i
      .test(String(r.designation ?? ''));
    console.log(
      `     id=${r.id} ${r.office_id ?? '(no code)'}  ${r.name}  designation=${JSON.stringify(r.designation)}  ` +
      `direct reports=${above}  ${topOfOrg ? '→ top of org, clear to NULL' : '→ NOT clearly top of org, SKIPPED'}`,
    );
    if (topOfOrg) clearable.push(r.id);
  }
  if (clearable.length) {
    const res = await client.query(
      `UPDATE employees
          SET reporting_manager_id = NULL, reporting_manager = NULL, updated_at = NOW()
        WHERE id = ANY($1::int[]) AND reporting_manager_id = id
        RETURNING id`,
      [clearable],
    );
    changed += res.rowCount;
  }
  const skipped = defects.selfManaged.length - clearable.length;
  if (skipped) {
    console.log(`     ⚠ ${skipped} self-managing employee(s) left as-is — their correct manager`);
    console.log('       cannot be determined from the data. FLAGGED FOR HR. New self-assignment');
    console.log('       is now blocked by assertValidManager, so this set cannot grow.');
  }

  // ── Repair 3 ───────────────────────────────────────────────────────────────
  const { rows: staleNames } = await client.query(
    `SELECT e.id, e.office_id, e.reporting_manager AS stored,
            COALESCE(NULLIF(TRIM(m.name), ''),
                     NULLIF(TRIM(COALESCE(m.first_name,'') || ' ' || COALESCE(m.last_name,'')), '')) AS actual
       FROM employees e JOIN employees m ON m.id = e.reporting_manager_id
      WHERE e.reporting_manager_id <> e.id
        AND LOWER(TRIM(COALESCE(e.reporting_manager, ''))) <> LOWER(TRIM(COALESCE(
              NULLIF(TRIM(m.name), ''),
              NULLIF(TRIM(COALESCE(m.first_name,'') || ' ' || COALESCE(m.last_name,'')), ''), '')))
        ${COMPANY_ID == null ? '' : 'AND ($1::int IS NULL OR e.company_id = $1)'}
      ORDER BY e.id`,
    params,
  );
  console.log(`\n── 3. manager NAME disagreeing with the manager FK: ${staleNames.length}`);
  for (const r of staleNames) {
    console.log(`     id=${r.id} ${JSON.stringify(r.stored)} -> ${JSON.stringify(r.actual)}`);
  }
  if (staleNames.length) {
    for (const r of staleNames) {
      const res = await client.query(
        `UPDATE employees SET reporting_manager = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
        [r.actual, r.id],
      );
      changed += res.rowCount;
    }
  }

  // ── Post-check, inside the same transaction ────────────────────────────────
  const after = await findHierarchyDefects(client, COMPANY_ID);
  console.log(`\n── After: self-managed ${after.selfManaged.length}, cycles ${after.cycles.length}, cross-tenant managers ${after.crossTenant.length}`);

  if (APPLY) {
    await client.query('COMMIT');
    console.log(`\nCOMMITTED — ${changed} row update(s).`);
  } else {
    await client.query('ROLLBACK');
    console.log(`\nDRY RUN — ${changed} row update(s) would be made. Nothing written. Re-run with --apply.`);
  }
} catch (err) {
  await client.query('ROLLBACK');
  console.error('\nFAILED (rolled back):', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
