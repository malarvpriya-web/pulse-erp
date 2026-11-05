/**
 * integration.projectsTenantIsolation.test.js
 *
 * Driven through the REAL project/timesheet routers against the REAL database.
 *
 * WHY THESE EXIST
 *
 * The Projects module scoped its LIST endpoints carefully — findAll(),
 * getKanbanBoard(), getOverdueTasks() all filter on projects.company_id — and
 * then handed every SINGLE-RECORD path a raw `:id` with no company filter at
 * all. `tasks` has no company_id column of its own, so "scoped by id" meant
 * "not scoped": any authenticated user holding projects.edit could read, update
 * or delete ANY tenant's task, read any tenant's full project P&L, and delete
 * any tenant's budget lines and documents, by guessing an integer.
 *
 * ⚠ EVERY NEGATIVE CASE HERE IS PAIRED WITH A POSITIVE ONE. An isolation suite
 * that only asserts "the other tenant is refused" passes just as happily when
 * the endpoint is broken for EVERYONE — that failure mode has shipped in this
 * repo before. The `own tenant` cases are load-bearing, not padding.
 *
 * Self-cleaning: two synthetic companies and everything under them are removed
 * by sweep(), which runs on the way IN as well as on the way out. It touches no
 * pre-existing row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { FIXTURE_CODE_SQL } from '../shared/employeeCode.js';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
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

const { default: pool }        = await import('../config/db.js');
const { default: projRouter }  = await import('../modules/projects/routes/projects.routes.js');
const { default: tsRouter }    = await import('../modules/timesheets/routes/timesheets.routes.js');

const TAG = 'ZZTENANT';

/** Build an app whose caller belongs to exactly this company. */
function appAs(companyId, roles = ['project_manager']) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId: 1, roles, company_id: companyId };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/api/projects', projRouter);
  app.use('/api', tsRouter);
  return app;
}

const ids = {
  companyA: null, companyB: null,
  employeeA: null,
  projectA: null, projectB: null,
  taskA: null, taskB: null,
  budgetB: null, docB: null,
  tsA: null, tsB: null,
};
let A, B;

