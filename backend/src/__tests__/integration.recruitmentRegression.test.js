/**
 * integration.recruitmentRegression.test.js
 *
 * Driven through the REAL recruitment/talent routers against the REAL database.
 *
 * WHY THESE EXIST
 *
 * The 2026-09-17 ATS audit found fourteen defects in a module with ZERO
 * automated coverage — none of the 77 backend suites touched a /recruitment or
 * /talent route. Every case below is one of those defects, written so that it
 * FAILS on the code as it stood before the fix. In audit order:
 *
 *   R-01  /talent/* carried no authorization at all — 26 endpoints, readable and
 *         writable by any authenticated role, including roles whose
 *         role_permissions row sets recruitment can_view = false.
 *   R-03  Talent pools: created_by/added_by are employees(id) FKs that the code
 *         filled with a users.id, so POST /pools and POST /pools/:id/members
 *         returned 500 for every user on the system; membership was also split
 *         across two tables, so reads always returned [].
 *   R-04  PUT /agencies/:id COALESCE'd three of twelve columns, so the
 *         Deactivate button — which sends {is_active:false} alone — nulled the
 *         agency's contract terms.
 *   R-06  submit-feedback never checked whether the interview was already
 *         completed, so a second submit walked the candidate another stage.
 *   R-07  createCandidate() double-stringified `skills` on the multipart path,
 *         storing a jsonb STRING SCALAR; one such row made
 *         GET /talent/resumes/skills raise "cannot extract elements from a
 *         scalar" for the whole company.
 *   R-09  PUT /talent/resumes/:id had the same partial-update wipe as R-04.
 *   R-12  /auto-creation/pending returned every hired candidate, including those
 *         whose employee record already existed.
 *   R-13  interview-to-hire counted hires that never had an interview, so the
 *         "ratio" exceeded 100%.
 *   Search — findCandidates() accepted four predicates and no LIMIT.
 *
 * ⚠ EVERY NEGATIVE CASE IS PAIRED WITH A POSITIVE ONE. An authorization suite
 * that only asserts "the unprivileged role is refused" passes just as happily
 * when the endpoint is broken for everyone — a failure mode this repo has
 * shipped before. The privileged cases are load-bearing, not padding.
 *
 * Self-cleaning: one synthetic company and everything under it, swept on the way
 * IN as well as OUT so an assertion that throws cannot poison the next run.
 * Touches no pre-existing row.
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

const { default: pool }           = await import('../config/db.js');
const { default: recruitRouter }  = await import('../modules/recruitment/routes/recruitment.routes.js');
const { default: talentRouter }   = await import('../modules/talent/talent.routes.js');
const { publicRouter: careersPublicRouter,
        adminRouter:  careersAdminRouter } = await import('../modules/recruitment/routes/careers.routes.js');
const { PDFDocument, StandardFonts } = await import('pdf-lib');
const { runCandidateRetention } = await import('../jobs/candidateRetention.cron.js');

/** A real PDF résumé, built in memory — no fixture file to fall out of date. */
async function makeResumePdf(lines) {
  const doc  = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) => page.drawText(l, { x: 50, y: 790 - i * 20, size: 11, font }));
  return Buffer.from(await doc.save());
}

const TAG = 'ZZATS';

// The careers apply route stores the résumé with StorageService.uploadFile,
// which writes uploads/<epoch-ms>_<sanitised name>. This suite used to attach
// 'meera.pdf' and never remove it — one stray file per run (236 had built up).
// The fixture name is now unique to this run, so the stored file is
// unmistakably ours; removeRunUploads() deletes exactly the files matching it,
// in the test's own `finally` (an assertion failure cannot strand it) and again
// in afterAll. The name survives safeFilename() unchanged: [a-z0-9_] only.
const RESUME_BASE = `zz_ats_resume_${process.pid}_${Date.now().toString(36)}`;
const RESUME_NAME = `${RESUME_BASE}.pdf`;
const RUN_UPLOAD = new RegExp(`^\\d+_${RESUME_BASE}\\.pdf$`);

async function removeRunUploads() {
  const { LOCAL_UPLOAD_DIR } = await import('../services/StorageService.js');
  const { readdir, unlink } = await import('node:fs/promises');
  const { join } = await import('node:path');
  let names = [];
  try { names = await readdir(LOCAL_UPLOAD_DIR); } catch { return []; }
  const mine = names.filter((n) => RUN_UPLOAD.test(n));
  for (const n of mine) await unlink(join(LOCAL_UPLOAD_DIR, n)).catch(() => {});
  return mine;
}

const ids = {
  company: null, employee: null,
  recruiterRole: null, outsiderRole: null, viewerRole: null,
  recruiterUser: null, outsiderUser: null, viewerUser: null,
  requisition: null, opening: null,
  candidate: null, candidate2: null,
  pool: null, agency: null, interview: null,
  requisition2: null, opening2: null, closedOpening: null,
};

/**
 * An app whose caller holds a given user id + role.
 *
 * requirePermission() reads role_permissions through user_roles for the real
 * user id, so these two identities differ in exactly the way that matters: the
 * recruiter's role has a recruitment grant, the outsider's role has an explicit
 * row with every flag false. Using a role with NO row at all would prove less —
 * requirePermission fails closed on a missing row, so the test would pass even
 * if the permission lookup were removed entirely.
 */
function appAs(userId, roleCode) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId, id: userId, roles: [roleCode], role: roleCode, company_id: ids.company, employee_id: ids.employee };
    req.scope = { company_id: ids.company };
    next();
  });
  app.use('/api/recruitment', careersAdminRouter);
  app.use('/api/recruitment', recruitRouter);
  app.use('/api/talent', talentRouter);
  return app;
}

/**
 * The open internet: no req.user, no scope, nothing.
 *
 * Deliberately built WITHOUT the auth middleware rather than with a fake
 * anonymous user — the whole claim being tested is that these routes work with
 * no session, and a test harness that quietly supplies one proves nothing.
 */
function publicApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/public', careersPublicRouter);
  return app;
}

let recruiterApp, outsiderApp, viewerApp;

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = $1`, [TAG]);
  const companyId = rows[0]?.id;
  if (companyId) {
    // Children before parents. candidate_stage_history / talent_pool_members
    // cascade from candidates, but the delete order is explicit so a future FK
    // change surfaces here rather than as a mysterious constraint error.
    await pool.query(`DELETE FROM interview_notes WHERE candidate_id IN (SELECT id FROM candidates WHERE company_id = $1)`, [companyId]);
    await pool.query(`DELETE FROM interview_schedules WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM offer_letters WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM job_offers WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM recruitment_employee_creation_log WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM talent_pool_members WHERE pool_id IN (SELECT id FROM talent_pools WHERE company_id = $1)`, [companyId]);
    await pool.query(`DELETE FROM talent_pools WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM recruitment_agencies WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM candidate_retention_log WHERE company_id = $1`, [companyId]);
    // The retention run below queues the anonymised applicant's résumé here.
    await pool.query(`DELETE FROM candidate_resume_purges WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM job_distributions WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM careers_applications WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM careers_portals WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM candidate_applications WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM candidate_stage_history WHERE candidate_id IN (SELECT id FROM candidates WHERE company_id = $1)`, [companyId]);
    await pool.query(`DELETE FROM candidates WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM job_openings WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM job_requisitions WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM employees WHERE company_id = $1`, [companyId]);
  }
  // interview_questions.company_id FKs companies, and the authorization tests
  // above write a question. Without this the final DELETE FROM companies fails
  // on that constraint, the whole suite errors in beforeAll, and it reads as
  // broken code rather than a leaked fixture. This module has been bitten by
  // exactly this before.
  if (companyId) await pool.query(`DELETE FROM interview_questions WHERE company_id = $1`, [companyId]);
  // LOWER(): trg_users_normalize_email stores every users.email lower-cased, so a
  // case-sensitive LIKE on the upper-case TAG matched nothing and leaked rows.
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE LOWER(email) LIKE LOWER($1))`, [`${TAG}%`]);
  await pool.query(`DELETE FROM users WHERE LOWER(email) LIKE LOWER($1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code LIKE $1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM roles WHERE code LIKE $1`, [`${TAG}%`]);
  if (companyId) await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
}

