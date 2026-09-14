#!/usr/bin/env node
/**
 * check-status-vocabulary.mjs
 *
 * Compares the canonical status vocabularies in `src/shared/statusSets.js`
 * against the values actually present in the database.
 *
 * WHY
 * ---
 * The single largest defect class in the Analytics & AI pre-go-live audit was
 * SQL filtering on status values that the application never writes:
 *   - employees.status is 'Active'/'Notice'/'Probation'; queries filtered
 *     'active'/'inactive' case-sensitively, so five attrition KPIs read 0%.
 *   - support_tickets.status is 'Open'/'In Progress'/'Resolved'; one endpoint
 *     excluded ('Resolved','Closed') and another ('resolved','closed'), so the
 *     same page reported two different open-ticket counts.
 *   - projects.status can never be 'on-track' (check constraint), so the
 *     Projects On-Track KPI was structurally stuck at 0.
 *   - timesheets.status is 'approved'; the tile filtered 'submitted'.
 * None of these threw. They silently returned nothing.
 *
 * This script fails when the database holds a status value that no vocabulary
 * covers — i.e. when some query is skipping rows nobody realises it is skipping.
 *
 * Usage:
 *   node backend/scripts/check-status-vocabulary.mjs          # human output, exit 1 on drift
 *   node backend/scripts/check-status-vocabulary.mjs --json   # machine output for CI/Playwright
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Load backend/.env explicitly so the script works from either the repo root or
// backend/ — Playwright and CI both run it with cwd outside backend/.
// `override: false` (the default) means a real environment variable always wins,
// which is what lets CI supply DATABASE_URL with no .env present at all.
dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env'), quiet: true });
/**
 * The vocabularies under test.
 *
 * `CHECK_SRC_ROOT` loads statusSets.js from a copy of the tree instead of the
 * working one, so the negative-fixture tests in
 * src/__tests__/analytics.schemaGuards.test.js can drop a value from a set
 * without editing a file that other vitest workers are importing at the same
 * time. Unset — the normal case, including CI — this is the ordinary import.
 */
const sets = process.env.CHECK_SRC_ROOT
  ? await import(pathToFileURL(
      path.resolve(process.env.CHECK_SRC_ROOT, 'src/shared/statusSets.js')).href)
  : await import('../src/shared/statusSets.js');

// Reuse the application's own pool — see the note in check-sql-references.mjs.
const pool = (await import('../src/config/db.js')).default;

const JSON_OUT = process.argv.includes('--json');

/**
 * Each entry: which column to sample, and which vocabularies are allowed to
 * cover it. A DB value covered by none of them is drift.
 */
const CHECKS = [
  { table: 'employees',       column: 'status',       vocab: [...sets.EMPLOYEE_ACTIVE, ...sets.EMPLOYEE_EXITED] },
  { table: 'support_tickets', column: 'status',       vocab: [...sets.TICKET_CLOSED, 'open', 'in progress', 'in_progress', 'pending', 'on hold', 'escalated', 'reopened', 'assigned', 'new'] },
  { table: 'support_tickets', column: 'priority',     vocab: ['low', 'medium', 'high', 'critical', 'urgent'] },
  { table: 'projects',        column: 'status',       vocab: [...sets.PROJECT_OPEN, ...sets.PROJECT_CLOSED] },
  { table: 'invoices',        column: 'status',       vocab: [...sets.INVOICE_PAID, ...sets.INVOICE_VOID, ...sets.INVOICE_UNPAID] },
  { table: 'bills',           column: 'status',       vocab: [...sets.BILL_PAID, ...sets.BILL_VOID, ...sets.BILL_UNPAID] },
  { table: 'timesheets',      column: 'status',       vocab: [...sets.TIMESHEET_PENDING, ...sets.TIMESHEET_APPROVED, 'draft', 'rejected'] },
  { table: 'leave_requests',  column: 'status',       vocab: [...sets.LEAVE_APPROVED, ...sets.LEAVE_PENDING, 'rejected', 'cancelled', 'withdrawn'] },
  { table: 'job_openings',    column: 'status',       vocab: [...sets.OPENING_OPEN, 'closed', 'filled', 'on_hold', 'cancelled', 'draft'] },
  { table: 'offer_letters',   column: 'offer_status', vocab: [...sets.OFFER_EXTENDED, 'draft'] },
  { table: 'vendors',         column: 'status',       vocab: [...sets.VENDOR_BLOCKED, 'active', 'approved', 'preferred', 'pending', 'inactive', 'watchlist', 'draft'] },
  { table: 'ncr_reports',     column: 'status',       vocab: [...sets.NCR_CLOSED, 'open', 'in progress', 'in_progress', 'pending', 'under review', 'escalated'] },
  { table: 'amc_contracts',   column: 'status',       vocab: [...sets.AMC_ACTIVE, 'expired', 'cancelled', 'draft', 'renewed', 'pending'] },
  { table: 'opportunities',   column: 'stage',        vocab: null }, // free-form pipeline stages; reported, never failed
];

const exists = async (table, column) => {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, column]);
  return rows.length > 0;
};

const unmapped = [];
const observed = [];
const skipped  = [];

