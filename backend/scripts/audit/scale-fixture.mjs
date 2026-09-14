/**
 * scale-fixture.mjs — seed a production-scale dataset so the Analytics & AI
 * endpoints can be timed against something worth scanning.
 *
 * WHY
 * ---
 * The perf numbers in ANALYTICS_AI_FINAL_HARDENING_REPORT.md were measured
 * against 34 employees, 35 invoices and 3 projects. Every query returned in
 * ~13 ms because there was almost nothing to read. That says nothing about
 * behaviour at 10 000 invoices, and a p95 quoted from a near-empty table is
 * closer to marketing than measurement.
 *
 * This seeds a realistic volume into the LIVE company (so the same code paths,
 * indexes and company filters apply) with every row marked `ZZSCALE`, then
 * removes it. Nothing here is application seed data.
 *
 *   node scripts/audit/scale-fixture.mjs --up            # default volumes
 *   node scripts/audit/scale-fixture.mjs --up --scale=5  # 5x
 *   node scripts/audit/scale-fixture.mjs --down
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BACKEND = path.resolve(import.meta.dirname, '..', '..');
dotenv.config({ path: path.join(BACKEND, '.env'), quiet: true });
const pool = (await import(pathToFileURL(path.join(BACKEND, 'src/config/db.js')).href)).default;

const MARK = 'ZZSCALE';
const CID = Number(process.env.SCALE_COMPANY_ID || 1);
const scaleArg = process.argv.find((a) => a.startsWith('--scale='));
const S = scaleArg ? Number(scaleArg.split('=')[1]) : 1;

const VOL = {
  invoices: 10_000 * S,
  bills: 4_000 * S,
  opportunities: 2_000 * S,
  projects: 500 * S,
  employees: 2_000 * S,
  tickets: 5_000 * S,
  productionOrders: 2_000 * S,
  journalEntries: 3_000 * S,
};

/** Bulk insert via a single multi-row VALUES statement per chunk. */
async function bulk(client, table, cols, rows, chunk = 1_000) {
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params = [];
    const values = slice.map((r) => {
      const ph = r.map((v) => { params.push(v); return `$${params.length}`; });
      return `(${ph.join(',')})`;
    });
    await client.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')}`, params);
  }
}

async function down() {
  const stmts = [
    `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE entry_number LIKE '${MARK}%')`,
    `DELETE FROM journal_entries WHERE entry_number LIKE '${MARK}%'`,
    `DELETE FROM support_tickets   WHERE ticket_number LIKE '${MARK}%'`,
    `DELETE FROM production_orders WHERE production_order_no LIKE '${MARK}%'`,
    `DELETE FROM opportunities     WHERE opportunity_name LIKE '${MARK}%'`,
    `DELETE FROM bills             WHERE bill_number LIKE '${MARK}%'`,
    `DELETE FROM invoices          WHERE invoice_number LIKE '${MARK}%'`,
    `DELETE FROM projects          WHERE project_code LIKE '${MARK}%'`,
    `DELETE FROM employees         WHERE first_name = '${MARK}'`,
  ];
  for (const s of stmts) await pool.query(s).catch((e) => process.stderr.write(`  (skip) ${e.message}\n`));
  return { removed: true };
}

