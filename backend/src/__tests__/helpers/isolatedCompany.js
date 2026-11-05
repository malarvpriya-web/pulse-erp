// A throwaway company for an integration suite, so the suite never reads or
// writes a real tenant's data.
//
// Several suites (supplyChain, MRP, dashboards) compute over everything in
// company 1. A suite that created sales orders, production orders or BOMs there
// made those computations race with it: supplyChain's MRP counted another
// suite's half-finished orders as "unmatched demand" in parallel full runs.
//
// createIsolatedCompany() makes a uniquely-coded company plus an admin login
// that belongs to it. dropIsolatedCompany() removes that login and the company
// shell (and the seed rows other routers drop into every company); the suite
// deletes its own business rows first, scoped to the same company id.
// leftoverCompanies() finds what an earlier, aborted run of the same suite
// left, by its code prefix — a prefix only that suite uses.

import jwt from 'jsonwebtoken';

/**
 * @param {import('pg').Pool} pool
 * @param {string} prefix  code prefix unique to the calling suite (e.g. 'ZZO2P')
 * @returns {Promise<{ companyId: number, adminId: number, code: string, token: () => string }>}
 */
export async function createIsolatedCompany(pool, prefix) {
  const code = `${prefix}${Date.now().toString(36).toUpperCase()}`;
  const { rows: [co] } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${code} test company`, code]);
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, role)
     VALUES ($1, $2, 'not-a-real-hash', $3, true, 'admin') RETURNING id`,
    [`${code} admin`, `${code.toLowerCase()}.admin@test.invalid`, co.id]);
  const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = 'admin' LIMIT 1`);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [user.id, role.id]);
  const token = () => jwt.sign(
    { userId: user.id, role: 'admin', company_id: co.id, employee_id: null, name: `${code} admin` },
    process.env.JWT_SECRET, { expiresIn: '1h' });
  return { companyId: co.id, adminId: user.id, code, token };
}

/**
 * A further login in an isolated company — e.g. the CHECKER for payroll
 * maker-checker. Same role as the company admin unless given; removed with the
 * company by dropIsolatedCompany.
 */
export async function addUser(pool, company, { label = 'checker', roleCode = 'admin' } = {}) {
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, role)
     VALUES ($1, $2, 'not-a-real-hash', $3, true, $4) RETURNING id`,
    [`${company.code} ${label}`, `${company.code.toLowerCase()}.${label}@test.invalid`, company.companyId, roleCode]);
  const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = $1 LIMIT 1`, [roleCode]);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [user.id, role.id]);
  const token = () => jwt.sign(
    { userId: user.id, role: roleCode, company_id: company.companyId, employee_id: null, name: `${company.code} ${label}` },
    process.env.JWT_SECRET, { expiresIn: '1h' });
  return { userId: user.id, companyId: company.companyId, token };
}

/** Remove the company's logins and the company itself. Business rows must already be gone. */
export async function dropIsolatedCompany(pool, companyId) {
  if (companyId == null) return;
  const users = `(SELECT id FROM users WHERE company_id = $1)`;
  const soft = (sql) => pool.query(sql, [companyId]).catch(() => {});
  await soft(`DELETE FROM workflow_instance_steps WHERE instance_id IN (SELECT id FROM workflow_instances WHERE initiated_by IN ${users})`);
  await soft(`DELETE FROM workflow_instances WHERE initiated_by IN ${users}`);
  await soft(`DELETE FROM notifications WHERE user_id IN ${users}`);
  await soft(`DELETE FROM audit_logs WHERE user_id IN ${users}`);
  await soft(`DELETE FROM access_denials WHERE user_id IN ${users}`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN ${users}`, [companyId]);
  await soft(`DELETE FROM user_scope WHERE user_id IN ${users}`);
  await pool.query(`DELETE FROM users WHERE company_id = $1`, [companyId]);
  // talent.routes.js seeds interview_questions into every company when it is
  // imported in the same worker; without this the company cannot be deleted.
  await soft(`DELETE FROM interview_questions WHERE company_id = $1`);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
}

/** Company ids left by earlier runs of the suite that owns `prefix`. */
export async function leftoverCompanies(pool, prefix) {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${prefix}%`]);
  return rows.map(r => Number(r.id));
}