for (const c of CHECKS) {
  if (!(await exists(c.table, c.column))) { skipped.push(`${c.table}.${c.column} (no such column)`); continue; }
  const { rows } = await pool.query(
    `SELECT DISTINCT ${c.column} AS v, COUNT(*)::int AS n
       FROM ${c.table} WHERE ${c.column} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`);
  const values = rows.map(r => ({ value: r.v, rows: r.n }));
  observed.push({ table: c.table, column: c.column, values });
  if (!c.vocab) continue;
  const allowed = new Set(c.vocab.map(v => v.toLowerCase()));
  for (const { value, rows: n } of values) {
    if (!allowed.has(String(value).toLowerCase())) {
      unmapped.push({ table: c.table, column: c.column, value, rows: n });
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Case drift — the same state stored under more than one spelling.

   The check above lowercases both sides before comparing, so it passes a column
   holding 'Qualification' AND 'qualification' without a word: both are covered
   by the vocabulary. Every FILTER in the backend lowercases too, so totals stay
   right. A GROUP BY key does not: `getPipelineValue()`, `/dashboard/sales` and
   `/sales/forecast` grouped on the raw column, so one stage came back as two
   rows and the pipeline drew it twice with its value split across them —
   reproduced live by converting a single lead, ₹5,00,000 and ₹2,20,000 sitting
   in two "Qualification" buckets.

   Swept across every state-shaped column rather than the CHECKS list above,
   because the drift was also in `opportunity_stage_history.to_stage`, which
   that list does not mention. Migration 20260910000005 normalises the columns
   that had drifted and installs triggers to hold them there; this is what
   notices the next column to slip.
   ───────────────────────────────────────────────────────────────────────────── */
const { rows: stateColumns } = await pool.query(`
  SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name
     AND t.table_schema = c.table_schema
     AND t.table_type = 'BASE TABLE'
   WHERE c.table_schema = 'public'
     AND c.data_type IN ('character varying', 'text', 'character')
     AND (c.column_name IN ('status','stage','state','priority','severity')
          OR c.column_name LIKE '%\\_status'
          OR c.column_name LIKE '%\\_stage'
          OR c.column_name LIKE '%\\_state')
   ORDER BY c.table_name, c.column_name`);

const caseDrift = [];
for (const { table_name, column_name } of stateColumns) {
  const col = `"${column_name}"`;
  try {
    const { rows } = await pool.query(
      `SELECT LOWER(TRIM(${col})) AS canonical,
              STRING_AGG(DISTINCT ${col}, ' | ' ORDER BY ${col}) AS spellings,
              COUNT(*)::int AS rows
         FROM "${table_name}"
        WHERE ${col} IS NOT NULL
        GROUP BY 1
       HAVING COUNT(DISTINCT ${col}) > 1`);
    for (const r of rows) {
      caseDrift.push({ table: table_name, column: column_name, ...r });
    }
  } catch {
    // A column the checking role cannot read is not evidence of drift.
  }
}

await pool.end();

const failures = unmapped.length + caseDrift.length;

if (JSON_OUT) {
  // Fenced so callers can extract the payload deterministically. dotenv v17
  // prints a rotating tip banner to STDOUT that sometimes contains a brace
  // ('{ processEnv: myObject }'), which made a naive indexOf('{') parse the
  // banner instead of the report — an intermittent failure that looked like a
  // schema problem. Same sentinel convention as e2e-mint-token.mjs.
  console.log('---REPORT_BEGIN---');
  console.log(JSON.stringify({ unmapped, caseDrift, observed, skipped }));
  console.log('---REPORT_END---');
} else {
  console.log('\nStatus vocabulary check\n' + '='.repeat(60));
  for (const o of observed) {
    console.log(`\n${o.table}.${o.column}`);
    for (const v of o.values) {
      const bad = unmapped.some(u => u.table === o.table && u.column === o.column && u.value === v.value);
      console.log(`  ${bad ? 'DRIFT' : '  ok '}  ${String(v.value).padEnd(22)} ${v.rows} row(s)`);
    }
  }
  if (skipped.length) console.log('\nSkipped: ' + skipped.join(', '));

  console.log(`\nCase drift (one state, more than one spelling) — ${stateColumns.length} column(s) swept`);
  if (caseDrift.length === 0) {
    console.log('     ok   every state is stored under a single spelling');
  } else {
    for (const d of caseDrift) {
      console.log(`  DRIFT  ${d.table}.${d.column}: ${d.spellings}  (${d.rows} row(s))`);
    }
  }

  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log('PASS — every status value is covered by statusSets.js, and each is stored one way');
  } else {
    if (unmapped.length) {
      console.log(`FAIL — ${unmapped.length} value(s) present in the database but absent from statusSets.js.\n` +
        'Any query filtering on these columns is silently skipping those rows.');
    }
    if (caseDrift.length) {
      console.log(`FAIL — ${caseDrift.length} column(s) hold one state under several spellings.\n` +
        'Filters lowercase and stay correct; GROUP BY does not, so the state is\n' +
        'reported twice with its rows and its value split between the spellings.\n' +
        'Normalise the column and canonicalise the writer — see statusSets.canonicalState().');
    }
  }
}

process.exit(failures === 0 ? 0 : 1);
