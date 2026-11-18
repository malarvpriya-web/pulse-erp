/**
 * scripts/db/create-first-admin.mjs — the first login on a new database (manual §252).
 *
 * A new database has no users, so nobody can sign in to create one. This makes exactly
 * one super_admin and then refuses to run again: it stops if any active admin or
 * super_admin exists, so it cannot be used to add a backdoor account later.
 *
 * There is no default password. A random one is printed once and stored only as a hash,
 * and the account must set its own at first sign-in. Run it where the output is not
 * logged, such as a one-off shell. It uses the tools' login (DB_USER or DATABASE_URL),
 * the same as `npm run migrate`, and records the creation in audit_logs.
 *
 * The account has no employee record. It can administer the system, but clock-in and
 * self-service stay unavailable to it until it is linked to one.
 *
 *   FIRST_ADMIN_EMAIL=name@company.com FIRST_ADMIN_NAME="Full Name" \
 *     node scripts/db/create-first-admin.mjs [--company 1]
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { syncPrimaryRole } from '../../src/services/userRoles.js';

const ROLE = 'super_admin';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** One transaction; any refusal changes nothing. Returns the new user, never the password. */
export async function createFirstAdmin(client, { email, name, companyId = 1, passwordHash }) {
  const cleanEmail = String(email ?? '').trim().toLowerCase();
  const cleanName = String(name ?? '').trim();
  if (!EMAIL.test(cleanEmail)) throw new Error('FIRST_ADMIN_EMAIL is not a valid email address.');
  if (!cleanName) throw new Error('FIRST_ADMIN_NAME is required.');
  if (!passwordHash) throw new Error('A password hash is required.');

  await client.query('BEGIN');
  try {
    // Two runs at once must not both see "no admin".
    await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const { rows: [{ n }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM users u
        WHERE u.is_active AND (LOWER(u.role) IN ('admin', 'super_admin')
           OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                       WHERE ur.user_id = u.id AND LOWER(r.code) IN ('admin', 'super_admin')))`);
    if (n > 0) throw new Error(`An active administrator already exists (${n}). This tool only creates the first one.`);

    const { rows: [company] } = await client.query(`SELECT id FROM companies WHERE id = $1`, [companyId]);
    if (!company) throw new Error(`Company ${companyId} does not exist.`);
    const { rows: [role] } = await client.query(`SELECT id FROM roles WHERE LOWER(code) = $1`, [ROLE]);
    if (!role) throw new Error(`Role ${ROLE} does not exist. Run npm run migrate first.`);
    const { rows: taken } = await client.query(`SELECT 1 FROM users WHERE LOWER(email) = $1`, [cleanEmail]);
    if (taken.length) throw new Error(`A login with this email already exists and is not active. Reactivate it instead.`);

    const { rows: [user] } = await client.query(
      `INSERT INTO users (email, password_hash, name, role, is_active, company_id, must_change_password)
       VALUES ($1, $2, $3, $4, true, $5, true) RETURNING id, email`,
      [cleanEmail, passwordHash, cleanName, ROLE, companyId]);
    await client.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1, $2, true)`, [user.id, companyId]);
    if (!(await syncPrimaryRole(user.id, ROLE, companyId, null, client))) throw new Error(`Could not assign role ${ROLE}.`);
    await client.query(
      `INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type, new_data_json, company_id)
       VALUES (NULL, 'users', 'first_admin_created', $1, 'user', $2, $3)`,
      [String(user.id), { email: cleanEmail, role: ROLE, must_change_password: true }, companyId]);

    await client.query('COMMIT');
    return user;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--company');
  const companyId = at > 0 ? Number(process.argv[at + 1]) : 1;
  const { default: pool } = await import('../../src/config/db.js');
  const client = await pool.connect();
  try {
    const password = randomBytes(18).toString('base64url');
    const user = await createFirstAdmin(client, {
      email: process.env.FIRST_ADMIN_EMAIL, name: process.env.FIRST_ADMIN_NAME, companyId,
      passwordHash: await bcrypt.hash(password, 10),
    });
    console.log(`Created ${user.email} (user ${user.id}, role ${ROLE}, company ${companyId}).`);
    console.log(`Temporary password, shown once: ${password}`);
    console.log('It must be changed at first sign-in.');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
