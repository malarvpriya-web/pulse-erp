#!/usr/bin/env node
/**
 * department-heads-ui-fixture.mjs — fixture for tests/suites/department-heads.testdb.spec.ts.
 *
 *   node scripts/test-db/department-heads-ui-fixture.mjs seed
 *   node scripts/test-db/department-heads-ui-fixture.mjs drop-login <email>
 *   node scripts/test-db/department-heads-ui-fixture.mjs clean
 *
 * ISOLATED TEST DATABASE ONLY: refuses unless PULSE_TEST_DB=1 and DB_NAME
 * starts with pulse_e2e. Works in the E2E Test Company (code E2ETEST): two
 * employees with active logins (so the head picker has someone to offer) and
 * no department-head rows. Prints its result between ---FIXTURE--- fences.
 */
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env'), quiet: true });
const DB = process.env.DB_NAME || '';
if (process.env.PULSE_TEST_DB !== '1' || !/^pulse_e2e/.test(DB)) {
  console.error('department-heads-ui-fixture: refusing — not the isolated test database.');
  process.exit(2);
}
delete process.env.DATABASE_URL;

const PREFIX = 'zz.dhui.';
const client = new pg.Client({
  host: process.env.DB_HOST, port: process.env.DB_PORT, database: DB,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});
await client.connect();
const q = (sql, params) => client.query(sql, params);
const out = (obj) => console.log(`---FIXTURE---${JSON.stringify(obj)}---FIXTURE---`);

async function company() {
  const { rows: [c] } = await q(`SELECT id FROM companies WHERE code = 'E2ETEST'`);
  if (!c) throw new Error('E2E Test Company (E2ETEST) not found — run scripts/test-db/setup.mjs.');
  return c.id;
}

async function clean(cid) {
  const users = `SELECT id FROM users WHERE email LIKE '${PREFIX}%'`;
  await q(`DELETE FROM department_heads WHERE company_id = $1`, [cid]);
  await q(`DELETE FROM notifications WHERE user_id IN (${users})`);
  await q(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await q(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await q(`DELETE FROM users WHERE email LIKE '${PREFIX}%'`);
  await q(`DELETE FROM employees WHERE company_email LIKE '${PREFIX}%'`);
}

const [cmd, arg] = process.argv.slice(2);
try {
  const cid = await company();
  if (cmd === 'clean') {
    await clean(cid);
    out({ cleaned: true });
  } else if (cmd === 'drop-login') {
    await q(`UPDATE users SET is_active = false WHERE email = $1 AND email LIKE '${PREFIX}%'`, [arg]);
    out({ dropped: arg });
  } else if (cmd === 'seed') {
    await clean(cid);
    const { rows: depts } = await q(`SELECT name FROM master_departments WHERE is_active ORDER BY name LIMIT 2`);
    const { rows: [role] } = await q(`SELECT id FROM roles WHERE LOWER(code) = 'employee' LIMIT 1`);
    const heads = [];
    for (const [i, last] of ['Alpha', 'Bravo'].entries()) {
      const email = `${PREFIX}${last.toLowerCase()}@example.com`;
      const { rows: [e] } = await q(
        `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation, status, joining_date)
         VALUES ($1, $2, 'Dhui', $3, $4, $5, 'Engineer', 'Active', '2026-01-05') RETURNING id`,
        [cid, `EMP97${i + 1}0`, last, email, depts[i % depts.length].name]);
      const { rows: [u] } = await q(
        `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
         VALUES ($1, $2, 'not-a-real-hash', 'employee', true, $3, $4) RETURNING id`,
        [`Dhui ${last}`, email, cid, e.id]);
      await q(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1, $2, true)`, [u.id, cid]);
      if (role) await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [u.id, role.id]);
      heads.push({ name: `Dhui ${last}`, email, employee_id: e.id, office_id: `EMP97${i + 1}0` });
    }
    out({ company_id: cid, department: depts[0].name, heads });
  } else {
    console.error('usage: seed | drop-login <email> | clean');
    process.exit(2);
  }
} finally {
  await client.end();
}
