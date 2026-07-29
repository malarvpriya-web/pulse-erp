import dotenv from "dotenv";
dotenv.config();

import bcrypt from "bcryptjs";
import pool from "../src/config/db.js";
import { syncPrimaryRole } from "../src/services/userRoles.js";

const employeeIdOrEmail = process.argv[2];
const tempPassword = process.argv[3] || process.env.DEFAULT_EMPLOYEE_PASSWORD || "Welcome@123";

if (!employeeIdOrEmail) {
  console.error("Usage: node dev-tools/reset-employee-personal-login.js <employee-id-or-email> [temporary-password]");
  process.exit(1);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");

  const { rows } = await client.query(
    `SELECT id, first_name, last_name, department, company_id, branch_id, personal_email
       FROM employees
      WHERE deleted_at IS NULL
        AND (id::text = $1 OR LOWER(personal_email) = LOWER($1) OR LOWER(company_email) = LOWER($1))
      ORDER BY id
      LIMIT 1`,
    [employeeIdOrEmail]
  );

  const emp = rows[0];
  if (!emp) throw new Error(`No employee found for ${employeeIdOrEmail}`);

  const email = String(emp.personal_email || "").trim().toLowerCase();
  if (!email) throw new Error(`Employee ${emp.id} has no personal_email`);

  const name = `${emp.first_name || ""} ${emp.last_name || ""}`.trim() || email;
  const hash = await bcrypt.hash(tempPassword, 10);

  const { rows: existing } = await client.query(
    `SELECT id, email FROM users WHERE employee_id = $1 OR LOWER(email) = LOWER($2) ORDER BY id LIMIT 1`,
    [emp.id, email]
  );

  let userId;
  if (existing.length) {
    userId = existing[0].id;
    await client.query(
      `UPDATE users
          SET name = $1,
              email = $2,
              password_hash = $3,
              role = 'employee',
              department = $4,
              is_active = true,
              company_id = $5,
              branch_id = $6,
              employee_id = $7,
              must_change_password = true,
              failed_attempts = 0,
              locked_until = NULL,
              updated_at = NOW()
        WHERE id = $8`,
      [name, email, hash, emp.department || null, emp.company_id ?? null, emp.branch_id ?? null, emp.id, userId]
    );
  } else {
    const inserted = await client.query(
      `INSERT INTO users (name, email, password_hash, role, department, is_active, company_id, branch_id, employee_id, must_change_password)
       VALUES ($1, $2, $3, 'employee', $4, true, $5, $6, $7, true)
       RETURNING id`,
      [name, email, hash, emp.department || null, emp.company_id ?? null, emp.branch_id ?? null, emp.id]
    );
    userId = inserted.rows[0].id;
  }

  await syncPrimaryRole(userId, "employee", emp.company_id ?? null, null, client);

  if (emp.company_id != null) {
    await client.query(
      `INSERT INTO user_scope (user_id, company_id, branch_id, is_primary)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (user_id, company_id, branch_id) DO NOTHING`,
      [userId, emp.company_id, emp.branch_id ?? null]
    );
  }

  await client.query("COMMIT");
  console.log(`Login ready: ${email}`);
  console.log(`Temporary password: ${tempPassword}`);
  console.log("User must change password on first login.");
} catch (err) {
  await client.query("ROLLBACK");
  console.error(err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