async function makeCompany(suffix) {
  const { rows } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`,
    [`${TAG} Co ${suffix}`, `${TAG}${suffix}`]
  );
  return rows[0].id;
}

async function makeProject(companyId, suffix) {
  const { rows } = await pool.query(
    `INSERT INTO projects (project_code, project_name, company_id, status, budget_amount)
     VALUES ($1, $2, $3, 'active', 100000) RETURNING id`,
    [`${TAG}-${suffix}`, `${TAG} Project ${suffix}`, companyId]
  );
  return rows[0].id;
}

async function makeTask(projectId, suffix) {
  const { rows } = await pool.query(
    `INSERT INTO tasks (project_id, task_title, status, priority)
     VALUES ($1, $2, 'todo', 'medium') RETURNING id`,
    [projectId, `${TAG} Task ${suffix}`]
  );
  return rows[0].id;
}

async function makeTimesheet(companyId, projectId, employeeId, suffix) {
  const { rows } = await pool.query(
    `INSERT INTO timesheet_entries
       (company_id, project_id, employee_id, entry_date, work_date, hours, hours_worked, status, description)
     VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE, 4, 4, 'submitted', $4) RETURNING id`,
    [companyId, projectId, employeeId, `${TAG} ${suffix}`]
  );
  return rows[0].id;
}

/**
 * Remove every trace of this suite's synthetic companies.
 *
 * Runs BEFORE the fixtures are built as well as after. A suite that only tidies
 * up on the way out leaks its companies the moment one assertion throws — and
 * because companies.code is UNIQUE, that leak then fails every LATER run at
 * INSERT time, which reads as a broken suite rather than a stale row. Another
 * file in this repo fails exactly that way today.
 */
async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  if (!co.length) return;

  const ourProjects = `(SELECT id FROM projects WHERE company_id = ANY($1))`;
  await pool.query(`DELETE FROM timesheet_entries   WHERE company_id = ANY($1) OR project_id IN ${ourProjects}`, [co]);
  await pool.query(`DELETE FROM tasks               WHERE project_id IN ${ourProjects}`, [co]);
  await pool.query(`DELETE FROM project_budget_lines WHERE company_id = ANY($1) OR project_id IN ${ourProjects}`, [co]);
  await pool.query(`DELETE FROM project_documents   WHERE company_id = ANY($1) OR project_id IN ${ourProjects}`, [co]);
  await pool.query(`DELETE FROM project_risks       WHERE company_id = ANY($1) OR project_id IN ${ourProjects}`, [co]);
  await pool.query(`DELETE FROM project_cost_summary WHERE project_id IN ${ourProjects}`, [co]);
  await pool.query(`DELETE FROM projects            WHERE company_id = ANY($1)`, [co]);

  // ⚠ Anything ELSE that points at these companies, discovered from the schema
  // rather than listed. Route files in this repo run seeders at IMPORT time —
  // talent.routes.js plants 10 interview_questions into EVERY company the
  // moment it is imported — so which tables pin a brand-new company depends on
  // what else the test run happened to import, not on anything this file does.
  // A hand-written table list is stale the next time that happens; this is not.
  // Two passes so FK chains between those tables resolve.
  const { rows: fks } = await pool.query(`
    SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu  ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'companies'`);
  for (let pass = 0; pass < 2; pass++) {
    for (const { table_name, column_name } of fks) {
      try {
        await pool.query(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, [co]);
      } catch { /* FK ordering — the second pass picks it up */ }
    }
  }

  await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

beforeAll(async () => {
  await sweep();
  ids.companyA = await makeCompany('A');
  ids.companyB = await makeCompany('B');

  const { rows: emp } = await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id, status)
     VALUES (${FIXTURE_CODE_SQL}, $1, 'Tester', $2, 'Active') RETURNING id`,
    [`${TAG}`, ids.companyA]
  );
  ids.employeeA = emp[0].id;

  ids.projectA = await makeProject(ids.companyA, 'A');
  ids.projectB = await makeProject(ids.companyB, 'B');
  ids.taskA    = await makeTask(ids.projectA, 'A');
  ids.taskB    = await makeTask(ids.projectB, 'B');

  // Company B's private cost summary, budget line and document.
  await pool.query(
    `INSERT INTO project_cost_summary (project_id, labour_cost, material_cost, total_cost, revenue)
     VALUES ($1, 11111, 22222, 33333, 99999)`,
    [ids.projectB]
  );
  const { rows: bl } = await pool.query(
    `INSERT INTO project_budget_lines (project_id, company_id, category, budgeted_amount, wbs_code)
     VALUES ($1, $2, 'labour', 5000, $3) RETURNING id`,
    [ids.projectB, ids.companyB, `${TAG}-WBS`]
  );
  ids.budgetB = bl[0].id;
  const { rows: doc } = await pool.query(
    `INSERT INTO project_documents (project_id, company_id, document_name, document_type)
     VALUES ($1, $2, $3, 'drawing') RETURNING id`,
    [ids.projectB, ids.companyB, `${TAG} Secret Drawing`]
  );
  ids.docB = doc[0].id;

  ids.tsA = await makeTimesheet(ids.companyA, ids.projectA, ids.employeeA, 'A');
  ids.tsB = await makeTimesheet(ids.companyB, ids.projectB, ids.employeeA, 'B');

  A = appAs(ids.companyA);
  B = appAs(ids.companyB);
});

afterAll(async () => {
  await sweep();
});

