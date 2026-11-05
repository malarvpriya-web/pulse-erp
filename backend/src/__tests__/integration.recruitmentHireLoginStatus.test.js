/**
 * Recruitment hire: `loginProvisioned` is true only when a login was created.
 *
 * hireCandidate() set loginProvisioned = true whenever createEmployeeLogin()
 * did not throw — but that helper returns null WITHOUT throwing when it skips
 * (no e-mail, or an account already exists for the address). Such hires were
 * reported, and written onto the auto-creation checklist as "Login account
 * created", although no login had been created. Now:
 *
 *   loginStatus  'created'          loginProvisioned true
 *                'existing_account' false — the existing account is untouched
 *                'no_email'         false
 *                'failed'           false — the helper threw
 *
 * Both entry points are covered: hireCandidate() directly, and
 * autoCreateEmployeeFromCandidate() (the path every automatic hire takes),
 * whose creation-log checklist now says why when no login was created.
 *
 * Real database. createEmployeeLogin is the real function, wrapped only so one
 * marked address can be made to throw. Fixtures: test company 999938, deleted
 * by captured id.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

// Shared tables, real bcrypt: allow for the 4-worker suite.
vi.setConfig({ testTimeout: 20000 });

const FAIL_MARK = 'zz.hirelogin.fail.';
vi.mock('../employees/employee.service.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    createEmployeeLogin: vi.fn(async (client, emp) => {
      if (String(emp.company_email || '').startsWith(FAIL_MARK)) throw new Error('simulated provisioning failure');
      return orig.createEmployeeLogin(client, emp);
    }),
  };
});

const { default: pool }                  = await import('../config/db.js');
const { default: recruitmentRepository } = await import('../modules/recruitment/repositories/recruitment.repository.js');
const { default: bcrypt }                = await import('bcryptjs');

const COMPANY = 999938;
const stamp = Date.now();
let seq = 0;
const nextEmail = (kind) => `zz.hirelogin.${kind}.${stamp}.${++seq}@example.com`;

const created = { employees: [], users: [], candidates: [], jobs: [] };
let jobId;

/**
 * Cleanup statement, retried on a deadlock: deleting candidates cascades into
 * many child tables while the recruitment suites sweep candidates in parallel.
 * Every statement here is an idempotent DELETE by captured id.
 */
async function cleanupQuery(sql, params) {
  for (let attempt = 1; ; attempt++) {
    try { return await pool.query(sql, params); }
    catch (e) {
      if (e.code !== '40P01' || attempt >= 5) throw e;
      await new Promise(r => { setTimeout(r, 100 * attempt); });
    }
  }
}

async function newCandidate(email, stage = 'applied') {
  const { rows: [c] } = await pool.query(
    `INSERT INTO candidates (company_id, full_name, email, phone, applied_job_id, current_stage)
     VALUES ($1, $2, $3, '9000000000', $4, $5) RETURNING id`,
    [COMPANY, `ZZHL Hire${++seq}`, email, jobId, stage]);
  created.candidates.push(c.id);
  return c.id;
}

async function hire(email) {
  const candId = await newCandidate(email);
  const result = await recruitmentRepository.hireCandidate(candId, COMPANY);
  created.employees.push(result.employee.id);
  return result;
}

async function anExistingAccount() {
  const email = nextEmail('existing');
  const hash = await bcrypt.hash('ZzHl-Existing-Own-1', 10);
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, must_change_password)
     VALUES ('ZZHL Existing', $1, $2, 'manager', true, $3, false) RETURNING id, email`, [email, hash, COMPANY]);
  created.users.push(u.id);
  return u;
}

const snapshotUser = async (id) => ({
  user:  (await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0],
  roles: (await pool.query('SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id', [id])).rows,
  scope: (await pool.query('SELECT company_id, branch_id, is_primary FROM user_scope WHERE user_id = $1 ORDER BY company_id', [id])).rows,
});

beforeAll(async () => {
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, 'ZZHL Hire Login Fixture', 'ZZHL')
     ON CONFLICT (id) DO NOTHING`, [COMPANY]);
  const { rows: [{ name: dept }] } = await pool.query(
    `SELECT name FROM master_departments WHERE is_active ORDER BY id LIMIT 1`);
  const { rows: [job] } = await pool.query(
    `INSERT INTO job_openings (company_id, job_title, department) VALUES ($1, 'ZZHL Technician', $2) RETURNING id`,
    [COMPANY, dept]);
  jobId = job.id;
  created.jobs.push(job.id);
});

