/**
 * tenant-fixture.mjs — create/destroy a second company so tenant isolation can
 * actually be tested rather than inferred.
 *
 * The database ships with exactly one company, which makes every cross-tenant
 * claim unfalsifiable: a query that ignores company_id entirely returns the
 * right answer when there is only one tenant. This seeds a real Company B with
 * data in every table the Analytics & AI surface reads, so a leak becomes
 * visible as Company B's marker string appearing in Company A's response.
 *
 * Every row it writes carries the ZZTENANT marker in a text column and is
 * removed by `--down`. Nothing here is seed data for the application.
 *
 *   node scripts/audit/tenant-fixture.mjs --up     # returns JSON ids, fenced
 *   node scripts/audit/tenant-fixture.mjs --down
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';

const BACKEND = path.resolve(import.meta.dirname, '..', '..');
dotenv.config({ path: path.join(BACKEND, '.env'), quiet: true });
const pool = (await import(pathToFileURL(path.join(BACKEND, 'src/config/db.js')).href)).default;

const MARK = 'ZZTENANT';
const B_CODE = `${MARK}B`;
const B_EMAIL = 'zztenant.b@zztenant.invalid';
const A_EMAIL_DEFAULT = 'superadmin@manifest.in';

async function down() {
  const { rows } = await pool.query('SELECT id FROM companies WHERE code = $1', [B_CODE]);
  const cid = rows[0]?.id;
  // Delete children first; FK order matters and some have ON DELETE RESTRICT.
  for (const sql of [
    `DELETE FROM support_tickets   WHERE ticket_number LIKE '${MARK}%'`,
    `DELETE FROM opportunities     WHERE opportunity_name LIKE '${MARK}%'`,
    `DELETE FROM production_orders WHERE production_order_no LIKE '${MARK}%'`,
    `DELETE FROM invoices          WHERE invoice_number LIKE '${MARK}%'`,
    `DELETE FROM projects          WHERE project_code LIKE '${MARK}%'`,
    // Anything referencing the fixture EMPLOYEE has to go before the employee
    // row itself, or its delete fails on an FK and prints a misleading (skip).
    `DELETE FROM leave_requests    WHERE leave_type LIKE '${MARK}%'`,
    `DELETE FROM expense_claims    WHERE claim_number LIKE '${MARK}%'`,
    `DELETE FROM test_run_measurements WHERE test_run_id IN (SELECT id FROM test_runs WHERE run_number LIKE '${MARK}%')`,
    `DELETE FROM test_runs         WHERE run_number LIKE '${MARK}%'`,
    `DELETE FROM ncr_reports       WHERE ncr_number LIKE '${MARK}%'`,
    `DELETE FROM audit_logs        WHERE module_name LIKE '${MARK}%'`,
    `DELETE FROM user_roles        WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%zztenant%')`,
    `DELETE FROM users             WHERE email LIKE '%zztenant%'`,
    `DELETE FROM employees         WHERE company_email LIKE '%zztenant%' OR first_name = '${MARK}'`,
  ]) {
    await pool.query(sql).catch((e) => process.stderr.write(`  (skip) ${e.message}\n`));
  }
  if (!cid) return { removed: true, company_b: null };

  // Creating a company has side effects elsewhere in the app (seeded interview
  // question banks, notification rules, customer-health rows written by the
  // nightly cron), so a hand-written child list goes stale the moment any of
  // those change and leaves the company undeletable — which then makes the next
  // --up fail on a unique constraint.
  //
  // Instead, sweep every table that carries a company_id and delete this
  // company's rows, repeating while progress is being made so foreign-key
  // ordering resolves itself. Only ever touches the fixture company.
  const { rows: owned } = await pool.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'company_id'`);

  let remaining = owned.map((r) => r.table_name);
  for (let pass = 0; pass < 6 && remaining.length; pass++) {
    const stuck = [];
    for (const t of remaining) {
      try {
        await pool.query(`DELETE FROM "${t}" WHERE company_id = $1`, [cid]);
      } catch {
        stuck.push(t);   // referenced by something not yet cleared
      }
    }
    if (stuck.length === remaining.length) break;   // no progress; stop looping
    remaining = stuck;
  }

  try {
    await pool.query('DELETE FROM companies WHERE id = $1', [cid]);
  } catch (e) {
    return { removed: false, company_b: cid, blocked_by: e.table ?? e.message };
  }
  return { removed: true, company_b: cid };
}

async function up() {
  await down();   // idempotent

  const { rows: [company] } = await pool.query(
    `INSERT INTO companies (name, code, is_active) VALUES ($1, $2, true) RETURNING id`,
    [`${MARK} Tenant B Ltd`, B_CODE]);
  const cid = company.id;

  const { rows: [emp] } = await pool.query(
    `INSERT INTO employees (first_name, last_name, company_email, department, designation,
                            status, joining_date, basic_salary, company_id)
     VALUES ($1::text,'TenantB',$2,'ZZDeptB','ZZRoleB','Active',
             CURRENT_DATE - 200, 123456, $3) RETURNING id`,
    [MARK, B_EMAIL, cid]);

  const hash = await bcrypt.hash('ZZtenant@' + Date.now(), 10);
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (email, password_hash, name, role, employee_id, company_id, is_active)
     VALUES ($1,$2,$3,'admin',$4,$5,true) RETURNING id`,
    [B_EMAIL, hash, `${MARK} Admin B`, emp.id, cid]);

  // Give Company B's user the same role set as Company A's admin so any
  // difference in what they can see is scoping, never permissions.
  const { rows: adminRole } = await pool.query(`SELECT id FROM roles WHERE LOWER(code)='admin' LIMIT 1`);
  if (adminRole[0]) {
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [user.id, adminRole[0].id]);
  }

  const { rows: [proj] } = await pool.query(
    `INSERT INTO projects (project_code, project_name, status, company_id, start_date, budget_amount)
     VALUES ($1,$2,'active',$3, CURRENT_DATE - 90, 9999999) RETURNING id`,
    [`${MARK}-PRJ-B1`, `${MARK} Tenant B Project`, cid]);

  await pool.query(
    `INSERT INTO invoices (invoice_number, total_amount, status, invoice_date, company_id)
     VALUES ($1, 7777777, 'Sent', CURRENT_DATE - 10, $2)`,
    [`${MARK}-INV-B1`, cid]);

  await pool.query(
    `INSERT INTO production_orders (production_order_no, product_name, quantity_planned, status, company_id)
     VALUES ($1, $2, 42, 'planned', $3)`,
    [`${MARK}-PO-B1`, `${MARK} Widget B`, cid]);

  await pool.query(
    `INSERT INTO opportunities (opportunity_name, stage, expected_value, company_id)
     VALUES ($1,'prospecting', 8888888, $2)`,
    [`${MARK} Tenant B Opportunity`, cid]);

  await pool.query(
    `INSERT INTO support_tickets (ticket_number, title, status, priority, company_id)
     VALUES ($1, $2, 'Open', 'High', $3)`,
    [`${MARK}-TKT-B1`, `${MARK} Tenant B Ticket`, cid]);

  /* ── Tables the fixture used to leave empty ────────────────────────────────
   *
   * A leak can only be detected in a table the fixture actually populates. This
   * seeded nine tables against a read surface of roughly forty, so eight of the
   * module's routers were untestable by construction — including every Power
   * Quality endpoint, which turned out to have no company scoping at all and
   * still showed as PASS.
   *
   * Everything below carries the ZZTENANT marker or one of the sentinel numbers,
   * and `down()` is schema-driven so it removes them without a hand-written list.
   */

  // Power Quality historian — the router that was entirely unscoped.
  const { rows: [run] } = await pool.query(
    `INSERT INTO test_runs (run_number, test_type, test_stage, overall_result,
                            product_name, serial_number, company_id, created_at, completed_at)
     VALUES ($1, 'burn-in', 'FAT', 'fail', $2, $3, $4, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')
     RETURNING id`,
    [`${MARK}-RUN-B1`, `${MARK} Unit B`, `${MARK}-SN-B1`, cid]);

  await pool.query(
    `INSERT INTO test_run_measurements (test_run_id, parameter_code, parameter_name, measured_value, result)
     VALUES ($1,'THD_I','Current THD', 9999999, 'fail')`, [run.id]);

  // Approval queues that feed the AI recommendation surfaces.
  await pool.query(
    `INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, status, company_id, created_at)
     VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE, 'pending', $3, NOW())`,
    [emp.id, `${MARK}-LEAVE`, cid]);

  await pool.query(
    `INSERT INTO expense_claims (claim_number, employee_id, status, total_amount, amount, company_id, claim_date)
     VALUES ($1, $2, 'pending', 7777777, 7777777, $3, CURRENT_DATE)`,
    [`${MARK}-EXP-B1`, emp.id, cid]);

  // Quality and audit surfaces.
  await pool.query(
    `INSERT INTO ncr_reports (ncr_number, title, description, status, company_id)
     VALUES ($1, $2::text, $2::text, 'open', $3)`,
    [`${MARK}-NCR-B1`, `${MARK} Tenant B non-conformance`, cid]);

  await pool.query(
    `INSERT INTO audit_logs (user_id, module_name, action_type, reference_type, company_id)
     VALUES ($1, $2, 'CREATE', $3, $4)`,
    [user.id, `${MARK}Module`, `${MARK}Ref`, cid]);

  return {
    marker: MARK,
    company_b: cid,
    company_b_user: user.id,
    company_b_email: B_EMAIL,
    company_b_employee: emp.id,
    company_b_project: proj.id,
    company_b_test_run: run.id,
    company_a_email: process.env.TENANT_A_EMAIL || A_EMAIL_DEFAULT,
  };
}

const mode = process.argv.includes('--down') ? 'down' : 'up';
const result = mode === 'down' ? await down() : await up();
console.log('---FIXTURE_BEGIN---');
console.log(JSON.stringify(result));
console.log('---FIXTURE_END---');
await pool.end();