// ─── Tasks ───────────────────────────────────────────────────────────────────
describe('task detail / update / delete are scoped by the project\'s company', () => {
  it('refuses to read another tenant\'s task, and still serves its own', async () => {
    const foreign = await request(A).get(`/api/projects/tasks/${ids.taskB}`);
    expect(foreign.status).toBe(404);

    const own = await request(A).get(`/api/projects/tasks/${ids.taskA}`);
    expect(own.status).toBe(200);
    expect(own.body.id).toBe(ids.taskA);
  });

  it('refuses to update another tenant\'s task AND leaves the row untouched', async () => {
    const res = await request(A)
      .put(`/api/projects/tasks/${ids.taskB}`)
      .send({ task_title: 'HIJACKED', status: 'done' });
    expect(res.status).toBe(404);

    // The assertion that matters: not just the status code, but the row.
    const { rows } = await pool.query('SELECT task_title, status FROM tasks WHERE id = $1', [ids.taskB]);
    expect(rows[0].task_title).toBe(`${TAG} Task B`);
    expect(rows[0].status).toBe('todo');
  });

  it('lets the owning tenant update its own task', async () => {
    const res = await request(B)
      .put(`/api/projects/tasks/${ids.taskB}`)
      .send({ status: 'in_progress' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('in_progress');
  });

  it('refuses to delete another tenant\'s task AND leaves it alive', async () => {
    const res = await request(A).delete(`/api/projects/tasks/${ids.taskB}`);
    expect(res.status).toBe(404);

    const { rows } = await pool.query('SELECT deleted_at FROM tasks WHERE id = $1', [ids.taskB]);
    expect(rows[0].deleted_at).toBeNull();
  });

  it('refuses to create a task inside another tenant\'s project', async () => {
    const res = await request(A)
      .post('/api/projects/tasks')
      .send({ project_id: ids.projectB, task_title: `${TAG} planted` });
    expect(res.status).toBe(403);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE project_id = $1 AND task_title = $2`,
      [ids.projectB, `${TAG} planted`]
    );
    expect(rows[0].n).toBe(0);
  });

  it('stores a real employee assignment from assigned_to', async () => {
    const res = await request(A)
      .post('/api/projects/tasks')
      .send({
        project_id: ids.projectA,
        task_title: `${TAG} assigned`,
        task_description: 'has a description too',
        assigned_to: ids.employeeA,
      });
    expect(res.status).toBe(201);
    expect(res.body.assigned_to).toBe(ids.employeeA);
    // task_description is the real column — `description` would be dropped.
    expect(res.body.task_description).toBe('has a description too');

    const detail = await request(A).get(`/api/projects/tasks/${res.body.id}`);
    expect(detail.body.assigned_to_name).toContain(TAG);
  });
});

// ─── Project cost detail ─────────────────────────────────────────────────────
describe('project cost detail is scoped', () => {
  it('does not leak another tenant\'s cost and revenue', async () => {
    for (const path of ['costs', 'costing']) {
      const res = await request(A).get(`/api/projects/projects/${ids.projectB}/${path}`);
      // Falls back to the zeroed shape rather than 404 — the point is that the
      // real figures never appear.
      expect(res.status).toBe(200);
      expect(Number(res.body.total_cost)).toBe(0);
      expect(res.body.revenue ?? null).not.toBe('99999.00');
      expect(JSON.stringify(res.body)).not.toContain('33333');
    }
  });

  it('serves the owning tenant its own cost figures', async () => {
    const res = await request(B).get(`/api/projects/projects/${ids.projectB}/costs`);
    expect(res.status).toBe(200);
    expect(Number(res.body.total_cost)).toBe(33333);
  });
});

// ─── Budget lines ────────────────────────────────────────────────────────────
describe('budget lines are scoped by project ownership', () => {
  it('does not list another tenant\'s budget lines', async () => {
    const foreign = await request(A).get(`/api/projects/projects/${ids.projectB}/budget-lines`);
    expect(foreign.status).toBe(200);
    expect(foreign.body).toHaveLength(0);

    const own = await request(B).get(`/api/projects/projects/${ids.projectB}/budget-lines`);
    expect(own.body).toHaveLength(1);
    expect(own.body[0].id).toBe(ids.budgetB);
  });

  it('refuses to update another tenant\'s budget line AND leaves the amount alone', async () => {
    const res = await request(A)
      .put(`/api/projects/projects/budget-lines/${ids.budgetB}`)
      .send({ category: 'labour', budgeted_amount: 1, actual_amount: 0 });
    expect(res.status).toBe(404);

    const { rows } = await pool.query('SELECT budgeted_amount FROM project_budget_lines WHERE id = $1', [ids.budgetB]);
    expect(Number(rows[0].budgeted_amount)).toBe(5000);
  });

  it('refuses to delete another tenant\'s budget line AND leaves it in place', async () => {
    const res = await request(A).delete(`/api/projects/projects/budget-lines/${ids.budgetB}`);
    expect(res.status).toBe(404);

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM project_budget_lines WHERE id = $1', [ids.budgetB]);
    expect(rows[0].n).toBe(1);
  });

  it('refuses to add a budget line to another tenant\'s project', async () => {
    const res = await request(A)
      .post(`/api/projects/projects/${ids.projectB}/budget-lines`)
      .send({ category: 'planted', budgeted_amount: 999 });
    expect(res.status).toBe(403);
  });

  it('lets the owning tenant delete its own budget line', async () => {
    const res = await request(B).delete(`/api/projects/projects/budget-lines/${ids.budgetB}`);
    expect(res.status).toBe(200);
  });
});

// ─── Documents ───────────────────────────────────────────────────────────────
describe('document delete is scoped by project ownership', () => {
  it('refuses to delete another tenant\'s document AND leaves it in place', async () => {
    const res = await request(A).delete(`/api/projects/projects/documents/${ids.docB}`);
    expect(res.status).toBe(404);

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM project_documents WHERE id = $1', [ids.docB]);
    expect(rows[0].n).toBe(1);
  });

  it('lets the owning tenant delete its own document', async () => {
    const res = await request(B).delete(`/api/projects/projects/documents/${ids.docB}`);
    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM project_documents WHERE id = $1', [ids.docB]);
    expect(rows[0].n).toBe(0);
  });
});

// ─── Timesheets ──────────────────────────────────────────────────────────────
describe('timesheet mutations are tenant-scoped (project cost rollups depend on them)', () => {
  it('refuses to update another tenant\'s entry AND leaves the hours alone', async () => {
    const res = await request(A).put(`/api/timesheets/${ids.tsB}`).send({ hours_worked: 99 });
    expect(res.status).toBe(404);

    const { rows } = await pool.query('SELECT hours_worked FROM timesheet_entries WHERE id = $1', [ids.tsB]);
    expect(Number(rows[0].hours_worked)).toBe(4);
  });

  it('refuses to approve another tenant\'s entry AND leaves the status alone', async () => {
    const res = await request(A).post('/api/timesheets/approve').send({ ids: [ids.tsB], approved_by: null });
    expect(res.status).toBe(404);

    const { rows } = await pool.query('SELECT status FROM timesheet_entries WHERE id = $1', [ids.tsB]);
    expect(rows[0].status).toBe('submitted');
  });

  it('refuses to reject another tenant\'s entry', async () => {
    const res = await request(A).post('/api/timesheets/reject').send({ ids: [ids.tsB], approved_by: null, reason: 'no' });
    expect(res.status).toBe(404);

    const { rows } = await pool.query('SELECT status FROM timesheet_entries WHERE id = $1', [ids.tsB]);
    expect(rows[0].status).toBe('submitted');
  });

  it('refuses to delete another tenant\'s entry AND leaves it alive', async () => {
    const res = await request(A).delete(`/api/timesheets/${ids.tsB}`);
    expect(res.status).toBe(404);

    const { rows } = await pool.query('SELECT deleted_at FROM timesheet_entries WHERE id = $1', [ids.tsB]);
    expect(rows[0].deleted_at).toBeNull();
  });

  it('lets the owning tenant approve its own entry', async () => {
    // Since P0 Task 3 a project_manager may approve only their own team's
    // entries (reporting line or project manager), and this fixture's caller is
    // neither. The point here is the tenant boundary, so approve as a
    // company-wide approver of the owning company.
    const res = await request(appAs(ids.companyB, ['admin'])).post('/api/timesheets/approve').send({ ids: [ids.tsB], approved_by: null });
    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT status FROM timesheet_entries WHERE id = $1', [ids.tsB]);
    expect(rows[0].status).toBe('approved');
  });
});

// ─── Risk contract ───────────────────────────────────────────────────────────
describe('risk scoring speaks one vocabulary', () => {
  it('rejects a risk with no title as 400, not a 500 from the NOT NULL column', async () => {
    const res = await request(A)
      .post(`/api/projects/projects/${ids.projectA}/risks`)
      .send({ description: 'a risk with no title', probability: 'high', impact: 'high' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
  });

  it('scores labels on the same 1-4 ordinal the analytics queries use', async () => {
    const res = await request(A)
      .post(`/api/projects/projects/${ids.projectA}/risks`)
      .send({ title: `${TAG} high/high`, probability: 'high', impact: 'high' });
    expect(res.status).toBe(201);
    expect(res.body.probability).toBe('high');
    expect(res.body.risk_score).toBe(9);   // 3 x 3
  });

  it('does not silently downgrade a critical risk to medium', async () => {
    const res = await request(A)
      .post(`/api/projects/projects/${ids.projectA}/risks`)
      .send({ title: `${TAG} critical`, probability: 'critical', impact: 'critical' });
    expect(res.status).toBe(201);
    expect(res.body.probability).toBe('critical');
    expect(res.body.risk_score).toBe(16);  // 4 x 4, previously 4 (medium x medium)
  });

  it('bands a numeric 1-5 posting instead of collapsing it to medium', async () => {
    const res = await request(A)
      .post(`/api/projects/projects/${ids.projectA}/risks`)
      .send({ title: `${TAG} numeric`, probability: 5, impact: 4 });
    expect(res.status).toBe(201);
    expect(res.body.probability).toBe('critical');
    expect(res.body.impact).toBe('critical');
    expect(res.body.risk_score).toBe(16);
  });

  it('refuses to register a risk against another tenant\'s project', async () => {
    const res = await request(A)
      .post(`/api/projects/projects/${ids.projectB}/risks`)
      .send({ title: `${TAG} planted`, probability: 'low', impact: 'low' });
    expect(res.status).toBe(403);
  });
});