afterAll(async () => {
  const emp = created.employees;
  const { rows } = await cleanupQuery(
    `SELECT id FROM users WHERE employee_id = ANY($1::int[]) OR id = ANY($2::int[])`, [emp, created.users]);
  const uids = rows.map(r => r.id);
  if (uids.length) {
    await cleanupQuery('DELETE FROM password_reset_otps WHERE user_id = ANY($1::int[])', [uids]);
    await cleanupQuery('DELETE FROM user_roles WHERE user_id = ANY($1::int[])', [uids]);
    await cleanupQuery('DELETE FROM user_scope WHERE user_id = ANY($1::int[])', [uids]);
    await cleanupQuery('DELETE FROM users WHERE id = ANY($1::int[])', [uids]);
  }
  if (created.candidates.length) {
    await cleanupQuery('DELETE FROM recruitment_employee_creation_log WHERE candidate_id = ANY($1::int[])', [created.candidates]);
  }
  if (emp.length) {
    await cleanupQuery('DELETE FROM employee_salary_assignments WHERE employee_id = ANY($1::int[])', [emp]);
    await cleanupQuery('DELETE FROM employees WHERE id = ANY($1::int[])', [emp]);
  }
  if (created.candidates.length) await cleanupQuery('DELETE FROM candidates WHERE id = ANY($1::int[])', [created.candidates]);
  if (created.jobs.length) await cleanupQuery('DELETE FROM job_openings WHERE id = ANY($1::int[])', [created.jobs]);
});

// ── hireCandidate() ───────────────────────────────────────────────────────────
describe('hireCandidate — a new address', () => {
  it('creates and links a login and reports it', async () => {
    const email = nextEmail('new');
    const r = await hire(email);
    expect(r.loginProvisioned).toBe(true);
    expect(r.loginStatus).toBe('created');

    const { rows: [u] } = await pool.query('SELECT * FROM users WHERE employee_id = $1', [r.employee.id]);
    expect(u).toMatchObject({ email, company_id: COMPANY, role: 'employee', is_active: true, must_change_password: true });
    const { rows: roles } = await pool.query(
      `SELECT LOWER(r.code) AS code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [u.id]);
    expect(roles.map(x => x.code)).toContain('employee');
    const { rows: scope } = await pool.query('SELECT company_id, is_primary FROM user_scope WHERE user_id = $1', [u.id]);
    expect(scope).toEqual([{ company_id: COMPANY, is_primary: true }]);
  });
});

describe('hireCandidate — an address that already has an account', () => {
  let existing, before, r;
  beforeAll(async () => {
    existing = await anExistingAccount();
    before = await snapshotUser(existing.id);
    // Upper-case on the candidate: still the same login (logins are case-insensitive).
    r = await hire(existing.email.toUpperCase());
  });

  it('reports that no login was created, and why', () => {
    expect(r.loginProvisioned).toBe(false);
    expect(r.loginStatus).toBe('existing_account');
  });

  it('still creates the employee', async () => {
    const { rows: [e] } = await pool.query('SELECT company_id, source_candidate_id FROM employees WHERE id = $1', [r.employee.id]);
    expect(e.company_id).toBe(COMPANY);
  });

  it('leaves the existing account exactly as it was — row, password, roles, scope, link', async () => {
    expect(await snapshotUser(existing.id)).toEqual(before);
    expect(await bcrypt.compare('ZzHl-Existing-Own-1', before.user.password_hash)).toBe(true);
    expect(before.user.employee_id).toBeNull();
  });

  it('creates no second account and links none to the new employee', async () => {
    const { rows } = await pool.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [existing.email]);
    expect(rows).toHaveLength(1);
    const { rows: linked } = await pool.query('SELECT id FROM users WHERE employee_id = $1', [r.employee.id]);
    expect(linked).toEqual([]);
  });
});

describe('hireCandidate — the other two skip / failure cases', () => {
  it('a candidate with no e-mail: no login, loginStatus no_email', async () => {
    const r = await hire(null);
    expect(r.loginProvisioned).toBe(false);
    expect(r.loginStatus).toBe('no_email');
  });

  it('provisioning that throws: no login, loginStatus failed, and the hire still completes', async () => {
    const r = await hire(`${FAIL_MARK}${stamp}@example.com`);
    expect(r.loginProvisioned).toBe(false);
    expect(r.loginStatus).toBe('failed');
    expect(r.employee.id).toEqual(expect.any(Number));
  });
});

// ── autoCreateEmployeeFromCandidate(): the creation-log checklist ─────────────
describe('auto-creation checklist', () => {
  const checklistFor = async (candidateId) => {
    const { rows: [log] } = await pool.query(
      `SELECT status, checklist_items FROM recruitment_employee_creation_log WHERE candidate_id = $1`, [candidateId]);
    const items = typeof log.checklist_items === 'string' ? JSON.parse(log.checklist_items) : log.checklist_items;
    return { status: log.status, login: items.find(i => i.task === 'Login account created') };
  };
  const autoCreate = async (email) => {
    const candId = await newCandidate(email, 'hired');
    const res = await recruitmentRepository.autoCreateEmployeeFromCandidate(candId, COMPANY);
    expect(res.status, JSON.stringify(res)).toBe(201);
    created.employees.push(res.employee.id);
    return candId;
  };

  it('a new login is ticked, with no note', async () => {
    const { status, login } = await checklistFor(await autoCreate(nextEmail('auto')));
    expect(status).toBe('completed');
    expect(login).toEqual({ task: 'Login account created', done: true });
  });

  it('an existing account is NOT ticked, and the note says why', async () => {
    const existing = await anExistingAccount();
    const before = await snapshotUser(existing.id);
    const { login } = await checklistFor(await autoCreate(existing.email));
    expect(login.done).toBe(false);
    expect(login.note).toMatch(/already exists/);
    expect(await snapshotUser(existing.id)).toEqual(before);
  });
});
