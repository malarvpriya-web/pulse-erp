/**
 * Pilot user provisioning — DRY RUN BY DEFAULT.
 *
 *   node scripts/security/pilot-provision.mjs            # show what would happen
 *   node scripts/security/pilot-provision.mjs --apply    # actually create
 *
 * Creates the pilot cohort with the right role AND an employee link. Both
 * matter, for different reasons:
 *
 *   • no role      → fail-closed authorization denies everything (there is no
 *                    implicit default any more)
 *   • no employee  → clock-in, self-service and every ownership check return
 *                    EMPLOYEE_LINK_REQUIRED. `hr@manifest.in` is currently in
 *                    this state, and HR is in the pilot.
 *
 * Edit ROSTER below with the real people before running with --apply. The
 * placeholder addresses exist so a dry run is meaningful, not so they can be
 * created as-is.
 */
import bcrypt from 'bcryptjs';
import pool from '../../src/config/db.js';

const APPLY = process.argv.includes('--apply');

// Passwords are per-user random and printed ONCE by this script. They are not
// stored anywhere else — a shared default like "Welcome@123" across a cohort
// means one leaked credential is all of them, and nobody can tell the accounts
// apart in the audit log afterwards.
const rnd = () => 'Pulse-' + Math.random().toString(36).slice(2, 8) + '-' +
                  Math.random().toString(36).slice(2, 6).toUpperCase();

// NOTE: employees.name is a GENERATED column (first_name || ' ' || last_name)
// and cannot be inserted into — supply the parts, not the whole.
const ROSTER = [
  { first: 'Pilot', last: 'HR',         email: 'pilot.hr@manifest.in',       role: 'hr',                 dept: 'Human Resources' },
  { first: 'Pilot', last: 'Finance',    email: 'pilot.finance@manifest.in',  role: 'finance',            dept: 'Finance' },
  { first: 'Pilot', last: 'Production', email: 'pilot.prod@manifest.in',     role: 'production_manager', dept: 'Production' },
  { first: 'Pilot', last: 'Stores',     email: 'pilot.stores@manifest.in',   role: 'store_keeper',       dept: 'Stores' },
  { first: 'Pilot', last: 'Sales',      email: 'pilot.sales@manifest.in',    role: 'sales_manager',      dept: 'Sales' },
  { first: 'Pilot', last: 'ServiceA',   email: 'pilot.service1@manifest.in', role: 'service_engineer',   dept: 'Service' },
  { first: 'Pilot', last: 'ServiceB',   email: 'pilot.service2@manifest.in', role: 'service_engineer',   dept: 'Service' },
  { first: 'Pilot', last: 'Management', email: 'pilot.mgmt@manifest.in',     role: 'manager',            dept: 'Management' },
];

const COMPANY_ID = 1;

async function main() {
  console.log(`\n═══ PILOT PROVISIONING ${APPLY ? '(APPLYING)' : '(DRY RUN — pass --apply to execute)'} ═══\n`);

  const { rows: roles } = await pool.query('SELECT id, LOWER(code) code FROM roles');
  const roleId = Object.fromEntries(roles.map(r => [r.code, r.id]));

  const created = [];
  for (const p of ROSTER) {
    const { rows: exists } = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [p.email]);
    if (exists.length) { console.log(`  ⏭  ${p.email.padEnd(34)} already exists — skipped`); continue; }
    if (!roleId[p.role]) { console.log(`  ❌ ${p.email.padEnd(34)} role "${p.role}" does not exist`); continue; }

    const password = rnd();
    if (!APPLY) {
      console.log(`  + ${p.email.padEnd(34)} role=${p.role.padEnd(20)} employee+login would be created`);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Employee first — the user row links to it, and half the app keys off
      // employee_id rather than user id.
      const { rows: [emp] } = await client.query(
        `INSERT INTO employees (first_name, last_name, company_email, department, status, company_id, joining_date)
         VALUES ($1, $2, $3, $4, 'Active', $5, CURRENT_DATE) RETURNING id`,
        [p.first, p.last, p.email, p.dept, COMPANY_ID]
      );
      const { rows: [user] } = await client.query(
        `INSERT INTO users (email, password_hash, name, is_active, employee_id, must_change_password)
         VALUES ($1, $2, $3, true, $4, true) RETURNING id`,
        [p.email.toLowerCase(), await bcrypt.hash(password, 10), `${p.first} ${p.last}`, emp.id]
      );
      await client.query(
        `INSERT INTO user_roles (user_id, role_id, is_primary) VALUES ($1, $2, true)`,
        [user.id, roleId[p.role]]
      );
      // Scope drives company_id on every read; without it the user sees nothing.
      await client.query(
        `INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1, $2, true)
         ON CONFLICT DO NOTHING`,
        [user.id, COMPANY_ID]
      );
      await client.query('COMMIT');
      created.push({ email: p.email, role: p.role, password });
      console.log(`  ✅ ${p.email.padEnd(34)} user=${user.id} employee=${emp.id} role=${p.role}`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.log(`  ❌ ${p.email.padEnd(34)} ${e.message.split('\n')[0]}`);
    } finally {
      client.release();
    }
  }

  if (created.length) {
    console.log('\n  ── ONE-TIME PASSWORDS (not recoverable — distribute now) ──');
    for (const c of created) console.log(`     ${c.email.padEnd(34)} ${c.password}`);
    console.log('\n  All accounts have must_change_password = true.');
  }
  if (!APPLY) console.log('\n  Nothing was written. Edit ROSTER with real people, then re-run with --apply.');
  await pool.end();
}

main();