async function up() {
  await down();
  const client = await pool.connect();
  const t0 = Date.now();
  try {
    await client.query('BEGIN');
    const day = (n) => `CURRENT_DATE - ${n}`;
    const rnd = (n) => Math.floor(Math.random() * n);

    // ── employees ──────────────────────────────────────────────────────────
    const DEPTS = ['Engineering', 'Sales', 'Finance', 'HR', 'Production', 'Quality', 'Procurement', 'Service'];
    await bulk(client, 'employees',
      ['first_name', 'last_name', 'company_email', 'department', 'designation',
       'status', 'joining_date', 'basic_salary', 'company_id', 'gender'],
      Array.from({ length: VOL.employees }, (_, i) => [
        MARK, `Emp${i}`, `${MARK.toLowerCase()}.emp${i}@zzscale.invalid`,
        DEPTS[i % DEPTS.length], 'Engineer',
        ['Active', 'Active', 'Active', 'Probation', 'Notice'][i % 5],
        new Date(Date.now() - rnd(2000) * 86400000).toISOString().slice(0, 10),
        300000 + rnd(1500000), CID, i % 2 ? 'Male' : 'Female',
      ]));

    // ── invoices ───────────────────────────────────────────────────────────
    const PARTIES = Array.from({ length: 200 }, (_, i) => `${MARK} Customer ${i}`);
    await bulk(client, 'invoices',
      ['invoice_number', 'party_name', 'total_amount', 'balance', 'status',
       'invoice_date', 'due_date', 'company_id'],
      Array.from({ length: VOL.invoices }, (_, i) => {
        const amt = 10000 + rnd(900000);
        const age = rnd(720);
        return [
          `${MARK}-INV-${i}`, PARTIES[i % PARTIES.length], amt,
          i % 3 === 0 ? 0 : amt,
          ['paid', 'Sent', 'pending', 'overdue', 'paid'][i % 5],
          new Date(Date.now() - age * 86400000).toISOString().slice(0, 10),
          new Date(Date.now() - (age - 30) * 86400000).toISOString().slice(0, 10),
          CID,
        ];
      }));

    // ── bills ──────────────────────────────────────────────────────────────
    await bulk(client, 'bills',
      ['bill_number', 'party_name', 'amount', 'status', 'bill_date', 'due_date', 'company_id'],
      Array.from({ length: VOL.bills }, (_, i) => {
        const age = rnd(540);
        return [
          `${MARK}-BILL-${i}`, `${MARK} Vendor ${i % 120}`, 5000 + rnd(400000),
          ['paid', 'pending', 'overdue'][i % 3],
          new Date(Date.now() - age * 86400000).toISOString().slice(0, 10),
          new Date(Date.now() - (age - 30) * 86400000).toISOString().slice(0, 10),
          CID,
        ];
      }));

    // ── opportunities ──────────────────────────────────────────────────────
    const STAGES = ['prospecting', 'qualification', 'proposal', 'negotiation', 'closed_won', 'closed_lost'];
    await bulk(client, 'opportunities',
      ['opportunity_name', 'stage', 'expected_value', 'company_id'],
      Array.from({ length: VOL.opportunities }, (_, i) =>
        [`${MARK} Opp ${i}`, STAGES[i % STAGES.length], 50000 + rnd(5000000), CID]));

    // ── projects ───────────────────────────────────────────────────────────
    const PSTATUS = ['planning', 'active', 'on_hold', 'completed', 'cancelled'];
    await bulk(client, 'projects',
      ['project_code', 'project_name', 'status', 'company_id', 'start_date',
       'budget_amount', 'budget_spent'],
      Array.from({ length: VOL.projects }, (_, i) => [
        `${MARK}-PRJ-${i}`, `${MARK} Project ${i}`, PSTATUS[i % PSTATUS.length], CID,
        new Date(Date.now() - rnd(700) * 86400000).toISOString().slice(0, 10),
        500000 + rnd(9000000), rnd(4000000),
      ]));

    // ── support tickets ────────────────────────────────────────────────────
    const TSTATUS = ['Open', 'In Progress', 'Resolved', 'Closed'];
    const TPRI = ['High', 'Medium', 'Low'];
    await bulk(client, 'support_tickets',
      ['ticket_number', 'title', 'status', 'priority', 'company_id', 'created_at'],
      Array.from({ length: VOL.tickets }, (_, i) => [
        `${MARK}-TKT-${i}`, `${MARK} Ticket ${i}`,
        TSTATUS[i % TSTATUS.length], TPRI[i % TPRI.length], CID,
        new Date(Date.now() - rnd(400) * 86400000).toISOString(),
      ]));

    // ── production orders ──────────────────────────────────────────────────
    await bulk(client, 'production_orders',
      ['production_order_no', 'product_name', 'quantity_planned', 'quantity_completed',
       'status', 'company_id', 'actual_end_at'],
      Array.from({ length: VOL.productionOrders }, (_, i) => {
        const done = i % 3 === 0;
        return [
          `${MARK}-PO-${i}`, `${MARK} Widget ${i % 50}`, 10 + rnd(500), done ? 10 + rnd(500) : 0,
          done ? 'completed' : ['planned', 'in_progress'][i % 2], CID,
          done ? new Date(Date.now() - rnd(180) * 86400000).toISOString() : null,
        ];
      }));

    // ── journal entries + lines (the CFO P&L path) ─────────────────────────
    const { rows: coa } = await client.query(
      `SELECT id, code, account_type, sub_type FROM chart_of_accounts
        WHERE account_type IN ('Revenue','Expense') LIMIT 40`);
    if (coa.length >= 2) {
      await bulk(client, 'journal_entries',
        ['entry_number', 'entry_date', 'entry_type', 'description', 'status',
         'is_posted', 'company_id'],
        Array.from({ length: VOL.journalEntries }, (_, i) => [
          `${MARK}-JE-${i}`,
          new Date(Date.now() - rnd(330) * 86400000).toISOString().slice(0, 10),
          'ScaleTest', `${MARK} entry ${i}`, 'posted', true, CID,
        ]));
      const { rows: ids } = await client.query(
        `SELECT id FROM journal_entries WHERE entry_number LIKE '${MARK}%' ORDER BY id`);
      const lines = [];
      for (const [i, e] of ids.entries()) {
        const a = coa[i % coa.length];
        const amt = 1000 + rnd(200000);
        lines.push([e.id, a.id, a.code,
          a.account_type === 'Revenue' ? 0 : amt,
          a.account_type === 'Revenue' ? amt : 0, CID]);
      }
      await bulk(client, 'journal_lines',
        ['entry_id', 'account_id', 'account_code', 'debit', 'credit', 'company_id'], lines);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Planner stats matter: a fresh bulk load leaves the optimiser blind, and a
  // seq-scan chosen from stale statistics would make this measure the wrong thing.
  await pool.query('ANALYZE');

  const { rows: [c] } = await pool.query(`
    SELECT (SELECT COUNT(*) FROM invoices          WHERE company_id=$1)::int AS invoices,
           (SELECT COUNT(*) FROM bills             WHERE company_id=$1)::int AS bills,
           (SELECT COUNT(*) FROM employees         WHERE company_id=$1)::int AS employees,
           (SELECT COUNT(*) FROM opportunities     WHERE company_id=$1)::int AS opportunities,
           (SELECT COUNT(*) FROM projects          WHERE company_id=$1)::int AS projects,
           (SELECT COUNT(*) FROM support_tickets   WHERE company_id=$1)::int AS tickets,
           (SELECT COUNT(*) FROM production_orders WHERE company_id=$1)::int AS production_orders,
           (SELECT COUNT(*) FROM journal_lines     WHERE company_id=$1)::int AS journal_lines`, [CID]);
  return { seeded: true, scale: S, seconds: Math.round((Date.now() - t0) / 1000), totals: c };
}

const result = process.argv.includes('--down') ? await down() : await up();
console.log('---FIXTURE_BEGIN---');
console.log(JSON.stringify(result));
console.log('---FIXTURE_END---');
await pool.end();