// `canExport` is a SEPARATE argument, not derived from `grant`, because that is
// exactly the distinction under test: bulk export of candidate PII is a
// different act from reading a record, and the live matrix grants it to 4 of the
// 7 roles that hold view. A fixture that bundled them could not tell the two
// apart.
async function makeRole(code, grant, canExport = grant) {
  const { rows } = await pool.query(
    `INSERT INTO roles (role_name, code, is_active) VALUES ($1, $2, true) RETURNING id`,
    [`${TAG} ${code}`, code]
  );
  const roleId = rows[0].id;
  await pool.query(
    `INSERT INTO role_permissions (role_id, module, can_view, can_add, can_edit, can_delete, can_export)
     VALUES ($1, 'recruitment', $2, $2, $2, $2, $3)`,
    [roleId, grant, canExport]
  );
  return roleId;
}

async function makeUser(email, roleId) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, role, is_active) VALUES ($1, 'employee', true) RETURNING id`,
    [email]
  );
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [rows[0].id, roleId]);
  return rows[0].id;
}

beforeAll(async () => {
  await sweep();

  const { rows: co } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co`, TAG]
  );
  ids.company = co[0].id;

  // employees.name is a GENERATED column (first_name || last_name) — writing it
  // directly raises "cannot insert a non-DEFAULT value".
  const { rows: emp } = await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id) VALUES (${FIXTURE_CODE_SQL}, $1, 'Tester', $2) RETURNING id`,
    [TAG, ids.company]
  );
  ids.employee = emp[0].id;

  ids.recruiterRole = await makeRole(`${TAG}_REC`, true);
  ids.outsiderRole  = await makeRole(`${TAG}_OUT`, false);
  // Full recruitment access, no export. Without this the export tests could only
  // show "denied to someone denied everything", which proves nothing.
  ids.viewerRole    = await makeRole(`${TAG}_VIEW`, true, false);

  ids.recruiterUser = await makeUser(`${TAG}.recruiter@test.invalid`, ids.recruiterRole);
  ids.outsiderUser  = await makeUser(`${TAG}.outsider@test.invalid`,  ids.outsiderRole);
  ids.viewerUser    = await makeUser(`${TAG}.viewer@test.invalid`,    ids.viewerRole);

  recruiterApp = appAs(ids.recruiterUser, `${TAG}_rec`);
  outsiderApp  = appAs(ids.outsiderUser,  `${TAG}_out`);
  viewerApp    = appAs(ids.viewerUser,    `${TAG}_view`);

  const { rows: req } = await pool.query(
    `INSERT INTO job_requisitions (job_title, department, company_id, status, number_of_positions)
     VALUES ($1, 'Engineering', $2, 'approved', 2) RETURNING id`,
    [`${TAG} Electrical Engineer`, ids.company]
  );
  ids.requisition = req[0].id;

  const { rows: op } = await pool.query(
    // salary_min/max and a description are set because the Indeed-feed tests
    // assert on both — a fixture with neither would pass the salary test for
    // the wrong reason.
    `INSERT INTO job_openings
       (requisition_id, job_title, department, location, company_id, status,
        salary_min, salary_max, description, posted_date)
     VALUES ($1, $2, 'Engineering', 'Bengaluru', $3, 'open',
             800000, 1200000, 'Design & test of converters.', CURRENT_DATE) RETURNING id`,
    [ids.requisition, `${TAG} Electrical Engineer`, ids.company]
  );
  ids.opening = op[0].id;

  // A second, genuinely different role to recommend across, plus a closed one
  // to prove the guard.
  const { rows: req2 } = await pool.query(
    `INSERT INTO job_requisitions (job_title, department, company_id, status, number_of_positions)
     VALUES ($1, 'Service', $2, 'approved', 1) RETURNING id`,
    [`${TAG} Service Engineer`, ids.company]
  );
  ids.requisition2 = req2[0].id;
  const { rows: op2 } = await pool.query(
    `INSERT INTO job_openings (requisition_id, job_title, department, location, company_id, status)
     VALUES ($1, $2, 'Service', 'Chennai', $3, 'open') RETURNING id`,
    [ids.requisition2, `${TAG} Service Engineer`, ids.company]
  );
  ids.opening2 = op2[0].id;
  const { rows: opShut } = await pool.query(
    `INSERT INTO job_openings (job_title, department, company_id, status)
     VALUES ($1, 'Service', $2, 'closed') RETURNING id`,
    [`${TAG} Closed Role`, ids.company]
  );
  ids.closedOpening = opShut[0].id;
}, 60000);

afterAll(async () => { await removeRunUploads(); await sweep(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('R-01 — /talent/* enforces the recruitment permission', () => {
  const READS = [
    '/api/talent/resumes', '/api/talent/resumes/stats', '/api/talent/resumes/skills',
    '/api/talent/pools', '/api/talent/agencies', '/api/talent/questions',
    '/api/talent/questions/stats', '/api/talent/recruiter-dashboard',
  ];

  it.each(READS)('refuses %s for a role with recruitment can_view = false', async (path) => {
    const res = await request(outsiderApp).get(path);
    expect(res.status).toBe(403);
  });

  it.each(READS)('allows %s for a role that holds the grant', async (path) => {
    const res = await request(recruiterApp).get(path);
    expect(res.status).toBe(200);
  });

  it('refuses writes from the ungranted role', async () => {
    expect((await request(outsiderApp).post('/api/talent/pools').send({ pool_name: `${TAG} nope` })).status).toBe(403);
    expect((await request(outsiderApp).post('/api/talent/questions').send({ question: `${TAG} nope` })).status).toBe(403);
    expect((await request(outsiderApp).put('/api/talent/resumes/1').send({ notes: 'nope' })).status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('R-07 / location — candidate creation stores usable values', () => {
  it('stores skills as a jsonb ARRAY even when sent as a JSON string', async () => {
    // The multipart path delivers skills as a string; this is that value.
    const res = await request(recruiterApp).post('/api/recruitment/candidates').send({
      full_name: `${TAG} Ravi Kumar`,
      email: `${TAG}.ravi@test.invalid`,
      source: 'website',
      applied_job_id: ids.opening,
      current_company: 'Delta Power',
      experience_years: 3,
      notice_period_days: 30,
      expected_ctc: 1200000,
      location: 'Bengaluru',
      skills: JSON.stringify(['Power Electronics', 'MATLAB']),
    });
    expect(res.status).toBe(201);
    ids.candidate = res.body.id;

    const { rows } = await pool.query(`SELECT jsonb_typeof(skills) AS t, skills, location FROM candidates WHERE id = $1`, [ids.candidate]);
    expect(rows[0].t).toBe('array');
    expect(rows[0].skills).toEqual(['Power Electronics', 'MATLAB']);
    // `location` was accepted by no endpoint before, so this was always NULL.
    expect(rows[0].location).toBe('Bengaluru');
  });

  it('keeps GET /talent/resumes/skills healthy afterwards', async () => {
    // The whole point of R-07: one badly shaped row used to 500 this for the
    // entire company, not just for the offending candidate.
    const res = await request(recruiterApp).get('/api/talent/resumes/skills');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.arrayContaining(['Power Electronics', 'MATLAB']));
  });

  it('rejects a duplicate email with 409 and names the existing candidate', async () => {
    const res = await request(recruiterApp).post('/api/recruitment/candidates').send({
      full_name: `${TAG} Ravi Duplicate`, email: `${TAG}.ravi@test.invalid`, source: 'manual',
    });
    expect(res.status).toBe(409);
    expect(res.body.existing_candidate_id).toBe(ids.candidate);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('candidate search — every filter reaches the database', () => {
  beforeAll(async () => {
    const res = await request(recruiterApp).post('/api/recruitment/candidates').send({
      full_name: `${TAG} Priya Sharma`,
      email: `${TAG}.priya@test.invalid`,
      source: 'referral',
      current_company: 'ABB',
      experience_years: 8,
      notice_period_days: 90,
      location: 'Chennai',
      skills: ['Embedded C'],
    });
    ids.candidate2 = res.body.id;
  });

  const search = (qs) => request(recruiterApp).get(`/api/recruitment/candidates?${qs}`);

  it('returns a paginated envelope, not a bare unbounded array', async () => {
    const res = await search('');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.limit).toBeLessThanOrEqual(500);
  });

  it('filters by location', async () => {
    const res = await search('location=Bengaluru');
    expect(res.body.rows.map(r => r.id)).toContain(ids.candidate);
    expect(res.body.rows.map(r => r.id)).not.toContain(ids.candidate2);
  });

  it('filters by an experience band', async () => {
    expect((await search('experience_min=5')).body.rows.map(r => r.id)).toEqual([ids.candidate2]);
    expect((await search('experience_max=5')).body.rows.map(r => r.id)).toEqual([ids.candidate]);
  });

  it('requires ALL named skills, not any of them', async () => {
    expect((await search('skills=Power Electronics')).body.rows.map(r => r.id)).toContain(ids.candidate);
    expect((await search('skills=Power Electronics,MATLAB')).body.rows.map(r => r.id)).toContain(ids.candidate);
    // One skill present, one absent → no match. An OR implementation returns a row here.
    expect((await search('skills=Power Electronics,Kubernetes')).body.rows.map(r => r.id)).not.toContain(ids.candidate);
  });

  it('treats an unknown notice period as eligible rather than excluded', async () => {
    const res = await search('notice_period_max=30');
    expect(res.body.rows.map(r => r.id)).toContain(ids.candidate);      // 30 days
    expect(res.body.rows.map(r => r.id)).not.toContain(ids.candidate2); // 90 days
  });

  it('searches the employer name, not only name and email', async () => {
    expect((await search('search=Delta')).body.rows.map(r => r.id)).toEqual([ids.candidate]);
  });

  it('combines predicates — the brief\'s own worked example', async () => {
    const res = await search('experience_min=2&location=Bengaluru&skills=Power Electronics&notice_period_max=60');
    expect(res.body.rows.map(r => r.id)).toEqual([ids.candidate]);
  });

  it('ignores an unknown sort column instead of interpolating it', async () => {
    // sort_by is concatenated into the SQL, so it must be allowlisted.
    const res = await search('sort_by=id; DROP TABLE candidates--');
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('R-03 — talent pools are usable', () => {
  it('creates a pool (was 500: users.id written to an employees FK)', async () => {
    const res = await request(recruiterApp).post('/api/talent/pools')
      .send({ pool_name: `${TAG} Power Electronics`, skills: ['Power Electronics'], department: 'Engineering' });
    expect(res.status).toBe(201);
    ids.pool = res.body.data.id;
  });

  it('adds a member and reads it back (was 500, then always [])', async () => {
    const add = await request(recruiterApp).post(`/api/talent/pools/${ids.pool}/members`)
      .send({ candidate_id: ids.candidate, notes: 'strong future hire' });
    expect(add.status).toBe(201);

    const list = await request(recruiterApp).get(`/api/talent/pools/${ids.pool}/members`);
    expect(list.status).toBe(200);
    expect(list.body.data.map(m => m.id)).toEqual([ids.candidate]);
  });

  it('counts that member on the pool list', async () => {
    const res = await request(recruiterApp).get('/api/talent/pools');
    const pool_ = res.body.data.find(p => p.id === ids.pool);
    expect(Number(pool_.member_count)).toBe(1);
  });

  it('refuses a candidate from another company', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM candidates WHERE company_id IS DISTINCT FROM $1 AND deleted_at IS NULL LIMIT 1`, [ids.company]
    );
    if (!rows.length) return; // nothing to test against on a single-tenant database
    const res = await request(recruiterApp).post(`/api/talent/pools/${ids.pool}/members`).send({ candidate_id: rows[0].id });
    expect(res.status).toBe(404);
  });

  it('has a foreign key that makes orphan membership rows impossible', async () => {
    // The absence of these is what let talent_pool_members accumulate rows
    // pointing at pools and candidates that did not exist.
    const { rows } = await pool.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'talent_pool_members'::regclass AND contype = 'f'`
    );
    const names = rows.map(r => r.conname);
    expect(names).toContain('talent_pool_members_pool_id_fkey');
    expect(names).toContain('talent_pool_members_candidate_id_fkey');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('R-04 / R-09 — a partial update patches, it does not replace', () => {
  it('keeps agency contract terms when only is_active is sent', async () => {
    const created = await request(recruiterApp).post('/api/talent/agencies').send({
      name: `${TAG} Agency`, contact_person: 'Meera', email: 'meera@test.invalid',
      phone: '+919111111111', website: 'https://test.invalid', fee_percentage: 8.5,
      payment_terms: '30 days', city: 'Bengaluru', notes: 'Preferred vendor',
    });
    expect(created.status).toBe(201);
    ids.agency = created.body.data.id;

    // Exactly what the Deactivate button sends.
    const res = await request(recruiterApp).put(`/api/talent/agencies/${ids.agency}`).send({ is_active: false });
    expect(res.status).toBe(200);
    const a = res.body.data;
    expect(a.is_active).toBe(false);
    expect(a.email).toBe('meera@test.invalid');
    expect(a.phone).toBe('+919111111111');
    expect(a.website).toBe('https://test.invalid');
    expect(Number(a.fee_percentage)).toBe(8.5);
    expect(a.payment_terms).toBe('30 days');
    expect(a.city).toBe('Bengaluru');
    expect(a.notes).toBe('Preferred vendor');
  });

  it('keeps candidate profile fields when only notes is sent', async () => {
    const res = await request(recruiterApp).put(`/api/talent/resumes/${ids.candidate}`).send({ notes: 'partial patch' });
    expect(res.status).toBe(200);
    const c = res.body.data;
    expect(c.notes).toBe('partial patch');
    expect(c.current_company).toBe('Delta Power');
    expect(Number(c.experience_years)).toBe(3);
    expect(c.notice_period_days).toBe(30);
    expect(Number(c.expected_ctc)).toBe(1200000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('R-06 — interview feedback is one-shot per interview', () => {
  beforeAll(async () => {
    await request(recruiterApp).post(`/api/recruitment/candidates/${ids.candidate}/move-stage`)
      .send({ new_stage: 'screening', notes: 'ok' });
    await request(recruiterApp).post(`/api/recruitment/candidates/${ids.candidate}/move-stage`)
      .send({ new_stage: '1st_level', notes: 'ok' });
    const res = await request(recruiterApp).post('/api/recruitment/interviews').send({
      candidate_id: ids.candidate, interview_date: '2026-09-20',
      interview_time: '10:00', interview_mode: 'video', interviewer_id: ids.employee,
    });
    ids.interview = res.body.id;
  });

  it('accepts the first submission and advances one stage', async () => {
    const res = await request(recruiterApp).post(`/api/recruitment/interviews/${ids.interview}/submit-feedback`)
      .send({ outcome: 'selected', rating: 4, comments: 'strong fundamentals' });
    expect(res.status).toBe(200);
    expect(res.body.next_stage).toBe('2nd_level');
  });

  it('refuses a second submission on the same interview', async () => {
    const res = await request(recruiterApp).post(`/api/recruitment/interviews/${ids.interview}/submit-feedback`)
      .send({ outcome: 'selected', rating: 3, comments: 'second opinion' });
    expect(res.status).toBe(409);
  });

  it('leaves the candidate where the first submission put them', async () => {
    const { rows } = await pool.query(`SELECT current_stage FROM candidates WHERE id = $1`, [ids.candidate]);
    // Before the fix this read 'offer' — two stages from one interview.
    expect(rows[0].current_stage).toBe('2nd_level');
  });

  it('maintains candidates.overall_rating from the notes', async () => {
    const { rows } = await pool.query(`SELECT overall_rating FROM candidates WHERE id = $1`, [ids.candidate]);
    expect(Number(rows[0].overall_rating)).toBe(4);
  });

  it('records an actor on the stage history even without an employee record', async () => {
    const { rows } = await pool.query(
      `SELECT moved_by_user_id FROM candidate_stage_history
        WHERE candidate_id = $1 ORDER BY moved_date DESC LIMIT 1`, [ids.candidate]
    );
    expect(rows[0].moved_by_user_id).toBe(ids.recruiterUser);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('R-13 — interview-to-hire is a rate, not an arbitrary quotient', () => {
  it('never exceeds 100% and reports the uncounted hires separately', async () => {
    const res = await request(recruiterApp).get('/api/recruitment/analytics/interview-to-hire-ratio');
    expect(res.status).toBe(200);
    // The numerator must be a subset of the denominator.
    expect(res.body.hired).toBeLessThanOrEqual(res.body.interviewed);
    expect(res.body.ratio).toBeLessThanOrEqual(100);
    expect(res.body).toHaveProperty('hired_without_interview');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('R-12 — "pending creation" means pending', () => {
  it('excludes a hired candidate who already has an employee record', async () => {
    await pool.query(`UPDATE candidates SET current_stage = 'hired', overall_status = 'hired' WHERE id = $1`, [ids.candidate2]);

    const before = await request(recruiterApp).get('/api/recruitment/auto-creation/pending');
    expect(before.body.map(r => r.id)).toContain(ids.candidate2);

    const { rows } = await pool.query(
      `INSERT INTO employees (office_id, first_name, last_name, company_id, source_candidate_id)
       VALUES (${FIXTURE_CODE_SQL}, 'Priya', 'Sharma', $1, $2) RETURNING id`,
      [ids.company, ids.candidate2]
    );

    const after = await request(recruiterApp).get('/api/recruitment/auto-creation/pending');
    expect(after.body.map(r => r.id)).not.toContain(ids.candidate2);

    await pool.query(`DELETE FROM employees WHERE id = $1`, [rows[0].id]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cross-job recommendation — one candidate, several openings', () => {
  // The audit marked this NOT IMPLEMENTED and blocked at the schema:
  // candidates.applied_job_id is a scalar, so the only way to point someone at a
  // second job was to overwrite the first. candidate_applications is the
  // relationship that was missing.

  it('records the primary application when a candidate is created against a job', async () => {
    const res = await request(recruiterApp).get(`/api/recruitment/candidates/${ids.candidate}/applications`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].job_opening_id).toBe(ids.opening);
    expect(res.body[0].is_primary).toBe(true);
    expect(res.body[0].origin).toBe('applied');
  });

  it('recommends the candidate for another opening in one action', async () => {
    const res = await request(recruiterApp)
      .post(`/api/recruitment/candidates/${ids.candidate}/recommend`)
      .send({ job_opening_ids: [ids.opening2], notes: 'Better suited to field service' });
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.created[0].origin).toBe('recommended');
    // The job they came from is recorded, so the redirection is traceable.
    expect(res.body.created[0].recommended_from_job_id).toBe(ids.opening);
  });

  it('creates NO duplicate candidate profile', async () => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM candidates WHERE company_id = $1 AND email = $2 AND deleted_at IS NULL`,
      [ids.company, `${TAG}.ravi@test.invalid`]
    );
    expect(rows[0].n).toBe(1);
  });

  it('preserves the original application', async () => {
    const res = await request(recruiterApp).get(`/api/recruitment/candidates/${ids.candidate}/applications`);
    expect(res.body).toHaveLength(2);
    const primary = res.body.find(a => a.is_primary);
    expect(primary.job_opening_id).toBe(ids.opening);
    // Where the audit's only workaround left it: re-pointed, history destroyed.
    const { rows } = await pool.query(`SELECT applied_job_id FROM candidates WHERE id = $1`, [ids.candidate]);
    expect(rows[0].applied_job_id).toBe(ids.opening);
  });

  it('tracks the two applications separately — rejected for one, live for the other', async () => {
    const before = await request(recruiterApp).get(`/api/recruitment/candidates/${ids.candidate}/applications`);
    const primary   = before.body.find(a => a.is_primary);
    const secondary = before.body.find(a => !a.is_primary);

    await request(recruiterApp).post(`/api/recruitment/applications/${secondary.id}/move-stage`)
      .send({ stage: 'screening' }).expect(200);
    await request(recruiterApp).post(`/api/recruitment/applications/${primary.id}/move-stage`)
      .send({ stage: 'not_suitable' }).expect(200);

    const after = await request(recruiterApp).get(`/api/recruitment/candidates/${ids.candidate}/applications`);
    expect(after.body.find(a => a.is_primary).stage).toBe('not_suitable');
    expect(after.body.find(a => a.is_primary).status).toBe('rejected');
    expect(after.body.find(a => !a.is_primary).stage).toBe('screening');
    expect(after.body.find(a => !a.is_primary).status).toBe('active');
  });

  it('writes a primary application move through to candidates.current_stage', async () => {
    // ~40 call sites read that column; the two must not disagree.
    const { rows } = await pool.query(`SELECT current_stage FROM candidates WHERE id = $1`, [ids.candidate]);
    expect(rows[0].current_stage).toBe('not_suitable');
  });

  it('leaves candidates.current_stage alone when a SECONDARY application moves', async () => {
    const apps = await request(recruiterApp).get(`/api/recruitment/candidates/${ids.candidate}/applications`);
    const secondary = apps.body.find(a => !a.is_primary);
    await request(recruiterApp).post(`/api/recruitment/applications/${secondary.id}/move-stage`)
      .send({ stage: '1st_level' }).expect(200);
    const { rows } = await pool.query(`SELECT current_stage FROM candidates WHERE id = $1`, [ids.candidate]);
    expect(rows[0].current_stage).toBe('not_suitable');
  });

  it('derives status from stage in BOTH directions', async () => {
    // Falling through to the old value left "stage=screening, status=rejected".
    const apps = await request(recruiterApp).get(`/api/recruitment/candidates/${ids.candidate}/applications`);
    const primary = apps.body.find(a => a.is_primary);
    await request(recruiterApp).post(`/api/recruitment/applications/${primary.id}/move-stage`)
      .send({ stage: 'screening' }).expect(200);
    const after = await request(recruiterApp).get(`/api/recruitment/candidates/${ids.candidate}/applications`);
    expect(after.body.find(a => a.is_primary).status).toBe('active');
  });

  it('is idempotent — recommending the same opening twice adds nothing', async () => {
    const res = await request(recruiterApp)
      .post(`/api/recruitment/candidates/${ids.candidate}/recommend`)
      .send({ job_opening_ids: [ids.opening2] });
    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(0);
    expect(res.body.already_applied.map(a => a.id)).toEqual([ids.opening2]);
    const apps = await request(recruiterApp).get(`/api/recruitment/candidates/${ids.candidate}/applications`);
    expect(apps.body).toHaveLength(2);
  });

  it('refuses a closed opening, and records nothing at all when it does', async () => {
    const res = await request(recruiterApp)
      .post(`/api/recruitment/candidates/${ids.candidate2}/recommend`)
      .send({ job_opening_ids: [ids.opening, ids.closedOpening] });
    expect(res.status).toBe(409);
    // All-or-nothing: the valid opening in the same request must not have landed.
    const apps = await request(recruiterApp).get(`/api/recruitment/candidates/${ids.candidate2}/applications`);
    expect(apps.body).toHaveLength(0);
  });

  it('refuses an opening that does not exist, naming it', async () => {
    const res = await request(recruiterApp)
      .post(`/api/recruitment/candidates/${ids.candidate}/recommend`)
      .send({ job_opening_ids: [99999999] });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('99999999');
  });

  it('refuses an empty selection', async () => {
    const res = await request(recruiterApp)
      .post(`/api/recruitment/candidates/${ids.candidate}/recommend`)
      .send({ job_opening_ids: [] });
    expect(res.status).toBe(400);
  });

  it('refuses the whole flow for a role without the recruitment grant', async () => {
    expect((await request(outsiderApp).get(`/api/recruitment/candidates/${ids.candidate}/applications`)).status).toBe(403);
    expect((await request(outsiderApp).post(`/api/recruitment/candidates/${ids.candidate}/recommend`)
      .send({ job_opening_ids: [ids.opening2] })).status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('careers portal — candidates apply without an account', () => {
  // The audit's Section 1A: there was no public route in the repo at all, so
  // every applicant reached the ATS by somebody retyping them.
  let anon, portalKey;

  beforeAll(async () => {
    anon = publicApp();
    const res = await request(recruiterApp).post('/api/recruitment/careers-portal')
      .send({ display_name: `${TAG} Careers` });
    expect(res.status).toBe(201);
    portalKey = res.body.portal_key;
  });

  it('lists open roles to an anonymous caller', async () => {
    const res = await request(anon).get(`/api/public/careers/${portalKey}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs.map(j => j.id)).toEqual(expect.arrayContaining([ids.opening, ids.opening2]));
  });

  it('never publishes internal columns', async () => {
    const res = await request(anon).get(`/api/public/careers/${portalKey}`);
    const job = res.body.jobs[0];
    // SELECT * would have put every one of these on the open internet.
    for (const leak of ['requisition_id', 'gdrive_folder_id', 'gdrive_folder_structure',
                        'positions_filled', 'company_id', 'deleted_at']) {
      expect(job).not.toHaveProperty(leak);
    }
  });

  it('hides the salary range unless the portal is told to show it', async () => {
    const before = await request(anon).get(`/api/public/careers/${portalKey}`);
    expect(before.body.jobs[0]).not.toHaveProperty('salary_min');

    await request(recruiterApp).put('/api/recruitment/careers-portal').send({ show_salary_range: true }).expect(200);
    const after = await request(anon).get(`/api/public/careers/${portalKey}`);
    expect(after.body.jobs[0]).toHaveProperty('salary_min');

    await request(recruiterApp).put('/api/recruitment/careers-portal').send({ show_salary_range: false }).expect(200);
  });

  it('excludes closed roles and roles past their closing date', async () => {
    const res = await request(anon).get(`/api/public/careers/${portalKey}`);
    expect(res.body.jobs.map(j => j.id)).not.toContain(ids.closedOpening);
  });

  it('accepts an application with a résumé and creates an ordinary candidate', async () => {
    // The upload lands on disk before any assertion; whatever happens below, the
    // file this run created is removed (and nothing else in uploads/).
    let storedUrl = null;
    let removed = [];
    try {
      const pdf = await makeResumePdf([
        'Meera Iyer', 'meera.iyer@test.invalid', '+91 98111 22333', 'Chennai',
        'B.E. Electrical Engineering, Anna University, batch of 2019',
        'Design Engineer, Delta Electronics, 2019 - Present',
        'Skills: Power Electronics, MATLAB, Altium',
      ]);

      const res = await request(anon)
        .post(`/api/public/careers/${portalKey}/apply/${ids.opening}`)
        .field('full_name', 'Meera Iyer')
        .field('email', 'meera.iyer@test.invalid')
        .field('phone', '+919811122333')
        .field('location', 'Chennai')
        .field('experience_years', '5')
        .attach('resume', pdf, RESUME_NAME);

      expect(res.status).toBe(201);
      // Nothing internal comes back — no candidate id, no stage.
      expect(JSON.stringify(res.body)).not.toMatch(/candidate_id|current_stage/);

      const { rows } = await pool.query(
        `SELECT id, source, location, resume_file_url, applied_job_id
           FROM candidates WHERE email = $1 AND company_id = $2`,
        ['meera.iyer@test.invalid', ids.company]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].source).toBe('careers');
      expect(rows[0].location).toBe('Chennai');
      storedUrl = rows[0].resume_file_url;
      expect(RUN_UPLOAD.test(String(storedUrl).replace(/^\/uploads\//, ''))).toBe(true);
      expect(rows[0].applied_job_id).toBe(ids.opening);

      // …and an ordinary application row, so the pipeline sees it like any other.
      const { rows: apps } = await pool.query(
        `SELECT is_primary FROM candidate_applications WHERE candidate_id = $1`, [rows[0].id]
      );
      expect(apps).toHaveLength(1);
      expect(apps[0].is_primary).toBe(true);
    } finally {
      removed = await removeRunUploads();
    }
    // Exactly the one file this run stored — and it is gone.
    const { existsSync } = await import('node:fs');
    const { LOCAL_UPLOAD_DIR } = await import('../services/StorageService.js');
    expect(removed).toEqual([storedUrl.slice('/uploads/'.length)]);
    expect(existsSync(`${LOCAL_UPLOAD_DIR}/${removed[0]}`)).toBe(false);
  });

  it('answers a duplicate exactly like a success, and creates nothing', async () => {
    // Anything else turns the careers page into an oracle for "is this person
    // job-hunting at your company".
    const first = await request(anon).post(`/api/public/careers/${portalKey}/apply/${ids.opening}`)
      .field('full_name', 'Meera Iyer').field('email', 'meera.iyer@test.invalid');
    expect([200, 201]).toContain(first.status);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM candidates WHERE email = $1 AND company_id = $2`,
      ['meera.iyer@test.invalid', ids.company]
    );
    expect(rows[0].n).toBe(1);
  });

  it('swallows a honeypot submission with 200 and records it as spam', async () => {
    const res = await request(anon).post(`/api/public/careers/${portalKey}/apply/${ids.opening}`)
      .field('full_name', 'Bot').field('email', 'bot@test.invalid').field('website', 'http://spam');
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM careers_applications WHERE company_id = $1 AND status = 'spam'`,
      [ids.company]
    );
    expect(rows[0].n).toBeGreaterThan(0);
    const { rows: c } = await pool.query(`SELECT COUNT(*)::int AS n FROM candidates WHERE email = $1`, ['bot@test.invalid']);
    expect(c[0].n).toBe(0);
  });

  it('refuses an application to a closed role', async () => {
    const res = await request(anon).post(`/api/public/careers/${portalKey}/apply/${ids.closedOpening}`)
      .field('full_name', 'Late').field('email', 'late@test.invalid');
    expect(res.status).toBe(409);
  });

  it('requires a name and a well-formed email', async () => {
    expect((await request(anon).post(`/api/public/careers/${portalKey}/apply/${ids.opening}`)
      .field('email', 'x@test.invalid')).status).toBe(400);
    expect((await request(anon).post(`/api/public/careers/${portalKey}/apply/${ids.opening}`)
      .field('full_name', 'No Email')).status).toBe(400);
    expect((await request(anon).post(`/api/public/careers/${portalKey}/apply/${ids.opening}`)
      .field('full_name', 'Bad').field('email', 'not-an-email')).status).toBe(400);
  });

  it('treats an unknown key and a disabled portal identically', async () => {
    expect((await request(anon).get('/api/public/careers/not-a-real-key')).status).toBe(404);

    await request(recruiterApp).put('/api/recruitment/careers-portal').send({ is_active: false }).expect(200);
    expect((await request(anon).get(`/api/public/careers/${portalKey}`)).status).toBe(404);
    await request(recruiterApp).put('/api/recruitment/careers-portal').send({ is_active: true }).expect(200);
  });

  it('revokes the old link when the key is rotated', async () => {
    const rotated = await request(recruiterApp).post('/api/recruitment/careers-portal').send({});
    expect(rotated.status).toBe(201);
    expect(rotated.body.portal_key).not.toBe(portalKey);

    expect((await request(anon).get(`/api/public/careers/${portalKey}`)).status).toBe(404);
    expect((await request(anon).get(`/api/public/careers/${rotated.body.portal_key}`)).status).toBe(200);
    portalKey = rotated.body.portal_key;
  });

  it('records refusals as well as acceptances', async () => {
    const res = await request(recruiterApp).get('/api/recruitment/careers-portal/submissions');
    expect(res.status).toBe(200);
    const statuses = new Set(res.body.map(r => r.status));
    expect(statuses.has('accepted')).toBe(true);
    expect(statuses.has('spam')).toBe(true);
  });

  it('keeps the administration surface behind the recruitment permission', async () => {
    expect((await request(outsiderApp).get('/api/recruitment/careers-portal')).status).toBe(403);
    expect((await request(outsiderApp).get('/api/recruitment/careers-portal/submissions')).status).toBe(403);
    expect((await request(outsiderApp).post('/api/recruitment/careers-portal').send({})).status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('résumé parsing', () => {
  let parsed;

  it('extracts fields from a real PDF', async () => {
    const pdf = await makeResumePdf([
      'Vikram Shetty', 'vikram.shetty@test.invalid', '+91 99887 76655', 'Pune',
      '', 'PROFESSIONAL SUMMARY',
      'Power electronics engineer with 8 years of experience.',
      '', 'EDUCATION',
      'M.Tech Electrical Engineering, IIT Bombay, batch of 2016',
      '', 'EXPERIENCE',
      'Lead Engineer, Siemens Limited, 2019 - Present',
      '', 'SKILLS', 'Power Electronics, MATLAB, Simulink, PLC, Modbus',
      '', 'Notice period: 90 days', 'Expected CTC: 32 LPA',
    ]);

    const res = await request(recruiterApp).post('/api/recruitment/resume/parse')
      .attach('resume', pdf, 'vikram.pdf');

    expect(res.status).toBe(200);
    parsed = res.body;
    const f = parsed.fields;
    expect(f.full_name).toBe('Vikram Shetty');
    expect(f.email).toBe('vikram.shetty@test.invalid');
    expect(f.phone).toMatch(/9988776655/);
    expect(f.location).toBe('Pune');
    expect(f.experience_years).toBe(8);
    expect(f.notice_period_days).toBe(90);
    expect(f.expected_ctc).toBe(3200000);
    expect(f.qualification).toBe('ME/MTech');
    expect(f.specialisation).toBe('Electrical Engineering');
    expect(f.graduation_year).toBe(2016);
    expect(f.current_company).toBe('Siemens Limited');
    expect(f.current_designation).toBe('Lead Engineer');
    expect(f.skills).toEqual(expect.arrayContaining(['Power Electronics', 'MATLAB', 'Simulink', 'PLC']));
  });

  it('reports a confidence per field', async () => {
    // A recruiter needs to know which values deserve a second look.
    expect(parsed.confidence.email).toBe('high');
    expect(parsed.confidence.full_name).toBe('low');
  });

  it('WRITES NOTHING — parsing is a suggestion, not an import', async () => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM candidates WHERE email = $1`, ['vikram.shetty@test.invalid']
    );
    expect(rows[0].n).toBe(0);
  });

  it('warns rather than inventing values when a file has no text', async () => {
    const blank = await makeResumePdf(['']);
    const res = await request(recruiterApp).post('/api/recruitment/resume/parse')
      .attach('resume', blank, 'blank.pdf');
    expect(res.status).toBe(200);
    expect(res.body.warnings.length).toBeGreaterThan(0);
    expect(res.body.fields.full_name).toBeNull();
    expect(res.body.fields.email).toBeNull();
  });

  it('flags a parsed email that is already in the pipeline', async () => {
    const pdf = await makeResumePdf(['Ravi Kumar', `${TAG}.ravi@test.invalid`, 'Bengaluru']);
    const res = await request(recruiterApp).post('/api/recruitment/resume/parse')
      .attach('resume', pdf, 'dupe.pdf');
    expect(res.status).toBe(200);
    expect(res.body.duplicate_of?.id).toBe(ids.candidate);
  });

  it('refuses a file type it cannot read, with a usable message', async () => {
    const res = await request(recruiterApp).post('/api/recruitment/resume/parse')
      .attach('resume', Buffer.from('not a document'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect([400, 415]).toContain(res.status);
  });

  it('is behind the recruitment permission', async () => {
    const pdf = await makeResumePdf(['Someone', 'someone@test.invalid']);
    const res = await request(outsiderApp).post('/api/recruitment/resume/parse').attach('resume', pdf, 'x.pdf');
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('education search — the brief\'s worked example', () => {
  beforeAll(async () => {
    await request(recruiterApp).post('/api/recruitment/candidates').send({
      full_name: `${TAG} Suresh Nair`,
      email: `${TAG}.suresh@test.invalid`,
      source: 'careers',
      qualification: 'BE/BTech',
      specialisation: 'Electrical Engineering',
      institution: 'Anna University',
      graduation_year: 2019,
      experience_years: 3,
      notice_period_days: 30,
      location: 'Bengaluru',
      skills: ['Power Electronics'],
      resume_text: 'Design engineer working on power electronics converters and inverters.',
    }).expect(201);
  });

  const search = (qs) => request(recruiterApp).get(`/api/recruitment/candidates?${qs}`);

  it('filters by qualification', async () => {
    const res = await search('qualification=BE/BTech');
    expect(res.body.rows.map(r => r.full_name)).toContain(`${TAG} Suresh Nair`);
  });

  it('matches a specialisation partially', async () => {
    // "Electrical" must find "Electrical Engineering".
    const res = await search('specialisation=Electrical');
    expect(res.body.rows.map(r => r.full_name)).toContain(`${TAG} Suresh Nair`);
  });

  it('searches the résumé text itself', async () => {
    const hit  = await search('resume_text=power electronics converters');
    expect(hit.body.rows.map(r => r.full_name)).toContain(`${TAG} Suresh Nair`);
    const miss = await search('resume_text=underwater basket weaving');
    expect(miss.body.rows.map(r => r.full_name)).not.toContain(`${TAG} Suresh Nair`);
  });

  it('survives punctuation in the full-text query', async () => {
    // plainto_tsquery, not to_tsquery — an unescaped & or : would be a syntax error.
    const res = await search('resume_text=' + encodeURIComponent('power & electronics : converters!'));
    expect(res.status).toBe(200);
  });

  it('answers the whole question at once', async () => {
    const res = await search('qualification=BE/BTech&specialisation=Electrical&experience_min=2&location=Bengaluru&notice_period_max=60&skills=Power Electronics');
    expect(res.body.rows.map(r => r.full_name)).toEqual([`${TAG} Suresh Nair`]);
  });

  it('rejects a qualification outside the vocabulary', async () => {
    const res = await request(recruiterApp).post('/api/recruitment/candidates').send({
      full_name: `${TAG} Bad Degree`, email: `${TAG}.bad@test.invalid`, qualification: 'B.E.',
    });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the board reads applications, not candidates.applied_job_id', () => {
  // Before this, a per-job board asked "whose PRIMARY job is this, and what is
  // their HEADLINE stage" — two wrong questions. A recommended candidate never
  // appeared on the board for the role they were recommended onto, and someone
  // at Screening on one role but Offer on another showed in the Offer column of
  // both.
  let boardCandidate;

  beforeAll(async () => {
    const res = await request(recruiterApp).post('/api/recruitment/candidates').send({
      full_name: `${TAG} Board Probe`, email: `${TAG}.board@test.invalid`,
      source: 'manual', applied_job_id: ids.opening, experience_years: 4,
    });
    boardCandidate = res.body.id;
    await request(recruiterApp).post(`/api/recruitment/candidates/${boardCandidate}/recommend`)
      .send({ job_opening_ids: [ids.opening2] }).expect(201);
  });

  it('shows a recommended candidate on the board for THAT opening', async () => {
    const col = await request(recruiterApp).get(`/api/recruitment/pipeline/${ids.opening2}/applied`);
    expect(col.status).toBe(200);
    expect(col.body.map(c => c.id)).toContain(boardCandidate);
  });

  it('counts them in that opening\'s applicant count', async () => {
    const res = await request(recruiterApp).get('/api/recruitment/openings');
    const job = res.body.find(j => j.id === ids.opening2);
    expect(job.applicants_count).toBeGreaterThan(0);
  });

  it('carries the application id, so the board moves the right one', async () => {
    const col = await request(recruiterApp).get(`/api/recruitment/pipeline/${ids.opening2}/applied`);
    const entry = col.body.find(c => c.id === boardCandidate);
    expect(entry.application_id).toBeTruthy();
    expect(entry.is_primary).toBe(false);
    expect(entry.application_origin).toBe('recommended');
  });

  it('moves one application without touching the other', async () => {
    const col = await request(recruiterApp).get(`/api/recruitment/pipeline/${ids.opening2}/applied`);
    const entry = col.body.find(c => c.id === boardCandidate);

    await request(recruiterApp).post(`/api/recruitment/applications/${entry.application_id}/move-stage`)
      .send({ stage: 'screening' }).expect(200);

    const bAfter = await request(recruiterApp).get(`/api/recruitment/pipeline/${ids.opening2}/applied`);
    expect(bAfter.body.map(c => c.id)).not.toContain(boardCandidate);

    // The original role is untouched.
    const aAfter = await request(recruiterApp).get(`/api/recruitment/pipeline/${ids.opening}/applied`);
    expect(aAfter.body.map(c => c.id)).toContain(boardCandidate);
  });

  it('counts APPLICATIONS per stage when scoped to one opening', async () => {
    const scoped = await request(recruiterApp).get(`/api/recruitment/pipeline/${ids.opening2}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.find(r => r.stage === 'screening')?.count).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('consent and retention', () => {
  let anon, portalKey, applicant;

  beforeAll(async () => {
    anon = publicApp();
    const res = await request(recruiterApp).post('/api/recruitment/careers-portal').send({});
    portalKey = res.body.portal_key;

    await request(anon).post(`/api/public/careers/${portalKey}/apply/${ids.opening}`)
      .field('full_name', 'Consent Probe')
      .field('email', 'consent.probe@test.invalid')
      .expect(201);

    const { rows } = await pool.query(
      `SELECT * FROM candidates WHERE email = $1 AND company_id = $2`,
      ['consent.probe@test.invalid', ids.company]
    );
    applicant = rows[0];
  });

  it('records consent at the point of application', async () => {
    expect(applicant.consent_basis).toBe('consent');
    expect(applicant.consent_at).toBeTruthy();
    expect(applicant.consent_source).toBe('careers_portal');
    expect(applicant.retain_until).toBeTruthy();
  });

  it('stores the wording that was shown, not just a flag', async () => {
    expect(applicant.consent_text).toMatch(/you agree that we may hold/i);
    // The page and the record must not drift apart.
    const page = await request(anon).get(`/api/public/careers/${portalKey}`);
    expect(page.body.portal.consent_text).toBe(applicant.consent_text);
  });

  it('derives consent_at server-side, ignoring anything the client sends', async () => {
    // A consent timestamp supplied by the caller is not evidence of anything.
    const res = await request(recruiterApp).post('/api/recruitment/candidates').send({
      full_name: `${TAG} Forged Consent`, email: `${TAG}.forged@test.invalid`,
      consent_at: '1999-01-01T00:00:00Z', consent_basis: 'consent',
    });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(`SELECT consent_at FROM candidates WHERE id = $1`, [res.body.id]);
    expect(new Date(rows[0].consent_at).getFullYear()).toBeGreaterThan(2020);
  });

  it('never invents a retention date for a candidate who gave no consent', async () => {
    // A recruiter typing someone in has not obtained consent, so nothing is
    // recorded and nothing expires them — the purge job only acts on a
    // retain_until that something deliberately set. (The migration marked rows
    // that predate consent capture as 'legacy' for exactly this reason: it
    // refused to back-date evidence that was never collected.)
    const { rows } = await pool.query(
      `SELECT consent_basis, consent_at, retain_until FROM candidates WHERE id = $1`, [ids.candidate]
    );
    expect(rows[0].consent_at).toBeNull();
    expect(rows[0].retain_until).toBeNull();

    const legacy = await pool.query(
      `SELECT COUNT(*)::int AS n FROM candidates WHERE consent_basis = 'legacy' AND retain_until IS NOT NULL`
    );
    expect(legacy.rows[0].n).toBe(0);
  });

  it('records a withdrawal without deleting anything yet', async () => {
    const res = await request(recruiterApp)
      .post(`/api/recruitment/candidates/${applicant.id}/withdraw-consent`)
      .send({ reason: 'emailed us' });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT consent_withdrawn_at, anonymised_at, full_name FROM candidates WHERE id = $1`, [applicant.id]
    );
    expect(rows[0].consent_withdrawn_at).toBeTruthy();
    expect(rows[0].anonymised_at).toBeNull();
    expect(rows[0].full_name).toBe('Consent Probe');
  });

  it('anonymises a withdrawn record on the next retention run', async () => {
    // Scoped to this suite's company: an unscoped run would anonymise any REAL
    // candidate that happens to be due, and purge other suites' queued files.
    await runCandidateRetention({ companyId: ids.company });

    const { rows } = await pool.query(
      `SELECT full_name, email, phone, resume_text, skills, anonymised_at,
              current_stage, applied_job_id
         FROM candidates WHERE id = $1`, [applicant.id]
    );
    const c = rows[0];
    expect(c.anonymised_at).toBeTruthy();
    expect(c.full_name).not.toBe('Consent Probe');
    expect(c.email).not.toBe('consent.probe@test.invalid');
    expect(c.phone).toBeNull();
    expect(c.resume_text).toBeNull();
    // The hiring RECORD survives — "how many did we interview for this role"
    // is a legitimate question that outlives the individual's erasure.
    expect(c.current_stage).toBeTruthy();
    expect(c.applied_job_id).toBe(ids.opening);
  });

  it('gives each anonymised record a unique placeholder email', async () => {
    // NULL would collide on candidates_company_email_uniq the moment a second
    // record is anonymised.
    const { rows } = await pool.query(
      `SELECT email FROM candidates WHERE id = $1`, [applicant.id]
    );
    expect(rows[0].email).toMatch(/^anonymised\+\d+@/);
  });

  it('erases free text written ABOUT the candidate too', async () => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM candidate_stage_history WHERE candidate_id = $1 AND notes IS NOT NULL`,
      [applicant.id]
    );
    expect(rows[0].n).toBe(0);
  });

  it('never anonymises an active candidate whose retention merely expired', async () => {
    await pool.query(
      `UPDATE candidates SET retain_until = CURRENT_DATE - 1, overall_status = 'active',
              consent_withdrawn_at = NULL WHERE id = $1`, [ids.candidate]
    );
    await runCandidateRetention({ companyId: ids.company });
    const { rows } = await pool.query(`SELECT anonymised_at FROM candidates WHERE id = $1`, [ids.candidate]);
    expect(rows[0].anonymised_at).toBeNull();
    await pool.query(`UPDATE candidates SET retain_until = NULL WHERE id = $1`, [ids.candidate]);
  });

  it('logs every action it took', async () => {
    const { rows } = await pool.query(
      `SELECT action FROM candidate_retention_log WHERE company_id = $1`, [ids.company]
    );
    const actions = new Set(rows.map(r => r.action));
    expect(actions.has('withdrawn')).toBe(true);
    expect(actions.has('anonymised')).toBe(true);
  });

  it('bounds a retention extension', async () => {
    expect((await request(recruiterApp).post(`/api/recruitment/candidates/${ids.candidate}/extend-retention`)
      .send({ months: 6 })).status).toBe(200);
    expect((await request(recruiterApp).post(`/api/recruitment/candidates/${ids.candidate}/extend-retention`)
      .send({ months: 9999 })).status).toBe(400);
  });

  it('reports what is held and on what basis', async () => {
    const res = await request(recruiterApp).get('/api/recruitment/privacy/summary');
    expect(res.status).toBe(200);
    // `legacy` is the number somebody has to make a decision about.
    expect(res.body.summary).toHaveProperty('legacy_no_consent');
    expect(res.body.summary).toHaveProperty('due_for_purge');
    expect(Array.isArray(res.body.recent)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('bulk export is a separate permission', () => {
  it('is refused to a role that can READ candidates but not export them', async () => {
    // The load-bearing case. This role holds recruitment view/add/edit/delete —
    // it can see every candidate on screen — and is still refused the bulk file.
    const list = await request(viewerApp).get('/api/recruitment/candidates');
    expect(list.status).toBe(200);

    const res = await request(viewerApp).get('/api/recruitment/candidates/export');
    expect(res.status).toBe(403);
  });

  it('is refused to a role with no recruitment access at all', async () => {
    const res = await request(outsiderApp).get('/api/recruitment/candidates/export');
    expect(res.status).toBe(403);
  });

  it('is served to a role that holds it, and logged', async () => {
    const before = await pool.query(
      `SELECT COUNT(*)::int AS n FROM candidate_retention_log WHERE company_id = $1 AND action = 'exported'`,
      [ids.company]
    );
    const res = await request(recruiterApp).get('/api/recruitment/candidates/export');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);

    const after = await pool.query(
      `SELECT COUNT(*)::int AS n FROM candidate_retention_log WHERE company_id = $1 AND action = 'exported'`,
      [ids.company]
    );
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it('is not shadowed by /candidates/:id', async () => {
    // Express matches in registration order; a literal path declared after a
    // :param route on the same prefix is unreachable.
    const res = await request(recruiterApp).get('/api/recruitment/candidates/export');
    expect(res.body).not.toHaveProperty('error');
  });

  it('excludes anonymised records', async () => {
    const res = await request(recruiterApp).get('/api/recruitment/candidates/export');
    expect(res.body.rows.every(r => !r.anonymised_at)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('job distribution — Indeed feed and the manual checklist', () => {
  let anon, portalKey;

  beforeAll(async () => {
    anon = publicApp();
    const { rows } = await pool.query(`SELECT portal_key FROM careers_portals WHERE company_id = $1`, [ids.company]);
    portalKey = rows[0].portal_key;
  });

  it('serves an empty feed until a role is opted in', async () => {
    const res = await request(anon).get(`/api/public/careers/${portalKey}/feed.xml`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    // include_in_feed defaults to false: syndication is a decision, not an
    // accident. A confidential replacement hire must not leak to a job board.
    expect(res.text).not.toContain('<job>');
  });

  it('includes a role once it is opted in', async () => {
    await request(recruiterApp).put(`/api/recruitment/jobs/${ids.opening}/feed`)
      .send({ include_in_feed: true }).expect(200);

    const res = await request(anon).get(`/api/public/careers/${portalKey}/feed.xml`);
    expect(res.text).toContain('<job>');
    expect(res.text).toContain(`${TAG} Electrical Engineer`);
  });

  it('produces XML that a parser will not choke on', async () => {
    const res = await request(anon).get(`/api/public/careers/${portalKey}/feed.xml`);
    // Job descriptions routinely contain & and < >.
    expect(res.text).toMatch(/<description><!\[CDATA\[/);
    const outsideCdata = res.text.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    expect(outsideCdata).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    // RFC-822, which the Indeed feed spec requires — not ISO-8601.
    expect(res.text).toMatch(/<lastBuildDate>\w{3}, \d{2} \w{3} \d{4}/);
  });

  it('applies the same salary rule as the careers page', async () => {
    await request(recruiterApp).put('/api/recruitment/careers-portal').send({ show_salary_range: false }).expect(200);
    let res = await request(anon).get(`/api/public/careers/${portalKey}/feed.xml`);
    expect(res.text).not.toContain('<salary>');

    await request(recruiterApp).put('/api/recruitment/careers-portal').send({ show_salary_range: true }).expect(200);
    res = await request(anon).get(`/api/public/careers/${portalKey}/feed.xml`);
    expect(res.text).toContain('<salary>');
    await request(recruiterApp).put('/api/recruitment/careers-portal').send({ show_salary_range: false }).expect(200);
  });

  it('drops a role again when it is opted out', async () => {
    await request(recruiterApp).put(`/api/recruitment/jobs/${ids.opening}/feed`)
      .send({ include_in_feed: false }).expect(200);
    const res = await request(anon).get(`/api/public/careers/${portalKey}/feed.xml`);
    expect(res.text).not.toContain('<job>');
  });

  it('lists every channel, not only the ones recorded', async () => {
    const res = await request(recruiterApp).get(`/api/recruitment/jobs/${ids.opening}/distribution`);
    expect(res.status).toBe(200);
    const channels = res.body.channels.map(c => c.channel);
    expect(channels).toEqual(expect.arrayContaining(['careers', 'indeed', 'linkedin', 'naukri', 'foundit']));
  });

  it('says plainly which channels are automated and which are not', async () => {
    // The audit's complaint was a settings page whose toggles implied
    // integrations that did not exist. Every row states its own mode.
    const res = await request(recruiterApp).get(`/api/recruitment/jobs/${ids.opening}/distribution`);
    const byChannel = Object.fromEntries(res.body.channels.map(c => [c.channel, c]));
    expect(byChannel.careers.posting_mode).toBe('automatic');
    expect(byChannel.indeed.posting_mode).toBe('feed');
    expect(byChannel.linkedin.posting_mode).toBe('manual');
    expect(byChannel.naukri.supported).toMatch(/agreement/i);
  });

  it('insists on a link when a manual posting is marked done', async () => {
    const without = await request(recruiterApp)
      .put(`/api/recruitment/jobs/${ids.opening}/distribution/linkedin`).send({ status: 'posted' });
    expect(without.status).toBe(400);

    const withUrl = await request(recruiterApp)
      .put(`/api/recruitment/jobs/${ids.opening}/distribution/linkedin`)
      .send({ status: 'posted', external_url: 'https://www.linkedin.com/jobs/view/1' });
    expect(withUrl.status).toBe(200);
    expect(withUrl.body.posted_at).toBeTruthy();
  });

  it('refuses a channel it does not know', async () => {
    const res = await request(recruiterApp)
      .put(`/api/recruitment/jobs/${ids.opening}/distribution/monster`)
      .send({ status: 'posted', external_url: 'https://x.invalid' });
    expect(res.status).toBe(400);
  });

  it('gives a take-down list when the role closes', async () => {
    const res = await request(recruiterApp).get(`/api/recruitment/jobs/${ids.opening}/distribution`);
    const posted = res.body.channels.filter(c => c.status === 'posted');
    expect(posted.map(c => c.channel)).toContain('linkedin');
    expect(posted.find(c => c.channel === 'linkedin').external_url).toBeTruthy();
  });

  it('keeps distribution behind the recruitment permission', async () => {
    expect((await request(outsiderApp).get(`/api/recruitment/jobs/${ids.opening}/distribution`)).status).toBe(403);
    expect((await request(outsiderApp).put(`/api/recruitment/jobs/${ids.opening}/feed`)
      .send({ include_in_feed: true })).status).toBe(403);
  });
});
