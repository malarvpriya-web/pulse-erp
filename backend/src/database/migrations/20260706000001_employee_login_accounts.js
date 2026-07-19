/**
 * 20260706000001_employee_login_accounts.js
 *
 * Employees are stored in the `employees` table (keyed by company_email), but
 * login authenticates against the `users` table. Before this change, adding an
 * employee created no login account, so a new employee could never sign in.
 *
 * This migration:
 *   1. Ensures users.employee_id exists so a login account can point back at its
 *      employee record (getProfile already reads this column).
 *   2. Back-fills a login account for every active employee that has a
 *      company_email but no matching users row yet. Each account is created with
 *      the shared default password (they should change it on first login) and a
 *      primary user_scope pointing at the employee's company.
 *
 * New employees added after this migration get their login account created
 * automatically inside addEmployee() — see employee.service.js.
 */
import bcrypt from "bcryptjs";

const DEFAULT_EMPLOYEE_PASSWORD = process.env.DEFAULT_EMPLOYEE_PASSWORD || "Welcome@123";

export async function up(knex) {
  // 1. Link column — idempotent so it's safe whether or not it already exists.
  await knex.raw(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_users_employee_id ON users(employee_id);
  `);

  // 2. Back-fill login accounts for existing active employees without one.
  const { rows: pending } = await knex.raw(`
    SELECT e.id, e.company_email, e.first_name, e.last_name,
           e.department, e.company_id, e.branch_id
    FROM employees e
    WHERE e.company_email IS NOT NULL AND TRIM(e.company_email) <> ''
      AND e.deleted_at IS NULL
      AND LOWER(COALESCE(e.status,'active')) NOT IN
          ('left','terminated','resigned','inactive','ex-employee','notice_period','notice period')
      AND NOT EXISTS (
        SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(e.company_email)
      )
  `);

  if (!pending.length) return;

  // One hash for the shared default password — cheaper than hashing per row.
  const hash = await bcrypt.hash(DEFAULT_EMPLOYEE_PASSWORD, 10);

  for (const e of pending) {
    const name = `${e.first_name || ""} ${e.last_name || ""}`.trim() || e.company_email;
    const { rows } = await knex.raw(
      `INSERT INTO users (name, email, password_hash, role, department, is_active, company_id, employee_id)
       VALUES ($1, $2, $3, 'employee', $4, true, $5, $6)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [name, e.company_email, hash, e.department || null, e.company_id || null, e.id]
    );
    const userId = rows[0]?.id;
    if (userId && e.company_id) {
      await knex.raw(
        `INSERT INTO user_scope (user_id, company_id, branch_id, is_primary)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (user_id, company_id, branch_id) DO NOTHING`,
        [userId, e.company_id, e.branch_id || null]
      );
    }
  }
}

export async function down(knex) {
  // Intentionally a no-op. We keep users.employee_id and any auto-created login
  // accounts — dropping them would lock existing employees out of the system.
}
