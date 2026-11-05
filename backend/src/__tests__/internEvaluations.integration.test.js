/**
 * Intern mentor evaluation + HR review — through the real routers, real logins,
 * real database.
 *
 * Covers mentor ownership (current mentor only, active, same company, linked
 * login), that a mentor gains NO general internship access, cross-company
 * isolation, the submit / return / revise / resubmit / approve transitions,
 * self-approval refusal, the approve permission, and the audit trail.
 *
 * Registry tenants 999954 / 999955 (testTenantIds.contract); removed in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { default: bcrypt } = await import('bcryptjs');
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { loginUser } = await import('../auth/auth.service.js');
const { default: evalRouter } = await import('../modules/hr/internEvaluations.routes.js');
const { default: internRouter } = await import('../modules/hr/internships.routes.js');

const OWN = 999954;
const FOREIGN = 999955;
const PW = 'Zz-Eval-Test-9!';
const fx = { tok: {}, emp: {}, user: {} };

const app = express();
app.use(express.json());
app.use('/api/intern-evaluations', verifyToken, evalRouter);
app.use('/api/interns', verifyToken, internRouter);

const as = (who) => ({ Authorization: `Bearer ${fx.tok[who]}` });
const save = (who, internId, body) => request(app).put(`/api/intern-evaluations/mine/${internId}`).set(as(who)).send(body);
const submit = (who, internId, body = {}) => request(app).post(`/api/intern-evaluations/mine/${internId}/submit`).set(as(who)).send(body);
const review = (who, id, body) => request(app).post(`/api/intern-evaluations/${id}/review`).set(as(who)).send(body);
const RATINGS = { technical_skills: 4, communication: 4, teamwork: 5, discipline_attendance: 4, learning_ability: 5, overall_performance: 4 };
const GOOD = { comments: 'Delivered the dashboard module on time; strong SQL.', recommendation: 'Recommended for Employment', ...RATINGS };

async function cleanup() {
  const c = [OWN, FOREIGN];
  await pool.query(`DELETE FROM intern_evaluation_events WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM intern_evaluations WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM interns WHERE company_id = ANY($1::int[])`, [c]);
  const users = `SELECT id FROM users WHERE email LIKE 'zz.ieval.%@example.com'`;
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.ieval.%@example.com'`);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

beforeAll(async () => {
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ Eval Own','ZZEVO'), ($2,'ZZ Eval Foreign','ZZEVF')`, [OWN, FOREIGN]);
  const dept = (await pool.query(`SELECT name FROM master_departments WHERE is_active ORDER BY id LIMIT 1`)).rows[0].name;
  const desig = (await pool.query(`SELECT name FROM master_designations WHERE is_active ORDER BY id LIMIT 1`)).rows[0].name;
  let n = 0;
  const emp = async (key, cid, status = 'Active') => {
    n += 1;
    fx.emp[key] = (await pool.query(
      `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation, status, joining_date)
       VALUES ($1,$2,'Zz',$3,$4,$5,$6,$7,'2025-01-01') RETURNING id`,
      [cid, `EMP954${String(n).padStart(3, '0')}`, key, `zz.ieval.emp.${key}@example.com`, dept, desig, status])).rows[0].id;
  };
  await emp('mentor', OWN); await emp('mentor2', OWN); await emp('other', OWN);
  await emp('hrMentor', OWN); await emp('left', OWN); await emp('foreignMentor', FOREIGN);

  const hash = await bcrypt.hash(PW, 4);
  const login = async (key, role, cid, employeeId = null) => {
    const email = `zz.ieval.${key}@example.com`;
    fx.user[key] = (await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
       VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`, [`Zz ${key}`, email, hash, role, cid, employeeId])).rows[0].id;
    await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [fx.user[key], cid]);
    fx.tok[key] = (await loginUser(email, PW)).token;
  };
  await login('mentor', 'employee', OWN, fx.emp.mentor);
  await login('mentor2', 'manager', OWN, fx.emp.mentor2);
  await login('other', 'employee', OWN, fx.emp.other);
  await login('left', 'employee', OWN, fx.emp.left);
  await login('unlinked', 'employee', OWN, null);
  await login('hr', 'hr', OWN, null);
  await login('hrMentor', 'hr', OWN, fx.emp.hrMentor);
  await login('hrManager', 'hr_manager', OWN, null);
  await login('hrExec', 'hr_exec', OWN, null);
  await login('foreignMentor', 'employee', FOREIGN, fx.emp.foreignMentor);
  await login('foreignHr', 'hr', FOREIGN, null);

  let code = 0;
  const intern = async (cid, mentor, name) => {
    code += 1;
    return (await pool.query(
      `INSERT INTO interns (company_id, intern_code, first_name, college, course, department, designation,
                            mentor_employee_id, start_date, end_date, status)
       VALUES ($1,$2,$3,'ZZ College','BE/BTech',$4,$5,$6,'2026-07-01','2026-09-30','Active') RETURNING id`,
      [cid, `INT${String(code).padStart(3, '0')}`, name, dept, desig, mentor])).rows[0].id;
  };
  fx.i1 = await intern(OWN, fx.emp.mentor, 'Main');
  fx.i2 = await intern(OWN, fx.emp.hrMentor, 'HrMentored');
  fx.i3 = await intern(OWN, fx.emp.mentor, 'Reassigned');
  fx.i4 = await intern(OWN, fx.emp.left, 'LeftMentor');
  fx.iF = await intern(FOREIGN, fx.emp.foreignMentor, 'Foreign');
  // The mentor of i4 has since left; set AFTER the intern so the insert-time
  // mentor guard (which accepts any same-company employee) is not the gate here.
  await pool.query(`UPDATE employees SET status = 'Left' WHERE id = $1`, [fx.emp.left]);
});

afterAll(cleanup);

// ═════════════════════════════════════════════════════════════════════════════
describe('migration', () => {
  it('created the tables without creating or approving anything for existing interns', async () => {
    // A migration-made row would have no creator and no trail. Every row the
    // API makes has both — so this holds however many real evaluations exist.
    const { rows } = await pool.query(
      // Test tenants (9999xx) are excluded: sibling suites insert fixture
      // evaluations directly, and run in parallel with this one.
      `SELECT COUNT(*)::int AS n FROM intern_evaluations ev
        WHERE ev.company_id / 100 <> 9999
          AND (ev.created_by_user_id IS NULL
               OR NOT EXISTS (SELECT 1 FROM intern_evaluation_events x WHERE x.evaluation_id = ev.id AND x.action = 'created'))`);
    expect(rows[0].n).toBe(0);
    const { rows: approved } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM intern_evaluations ev
        WHERE ev.status = 'Approved' AND ev.company_id / 100 <> 9999
          AND NOT EXISTS (SELECT 1 FROM intern_evaluation_events x WHERE x.evaluation_id = ev.id AND x.action = 'approved')`);
    expect(approved[0].n).toBe(0);
  });

  it('grants internships:approve to super_admin, admin, hr, hr_manager only', async () => {
    const { rows } = await pool.query(
      `SELECT LOWER(r.code) AS code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE rp.module = 'internships' AND rp.can_approve ORDER BY 1`);
    expect(rows.map(r => r.code)).toEqual(['admin', 'hr', 'hr_manager', 'super_admin']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('mentor ownership', () => {
  it('the current mentor sees their intern and can save a draft', async () => {
    const mine = await request(app).get('/api/intern-evaluations/mine').set(as('mentor'));
    expect(mine.status).toBe(200);
    expect(mine.body.interns.map(i => i.id).sort()).toEqual([fx.i1, fx.i3].sort());
    const r = await save('mentor', fx.i1, { comments: 'First thoughts', recommendation: 'Extend Internship' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'Draft', intern_id: fx.i1, mentor_employee_id: fx.emp.mentor,
      comments: 'First thoughts', recommendation: 'Extend Internship', submitted_at: null });
    fx.eval1 = r.body.id;
  });

  it('a body company_id is ignored — the evaluation belongs to the intern\'s company', async () => {
    const r = await save('mentor', fx.i1, { ...GOOD, company_id: FOREIGN });
    expect(r.status).toBe(200);
    const { rows } = await pool.query(`SELECT company_id FROM intern_evaluations WHERE id = $1`, [fx.eval1]);
    expect(rows[0].company_id).toBe(OWN);
  });

  // 404 for a linked employee who is not this intern's mentor (no hint whether
  // the intern exists); 403 for an HR login with no employee record at all.
  it.each([
    ['another employee', 'other', 404],
    ['an HR user with no employee record', 'hr', 403],
    ['an HR user who mentors a different intern', 'hrMentor', 404],
    ['a mentor from another company', 'foreignMentor', 404],
  ])('%s cannot save or submit', async (_label, who, status) => {
    expect((await save(who, fx.i1, GOOD)).status).toBe(status);
    expect((await submit(who, fx.i1, GOOD)).status).toBe(status);
  });

  it('a login with no employee link is refused', async () => {
    expect((await save('unlinked', fx.i1, GOOD)).status).toBe(403);
  });

  it('a mentor who is no longer a current employee is refused', async () => {
    expect((await save('left', fx.i4, GOOD)).status).toBe(404);
    const mine = await request(app).get('/api/intern-evaluations/mine').set(as('left'));
    expect(mine.body.interns).toEqual([]);
  });

  it('after reassignment only the NEW mentor may evaluate', async () => {
    expect((await save('mentor', fx.i3, GOOD)).status).toBe(200);
    await pool.query(`UPDATE interns SET mentor_employee_id = $1 WHERE id = $2`, [fx.emp.mentor2, fx.i3]);
    expect((await save('mentor', fx.i3, GOOD)).status).toBe(404);
    expect((await submit('mentor', fx.i3)).status).toBe(404);
    expect((await save('mentor2', fx.i3, GOOD)).status).toBe(200);
  });

  it('rejects an unknown recommendation and over-long comments', async () => {
    let r = await save('mentor', fx.i1, { comments: 'x', recommendation: 'Hire Immediately' });
    expect([r.status, r.body.field]).toEqual([400, 'recommendation']);
    r = await save('mentor', fx.i1, { comments: 'x'.repeat(5001) });
    expect([r.status, r.body.field]).toEqual([400, 'comments']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('a mentor gains no general internship access', () => {
  it.each(['mentor', 'mentor2'])('%s is refused the register, the record, the edit and the HR endpoints', async (who) => {
    expect((await request(app).get('/api/interns').set(as(who))).status).toBe(403);
    expect((await request(app).get(`/api/interns/${fx.i1}`).set(as(who))).status).toBe(403);
    expect((await request(app).put(`/api/interns/${fx.i1}`).set(as(who)).send({ first_name: 'x' })).status).toBe(403);
    expect((await request(app).get('/api/intern-evaluations').set(as(who))).status).toBe(403);
    expect((await request(app).get(`/api/intern-evaluations/intern/${fx.i1}`).set(as(who))).status).toBe(403);
    expect((await review(who, fx.eval1, { decision: 'Approve' })).status).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('submit → return → revise → resubmit → approve', () => {
  it('cannot submit without comments and a recommendation', async () => {
    let r = await submit('mentor', fx.i1, { ...RATINGS, comments: '', recommendation: 'Recommended for Employment' });
    expect([r.status, r.body.field]).toEqual([400, 'comments']);
    r = await submit('mentor', fx.i1, { ...RATINGS, comments: 'Fine', recommendation: '' });
    expect([r.status, r.body.field]).toEqual([400, 'recommendation']);
  });

  it('submits, recording the submitting user and time', async () => {
    const r = await submit('mentor', fx.i1, GOOD);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'Submitted', submitted_by_user_id: fx.user.mentor, ...GOOD });
    expect(r.body.submitted_at).toBeTruthy();
  });

  it('a submitted evaluation is locked against the mentor until HR returns it', async () => {
    expect((await save('mentor', fx.i1, { comments: 'sneaky edit' })).status).toBe(409);
    expect((await submit('mentor', fx.i1)).status).toBe(409);
  });

  it('appears in the HR queue of its own company only', async () => {
    const own = await request(app).get('/api/intern-evaluations').set(as('hr'));
    expect(own.body.map(e => e.id)).toContain(fx.eval1);
    const foreign = await request(app).get('/api/intern-evaluations').set(as('foreignHr'));
    expect(foreign.body.map(e => e.id)).not.toContain(fx.eval1);
    expect((await request(app).get(`/api/intern-evaluations/intern/${fx.i1}`).set(as('foreignHr'))).status).toBe(404);
  });

  it('another company\'s HR cannot review it', async () => {
    expect((await review('foreignHr', fx.eval1, { decision: 'Approve' })).status).toBe(404);
  });

  it('hr_exec can see it but cannot review it', async () => {
    expect((await request(app).get('/api/intern-evaluations').set(as('hrExec'))).status).toBe(200);
    expect((await review('hrExec', fx.eval1, { decision: 'Approve' })).status).toBe(403);
  });

  it('a return needs a reason', async () => {
    const r = await review('hr', fx.eval1, { decision: 'Return', reason: '  ' });
    expect([r.status, r.body.field]).toEqual([400, 'reason']);
    expect((await review('hr', fx.eval1, { decision: 'Maybe' })).status).toBe(400);
  });

  it('HR returns it with a reason', async () => {
    const r = await review('hr', fx.eval1, { decision: 'Return', reason: 'Please comment on attendance.' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'Returned', reviewed_by_user_id: fx.user.hr, return_reason: 'Please comment on attendance.' });
  });

  it('the mentor revises the returned evaluation and resubmits; the old decision is cleared from the row', async () => {
    const revised = { ...RATINGS, comments: 'Attendance 96%. Delivered on time.', recommendation: 'Recommended for Employment' };
    let r = await save('mentor', fx.i1, revised);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'Returned', ...revised });
    r = await submit('mentor', fx.i1);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'Submitted', reviewed_by_user_id: null, reviewed_at: null, return_reason: null });
  });

  it('HR approves; a decided evaluation cannot be reviewed again', async () => {
    const r = await review('hrManager', fx.eval1, { decision: 'Approve' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'Approved', reviewed_by_user_id: fx.user.hrManager, return_reason: null });
    expect((await review('hr', fx.eval1, { decision: 'Return', reason: 'late change' })).status).toBe(409);
  });

  it('an approved evaluation is never edited; a new save starts a separate draft', async () => {
    const r = await save('mentor', fx.i1, { comments: 'Next cycle' });
    expect(r.status).toBe(200);
    expect(r.body.id).not.toBe(fx.eval1);
    const { rows } = await pool.query(`SELECT status, comments FROM intern_evaluations WHERE id = $1`, [fx.eval1]);
    expect(rows[0]).toEqual({ status: 'Approved', comments: 'Attendance 96%. Delivered on time.' });
  });

  it('nothing about the internship itself changed', async () => {
    const { rows } = await pool.query(
      `SELECT status, completed_on, certificate_issued FROM interns WHERE id = $1`, [fx.i1]);
    expect(rows[0]).toEqual({ status: 'Active', completed_on: null, certificate_issued: false });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('self-approval', () => {
  it('an HR user who mentors the intern can submit but not review their own evaluation', async () => {
    const s = await submit('hrMentor', fx.i2, GOOD);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    fx.evalSelf = s.body.id;
    const self = await review('hrMentor', fx.evalSelf, { decision: 'Approve' });
    expect(self.status).toBe(403);
    expect((await review('hr', fx.evalSelf, { decision: 'Approve' })).status).toBe(200);
  });

  it('the database refuses a row whose reviewer is its submitter', async () => {
    await expect(pool.query(
      `UPDATE intern_evaluations SET reviewed_by_user_id = submitted_by_user_id WHERE id = $1`, [fx.evalSelf]))
      .rejects.toThrow(/intern_evaluations_no_self_review/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('audit trail', () => {
  it('records every step with actor, transition, decision and reason', async () => {
    const r = await request(app).get(`/api/intern-evaluations/intern/${fx.i1}`).set(as('hr'));
    expect(r.status).toBe(200);
    const ev = r.body.find(e => e.id === fx.eval1);
    expect(ev.events.map(x => [x.action, x.from_status, x.to_status])).toEqual([
      ['created', null, 'Draft'],
      ['saved', 'Draft', 'Draft'],
      ['saved', 'Draft', 'Draft'],              // the content sent WITH the submit
      ['submitted', 'Draft', 'Submitted'],
      ['returned', 'Submitted', 'Returned'],
      ['saved', 'Returned', 'Returned'],
      ['submitted', 'Returned', 'Submitted'],
      ['approved', 'Submitted', 'Approved'],
    ]);
    const returned = ev.events.find(x => x.action === 'returned');
    expect(returned).toMatchObject({ actor_user_id: fx.user.hr, reason: 'Please comment on attendance.' });
    expect(ev.events.find(x => x.action === 'approved').actor_user_id).toBe(fx.user.hrManager);
    expect(ev.events.find(x => x.action === 'submitted').actor_user_id).toBe(fx.user.mentor);
  });

  it('a direct submit (no prior draft) records the creation as well as the submit', async () => {
    const r = await request(app).get(`/api/intern-evaluations/intern/${fx.i2}`).set(as('hr'));
    const ev = r.body.find(e => e.id === fx.evalSelf);
    expect(ev.events.map(x => [x.action, x.from_status, x.to_status])).toEqual([
      ['created', null, 'Draft'],
      ['submitted', 'Draft', 'Submitted'],
      ['approved', 'Submitted', 'Approved'],
    ]);
  });

  it('stores a snapshot with each event, and the trail cannot be rewritten', async () => {
    const { rows } = await pool.query(
      `SELECT id, snapshot FROM intern_evaluation_events WHERE evaluation_id = $1 AND action = 'returned'`, [fx.eval1]);
    expect(rows[0].snapshot).toMatchObject({ status: 'Returned', return_reason: 'Please comment on attendance.' });
    await expect(pool.query(`UPDATE intern_evaluation_events SET reason = 'edited' WHERE id = $1`, [rows[0].id]))
      .rejects.toThrow(/append-only/);
  });

  it('writes audit_logs entries for the decisions', async () => {
    let rows = [];
    for (let i = 0; i < 20 && rows.length < 3; i++) {
      ({ rows } = await pool.query(
        `SELECT action_type, user_id FROM audit_logs
          WHERE reference_type = 'intern_evaluation' AND reference_id = $1::text ORDER BY id`, [String(fx.eval1)]));
      if (rows.length < 3) await new Promise(r => { setTimeout(r, 100); });
    }
    const actions = rows.map(r => r.action_type);
    expect(actions).toEqual(expect.arrayContaining(['submit', 'reject', 'approve']));
    expect(rows.find(r => r.action_type === 'approve').user_id).toBe(fx.user.hrManager);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('mentor discovery (GET /mine/summary, drives the navigation entry)', () => {
  const summary = (who) => request(app).get('/api/intern-evaluations/mine/summary').set(as(who));

  it('a current mentor is told so, with counts only', async () => {
    const r = await summary('mentor');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ linked: true, is_mentor: true, interns: 1, needs_action: 1 });
    // fx.i1 has an approved evaluation and a newer draft, so it still needs action.
  });

  it.each([
    ['an employee who mentors nobody', 'other', { linked: true, is_mentor: false }],
    ['a mentor who is no longer a current employee', 'left', { linked: true, is_mentor: false }],
    ['a login with no employee record', 'unlinked', { linked: false, is_mentor: false }],
    ['an HR user with no employee record', 'hr', { linked: false, is_mentor: false }],
  ])('%s is not a mentor', async (_label, who, want) => {
    expect((await summary(who)).body).toMatchObject(want);
  });

  it("another company's mentor is counted only within their own company", async () => {
    expect((await summary('foreignMentor')).body).toMatchObject({ is_mentor: true, interns: 1 });
  });

  it('a manager is a mentor only while assigned: the role alone grants nothing', async () => {
    // mentor2 (role manager) received i3 by reassignment earlier in this suite.
    expect((await summary('mentor2')).body).toMatchObject({ is_mentor: true, interns: 1 });
    await pool.query(`UPDATE interns SET mentor_employee_id = $1 WHERE id = $2`, [fx.emp.mentor, fx.i3]);
    expect((await summary('mentor2')).body).toMatchObject({ is_mentor: false, interns: 0 });
    // …and as a former mentor they can no longer open or write that evaluation.
    const mine = await request(app).get('/api/intern-evaluations/mine').set(as('mentor2'));
    expect(mine.body.interns).toEqual([]);
    expect((await save('mentor2', fx.i3, GOOD)).status).toBe(404);
  });

  it('a former mentor loses discovery once their last intern is reassigned', async () => {
    expect((await summary('hrMentor')).body.is_mentor).toBe(true);
    await pool.query(`UPDATE interns SET mentor_employee_id = $1 WHERE id = $2`, [fx.emp.mentor2, fx.i2]);
    expect((await summary('hrMentor')).body).toMatchObject({ is_mentor: false, interns: 0 });
  });

  it('discovery grants no HR review access, and HR review still works by permission alone', async () => {
    for (const who of ['mentor', 'mentor2']) {
      expect((await request(app).get('/api/intern-evaluations').set(as(who))).status).toBe(403);
      expect((await request(app).get('/api/interns').set(as(who))).status).toBe(403);
    }
    expect((await request(app).get('/api/intern-evaluations').set(as('hr'))).status).toBe(200);
    expect((await request(app).get(`/api/intern-evaluations/intern/${fx.i1}`).set(as('hrExec'))).status).toBe(200);
  });
});
