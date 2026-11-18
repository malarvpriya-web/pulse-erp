#!/usr/bin/env node
/**
 * e2e-settlement-fixture.mjs — a throwaway company for the settlement browser test (§254).
 * Runs only on a marked test database, through the guard.
 *
 *   node scripts/e2e-settlement-fixture.mjs setup     → creates, prints fenced JSON
 *   node scripts/e2e-settlement-fixture.mjs teardown  → deletes what it made
 *
 * Teardown sweeps by company code, so a crashed run is cleaned by the next one.
 */
const { default: pool } = await import('../src/config/db.js');
const { guardOrExit } = await import('./test-db/guard.mjs');
const { syncPrimaryRole } = await import('../src/services/userRoles.js');

await guardOrExit(pool, 'e2e-settlement-fixture');

const CODE = 'ZZFNFE2E';
const EMAIL = 'zzfnfe2e.admin@example.com';

async function teardown() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = $1`, [CODE]);
  const co = rows.map((r) => r.id);
  if (co.length) {
    const emps = (await pool.query(`SELECT id FROM employees WHERE company_id = ANY($1)`, [co])).rows.map((r) => r.id);
    await pool.query(`DELETE FROM fnf_settlement_events WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM fnf_settlements WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM exit_clearance WHERE employee_id = ANY($1)`, [emps]);
    await pool.query(`DELETE FROM exit_requests WHERE employee_id = ANY($1)`, [emps]);
    await pool.query(`DELETE FROM leave_balances WHERE employee_id = ANY($1)`, [emps]);
    await pool.query(`DELETE FROM employee_salary_assignments WHERE employee_id = ANY($1)`, [emps]);
    await pool.query(`DELETE FROM employees WHERE id = ANY($1)`, [emps]);
    await pool.query(`DELETE FROM leave_types WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM payroll_statutory_rules WHERE company_id = ANY($1)`, [co]);
  }
  const u = `SELECT id FROM users WHERE email = '${EMAIL}'`;
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${u})`);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${u})`);
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (${u})`);
  await pool.query(`DELETE FROM access_denials WHERE user_id IN (${u})`);
  await pool.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
  if (co.length) await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

async function setup() {
  await teardown();
  const { rows: [c] } = await pool.query(`INSERT INTO companies (name, code) VALUES ('ZZ FNF E2E', $1) RETURNING id`, [CODE]);
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id) VALUES ('Zz Admin', $1, 'no-password-mint-a-token', 'admin', true, $2) RETURNING id`, [EMAIL, c.id]);
  await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1, $2, true)`, [u.id, c.id]);
  await syncPrimaryRole(u.id, 'admin', c.id);
  const { rows: [e] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, employment_type)
     VALUES ($1, 'EMP901', 'Zz', 'Leaver', 'Notice', '2020-04-01', 'Permanent') RETURNING id`, [c.id]);
  await pool.query(`INSERT INTO employee_salary_assignments (employee_id, basic_salary, effective_from, company_id) VALUES ($1, 26000, '2020-04-01', $2)`, [e.id, c.id]);
  const { rows: [t] } = await pool.query(
    `INSERT INTO leave_types (leave_name, leave_code, annual_quota, is_encashable, company_id) VALUES ('Earned Leave', 'ZZE2E', 12, true, $1) RETURNING id`, [c.id]);
  await pool.query(
    `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days, carried_forward_days, opening_balance, encashed_days)
     VALUES ($1, $2, 2026, 12, 0, 0, 0, 0)`, [e.id, t.id]);
  const { rows: [x] } = await pool.query(
    `INSERT INTO exit_requests (employee_id, separation_type, last_working_date, status, reason, notice_period, created_at)
     VALUES ($1, 'resignation', '2026-10-31', 'active', 'zz', 30, '2026-10-01') RETURNING id`, [e.id]);
  await pool.query(`INSERT INTO exit_clearance (employee_id) VALUES ($1)`, [e.id]);
  console.log(`---E2E_BEGIN---\n${JSON.stringify({ email: EMAIL, employee_id: e.id, exit_id: x.id })}\n---E2E_END---`);
}

const cmd = process.argv[2];
try {
  if (cmd === 'setup') await setup();
  else if (cmd === 'teardown') { await teardown(); console.log('---E2E_BEGIN---\n{}\n---E2E_END---'); }
  else { console.error('Usage: setup | teardown'); process.exitCode = 2; }
} finally {
  await pool.end();
}
