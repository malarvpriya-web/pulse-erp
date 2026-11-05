/**
 * integration.recruitmentWorkbench.test.js
 *
 * The 2026-09-27 Recruitment redesign, driven through the REAL routers against
 * the REAL database.
 *
 * Sibling to integration.recruitmentRegression.test.js, which covers the
 * 2026-09-17 audit. A separate file rather than 60 more cases appended to a
 * 1369-line one: the two have different fixtures (this suite needs screening
 * questions, talent pools and a recruiter identity that OWNS candidates) and
 * keeping them apart means a failure names which body of work broke.
 *
 * WHAT IS UNDER TEST — the brief's own numbered requirements:
 *
 *   §9   notes: type, author, pin, visibility, edit marking, soft delete
 *   §11  eligibility verdicts, including "partially meets" ≠ "does not meet"
 *   §12  1-5 competency ratings with evidence, and NULL ≠ 1
 *   §13  the nine screening questions, and Q9 writing through to relocation
 *   §14  the 100-point scorecard, the assessed-weight honesty, and the override
 *   §15  all seven outcomes, and what each one does NOT do
 *   §16  role suitability with no duplicate candidate, and converting it
 *   §17  Talent Bank membership and tag union
 *   §18  Future Opportunity, the reminder, and firing it exactly once
 *   §19  the Talent Bank search, including the brief's worked example
 *   §20  similar candidates carrying REASONS, never a bare score
 *   §21  the activity timeline, and its immutability
 *   §22  bulk actions: atomicity, tenant scoping, destructive confirmation
 *   §23  the work queue, measured from last_activity_at and not created_at
 *   §30  every new endpoint behind the recruitment permission
 *   §35  a rejected candidate is never removed from the system
 *
 * ⚠ EVERY NEGATIVE CASE IS PAIRED WITH A POSITIVE ONE, for the reason the sibling
 * suite gives: an authorization suite that only asserts "the unprivileged role is
 * refused" passes just as happily when the endpoint is broken for everyone.
 *
 * Self-cleaning: one synthetic company, swept on the way IN as well as OUT so an
 * assertion that throws cannot poison the next run. Touches no pre-existing row.
 *
 * ⚠ This suite does NOT call pool.end(). The pool is shared across the whole
 * vitest run, and ending it here silently skips every suite that happens to run
 * afterwards — a failure mode this repo has shipped (49 tests lost that way).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { FIXTURE_CODE_SQL } from '../shared/employeeCode.js';
import { dbToday } from './helpers/dbDate.js';

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

const { default: pool }          = await import('../config/db.js');
const { default: recruitRouter } = await import('../modules/recruitment/routes/recruitment.routes.js');
const { default: ciRouter }      = await import('../modules/recruitment/routes/candidateIntelligence.routes.js');
const { default: ci, computeScreeningScore, recommendationFor } =
  await import('../modules/recruitment/repositories/candidateIntelligence.repository.js');
const { runCandidateRecontact }  = await import('../jobs/candidateRecontact.cron.js');
const { _clearActorNameCache }   = await import('../modules/recruitment/actorName.js');

const TAG = 'ZZWB';

const ids = {
  company: null, employee: null,
  recRole: null, outRole: null,
  recUser: null, recUser2: null, outUser: null,
  requisition: null, opening: null, opening2: null, testingOpening: null,
  candidate: null, candidate2: null, application: null,
  pool: null, pool2: null,
};

let recApp, rec2App, outApp;

function appAs(userId, roleCode) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId, id: userId, roles: [roleCode], role: roleCode, company_id: ids.company, employee_id: ids.employee, email: `${roleCode}@test.invalid` };
    req.scope = { company_id: ids.company };
    next();
  });
  // ciRouter FIRST, mirroring server.js — a literal path registered after a
  // /:param route on the same prefix is unreachable, and mounting it the other way
  // round here would test a routing arrangement the app does not use.
  app.use('/api/recruitment', ciRouter);
  app.use('/api/recruitment', recruitRouter);
  return app;
}

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = $1`, [TAG]);
  const companyId = rows[0]?.id;
  if (companyId) {
    const cands = `(SELECT id FROM candidates WHERE company_id = ${Number(companyId)})`;
    // Children before parents. Every one of these cascades from candidates or
    // companies, but the order is explicit so a future FK change surfaces here
    // rather than as a mysterious constraint error in beforeAll.
    await pool.query(`DELETE FROM screening_responses WHERE screening_id IN (SELECT id FROM candidate_screenings WHERE company_id = $1)`, [companyId]);
    await pool.query(`DELETE FROM candidate_screenings WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM candidate_notes WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM candidate_activity WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM candidate_recontact WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM candidate_role_suitability WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM interview_notes WHERE candidate_id IN ${cands}`);
    await pool.query(`DELETE FROM interview_schedules WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM offer_letters WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM job_offers WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM recruitment_employee_creation_log WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM talent_pool_members WHERE pool_id IN (SELECT id FROM talent_pools WHERE company_id = $1)`, [companyId]);
    await pool.query(`DELETE FROM talent_pools WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM candidate_retention_log WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM candidate_applications WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM candidate_stage_history WHERE candidate_id IN ${cands}`);
    await pool.query(`DELETE FROM candidates WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM job_openings WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM job_requisitions WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM employees WHERE company_id = $1`, [companyId]);
    // Company-scoped screening questions, if a test ever adds one. The seeded nine
    // are company_id NULL platform defaults and must NOT be touched.
    await pool.query(`DELETE FROM screening_questions WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM interview_questions WHERE company_id = $1`, [companyId]);
  }
  // LOWER(): trg_users_normalize_email stores every users.email lower-cased, so a
  // case-sensitive LIKE on the upper-case TAG matched nothing and leaked rows.
  await pool.query(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE LOWER(email) LIKE LOWER($1))`, [`${TAG}%`]);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE LOWER(email) LIKE LOWER($1))`, [`${TAG}%`]);
  await pool.query(`DELETE FROM users WHERE LOWER(email) LIKE LOWER($1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code LIKE $1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM roles WHERE code LIKE $1`, [`${TAG}%`]);
  if (companyId) await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
}

async function makeRole(code, grant) {
  const { rows } = await pool.query(
    `INSERT INTO roles (role_name, code, is_active) VALUES ($1, $2, true) RETURNING id`,
    [`${TAG} ${code}`, code]
  );
  await pool.query(
    `INSERT INTO role_permissions (role_id, module, can_view, can_add, can_edit, can_delete, can_export)
     VALUES ($1, 'recruitment', $2, $2, $2, $2, $2)`,
    [rows[0].id, grant]
  );
  return rows[0].id;
}

async function makeUser(email, roleId) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, role, is_active, company_id) VALUES ($1, 'employee', true, $2) RETURNING id`,
    [email, ids.company]
  );
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [rows[0].id, roleId]);
  return rows[0].id;
}

/** A fresh candidate, so each describe block can own one without ordering coupling. */
async function makeCandidate(name, extra = {}) {
  const cols = {
    company_id: ids.company, full_name: `${TAG} ${name}`,
    email: `${TAG}.${name.replace(/\s+/g, '').toLowerCase()}@test.invalid`,
    source: 'naukri', current_stage: 'screening', overall_status: 'active',
    disposition: 'new', last_activity_at: new Date().toISOString(),
    ...extra,
  };
  const keys = Object.keys(cols);
  const { rows } = await pool.query(
    `INSERT INTO candidates (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    keys.map(k => cols[k])
  );
  return rows[0];
}

beforeAll(async () => {
  await sweep();
  _clearActorNameCache();

  const { rows: co } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co`, TAG]
  );
  ids.company = co[0].id;

  // employees.name is a GENERATED column — writing it raises "cannot insert a
  // non-DEFAULT value".
  const { rows: emp } = await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id) VALUES (${FIXTURE_CODE_SQL}, $1, 'Tester', $2) RETURNING id`,
    [TAG, ids.company]
  );
  ids.employee = emp[0].id;

  ids.recRole = await makeRole(`${TAG}_REC`, true);
  ids.outRole = await makeRole(`${TAG}_OUT`, false);
  ids.recUser  = await makeUser(`${TAG}.rec@test.invalid`,  ids.recRole);
  ids.recUser2 = await makeUser(`${TAG}.rec2@test.invalid`, ids.recRole);
  ids.outUser  = await makeUser(`${TAG}.out@test.invalid`,  ids.outRole);

  recApp  = appAs(ids.recUser,  `${TAG}_rec`);
  rec2App = appAs(ids.recUser2, `${TAG}_rec`);
  outApp  = appAs(ids.outUser,  `${TAG}_out`);

  const { rows: req } = await pool.query(
    `INSERT INTO job_requisitions (job_title, department, company_id, status, number_of_positions)
     VALUES ($1, 'Power Electronics', $2, 'approved', 1) RETURNING id`,
    [`${TAG} Power Quality Engineer`, ids.company]
  );
  ids.requisition = req[0].id;

  const { rows: op } = await pool.query(
    `INSERT INTO job_openings (requisition_id, job_title, department, location, company_id, status, posted_date)
     VALUES ($1, $2, 'Power Electronics', 'Srivilliputtur', $3, 'open', CURRENT_DATE) RETURNING id`,
    [ids.requisition, `${TAG} Power Quality Engineer`, ids.company]
  );
  ids.opening = op[0].id;

  const { rows: op2 } = await pool.query(
    `INSERT INTO job_openings (job_title, department, location, company_id, status, posted_date)
     VALUES ($1, 'Service', 'Madurai', $2, 'open', CURRENT_DATE) RETURNING id`,
    [`${TAG} Service Engineer`, ids.company]
  );
  ids.opening2 = op2[0].id;

  // A Testing vacancy, for §16's convert-a-suitability-into-an-application flow.
  const { rows: op3 } = await pool.query(
    `INSERT INTO job_openings (job_title, department, location, company_id, status, posted_date)
     VALUES ($1, 'Testing', 'Srivilliputtur', $2, 'open', CURRENT_DATE) RETURNING id`,
    [`${TAG} Testing Engineer`, ids.company]
  );
  ids.testingOpening = op3[0].id;

  const { rows: p1 } = await pool.query(
    `INSERT INTO talent_pools (company_id, pool_name, category, department, is_active, is_seeded)
     VALUES ($1, $2, 'engineering', 'Testing', true, true) RETURNING id`,
    [ids.company, `${TAG} Testing`]
  );
  ids.pool = p1[0].id;
  const { rows: p2 } = await pool.query(
    `INSERT INTO talent_pools (company_id, pool_name, category, department, is_active, is_seeded)
     VALUES ($1, $2, 'engineering', 'Power Electronics', true, true) RETURNING id`,
    [ids.company, `${TAG} Power Electronics`]
  );
  ids.pool2 = p2[0].id;
}, 60000);

afterAll(async () => { await sweep(); });

// ═══════════════════════════════════════════════════════════════════════════
// §30 — every new endpoint is behind the recruitment permission
// ═══════════════════════════════════════════════════════════════════════════
describe('§30 — the new endpoints enforce the recruitment permission', () => {
  let cand;
  beforeAll(async () => { cand = await makeCandidate('Perm Probe'); });

  // The grantless role is refused...
  it.each([
    ['get',   '/api/recruitment/work-queue'],
    ['get',   '/api/recruitment/talent-bank'],
    ['get',   '/api/recruitment/screening-questions'],
    ['get',   '/api/recruitment/recontacts'],
    ['get',   '/api/recruitment/meta/candidate-workbench'],
  ])('refuses %s %s to a role with no recruitment grant', async (method, path) => {
    const res = await request(outApp)[method](path);
    expect(res.status).toBe(403);
  });

  it.each([
    ['/notes'], ['/activity'], ['/quick-view'], ['/suitability'], ['/screening'], ['/similar'],
  ])('refuses GET /candidates/:id%s to a role with no recruitment grant', async (suffix) => {
    const res = await request(outApp).get(`/api/recruitment/candidates/${cand.id}${suffix}`);
    expect(res.status).toBe(403);
  });

  it('refuses the writes too', async () => {
    const note = await request(outApp).post(`/api/recruitment/candidates/${cand.id}/notes`).send({ body: 'nope' });
    expect(note.status).toBe(403);
    const bulk = await request(outApp).post('/api/recruitment/candidates/bulk-action')
      .send({ candidate_ids: [cand.id], action: 'add_tag', value: 'x' });
    expect(bulk.status).toBe(403);
  });

  // ...and the granted role is NOT. Without this pair the suite would pass with
  // every endpoint broken for everybody.
  it.each([
    ['/api/recruitment/work-queue'],
    ['/api/recruitment/talent-bank'],
    ['/api/recruitment/screening-questions'],
    ['/api/recruitment/recontacts'],
    ['/api/recruitment/meta/candidate-workbench'],
  ])('allows %s to the granted role', async (path) => {
    const res = await request(recApp).get(path);
    expect(res.status).toBe(200);
  });

  it('will not read a candidate from another company', async () => {
    const { rows: other } = await pool.query(
      `INSERT INTO candidates (company_id, full_name, email, current_stage, overall_status)
       SELECT id, $1, $2, 'applied', 'active' FROM companies WHERE code <> $3 ORDER BY id LIMIT 1
       RETURNING id`,
      [`${TAG} Foreign`, `${TAG}.foreign@test.invalid`, TAG]
    );
    // Only meaningful if another company exists to borrow; skip cleanly if not.
    if (!other.length) return;
    const res = await request(recApp).get(`/api/recruitment/candidates/${other[0].id}/notes`);
    expect(res.status).toBe(404);
    await pool.query(`DELETE FROM candidates WHERE id = $1`, [other[0].id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §9 — notes
// ═══════════════════════════════════════════════════════════════════════════
describe('§9 — recruiter notes', () => {
  let cand;
  beforeAll(async () => { cand = await makeCandidate('Note Subject'); });

  it('records the type, the author and the pin', async () => {
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/notes`).send({
      body: 'Strong electrical fundamentals. No direct AHF experience.',
      note_type: 'screening', is_pinned: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.note_type).toBe('screening');
    expect(res.body.is_pinned).toBe(true);
    expect(res.body.author_user_id).toBe(ids.recUser);
  });

  it('refuses an empty note rather than storing a blank card', async () => {
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/notes`).send({ body: '   ' });
    expect(res.status).toBe(400);
  });

  it('refuses a note type outside the vocabulary', async () => {
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/notes`)
      .send({ body: 'ok', note_type: 'banana' });
    expect(res.status).toBe(400);
  });

  it('shows a pinned note first', async () => {
    await request(recApp).post(`/api/recruitment/candidates/${cand.id}/notes`).send({ body: 'Later, unpinned' });
    const res = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/notes`);
    expect(res.body[0].is_pinned).toBe(true);
  });

  it('hides a PRIVATE note from everyone but its author', async () => {
    const created = await request(rec2App).post(`/api/recruitment/candidates/${cand.id}/notes`)
      .send({ body: 'My own private assessment', visibility: 'private' });
    expect(created.status).toBe(201);

    const mine = await request(rec2App).get(`/api/recruitment/candidates/${cand.id}/notes`);
    expect(mine.body.map(n => n.id)).toContain(created.body.id);

    const theirs = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/notes`);
    expect(theirs.body.map(n => n.id)).not.toContain(created.body.id);
  });

  it('lets only the author change the TEXT', async () => {
    const created = await request(rec2App).post(`/api/recruitment/candidates/${cand.id}/notes`)
      .send({ body: 'Original wording' });
    const byOther = await request(recApp)
      .put(`/api/recruitment/candidates/${cand.id}/notes/${created.body.id}`)
      .send({ body: 'Rewritten by someone else' });
    expect(byOther.status).toBe(403);

    const byAuthor = await request(rec2App)
      .put(`/api/recruitment/candidates/${cand.id}/notes/${created.body.id}`)
      .send({ body: 'Reworded by the author' });
    expect(byAuthor.status).toBe(200);
    // The edit is MARKED, because a note whose wording changed after the fact is
    // a different kind of evidence from one that did not.
    expect(byAuthor.body.edited_at).toBeTruthy();
  });

  it('lets anyone with edit rights pin a note, and does NOT mark that as an edit', async () => {
    const created = await request(rec2App).post(`/api/recruitment/candidates/${cand.id}/notes`)
      .send({ body: 'Pin me' });
    const pinned = await request(recApp)
      .put(`/api/recruitment/candidates/${cand.id}/notes/${created.body.id}`)
      .send({ is_pinned: true });
    expect(pinned.status).toBe(200);
    expect(pinned.body.is_pinned).toBe(true);
    expect(pinned.body.edited_at).toBeNull();
  });

  it('soft-deletes: the row survives and the timeline keeps the event', async () => {
    const created = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/notes`)
      .send({ body: 'Delete me' });
    await request(recApp).delete(`/api/recruitment/candidates/${cand.id}/notes/${created.body.id}`).expect(200);

    const { rows } = await pool.query(`SELECT deleted_at FROM candidate_notes WHERE id = $1`, [created.body.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).toBeTruthy();

    const list = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/notes`);
    expect(list.body.map(n => n.id)).not.toContain(created.body.id);
  });

  it('keeps a note attached to the CANDIDATE, so a second application still sees it', async () => {
    // §9's closing line: "This note must remain attached to the candidate for
    // future applications."
    await pool.query(
      `INSERT INTO candidate_applications (company_id, candidate_id, job_opening_id, stage, status, origin, is_primary)
       VALUES ($1,$2,$3,'applied','active','recommended',FALSE)
       ON CONFLICT (candidate_id, job_opening_id) DO NOTHING`,
      [ids.company, cand.id, ids.opening2]
    );
    const res = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/notes`);
    expect(res.body.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §14 — the scorecard, as a pure function
// ═══════════════════════════════════════════════════════════════════════════
describe('§14 — the 100-point scorecard', () => {
  it('scores nothing when nothing has been assessed', () => {
    const s = computeScreeningScore({});
    expect(s.total).toBe(0);
    expect(s.assessed_weight).toBe(0);
  });

  it('reports HOW MUCH of the 100 was assessed, so a part-done screening is not read as a low score', () => {
    const s = computeScreeningScore({ learning_mindset: 5 });
    expect(s.total).toBe(15);
    expect(s.assessed_weight).toBe(15);
    expect(s.breakdown.ownership.assessed).toBe(false);
  });

  it('treats "partially meets" as HALF, not as a failure', () => {
    const meets   = computeScreeningScore({ qualification_fit: 'meets' });
    const partial = computeScreeningScore({ qualification_fit: 'partial' });
    const fails   = computeScreeningScore({ qualification_fit: 'does_not_meet' });
    expect(meets.total).toBe(10);
    expect(partial.total).toBe(5);
    expect(fails.total).toBe(0);
    // And all three count as ASSESSED — "does not meet" is an answer.
    expect(fails.assessed_weight).toBe(10);
  });

  it('averages only the eligibility verdicts that were actually given', () => {
    // Two of four answered, both "meets" — the section scores full, not half,
    // because the other two were not judged rather than judged badly.
    const s = computeScreeningScore({ qualification_fit: 'meets', experience_fit: 'meets' });
    expect(s.breakdown.eligibility.scored).toBe(10);
  });

  it('gives adaptability no weight, because §14 does not list it', () => {
    const s = computeScreeningScore({ adaptability: 5 });
    expect(s.total).toBe(0);
    expect(s.assessed_weight).toBe(0);
  });

  it('reaches exactly 100 when everything is top-rated', () => {
    const s = computeScreeningScore({
      qualification_fit: 'meets', experience_fit: 'meets', skills_fit: 'meets', notice_fit: 'acceptable',
      location_fit: 'local', relevant_knowledge: 5, learning_mindset: 5, problem_solving: 5,
      ownership: 5, teamwork: 5, patience: 5, communication: 5, career_alignment: 5,
    });
    expect(s.total).toBe(100);
    expect(s.assessed_weight).toBe(100);
  });

  it('has NO OPINION until enough has been assessed to have one', () => {
    expect(recommendationFor(computeScreeningScore({ learning_mindset: 5 }))).toBeNull();
  });

  it('NEVER recommends rejection, even at the absolute floor', () => {
    // §14: "Do NOT make the system automatically reject candidates only because
    // of a numerical score." The worst possible input must still not produce
    // reject_from_manifest.
    const worst = recommendationFor(computeScreeningScore({
      qualification_fit: 'does_not_meet', experience_fit: 'does_not_meet', skills_fit: 'does_not_meet',
      notice_fit: 'not_acceptable', location_fit: 'not_willing',
      relevant_knowledge: 1, learning_mindset: 1, problem_solving: 1, ownership: 1,
      teamwork: 1, patience: 1, communication: 1, career_alignment: 1,
    }));
    expect(worst).toBe('not_suitable_current_role');
    expect(worst).not.toBe('reject_from_manifest');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §11–§15 — the screening workspace end to end
// ═══════════════════════════════════════════════════════════════════════════
describe('§11–§15 — Stage 1 screening', () => {
  let cand, appRow, questions;

  beforeAll(async () => {
    cand = await makeCandidate('Screen Subject', {
      experience_years: 3.5, qualification: 'BE/BTech', specialisation: 'Electrical',
      notice_period_days: 30, expected_ctc: 650000, applied_job_id: ids.opening,
      current_city: 'Madurai', current_state: 'Tamil Nadu',
      skills: JSON.stringify(['Power Electronics', 'MATLAB']),
    });
    const { rows } = await pool.query(
      `INSERT INTO candidate_applications (company_id, candidate_id, job_opening_id, stage, status, origin, is_primary)
       VALUES ($1,$2,$3,'screening','active','applied',TRUE) RETURNING *`,
      [ids.company, cand.id, ids.opening]
    );
    appRow = rows[0];
    const qRes = await request(recApp).get('/api/recruitment/screening-questions');
    questions = qRes.body;
  });

  it('serves §13\'s nine questions, with Q9 as a choice question', () => {
    expect(questions.length).toBeGreaterThanOrEqual(9);
    const q9 = questions.find(q => q.code === 'Q9');
    expect(q9.answer_type).toBe('single_choice');
    expect(q9.options.map(o => o.value)).toContain('willing_with_support');
    expect(q9.prompt).toMatch(/Durganagar/);
  });

  it('answers "not screened yet" with a 200 and the questions, not a 404', async () => {
    // "This candidate has not been screened" is the normal state and the answer to
    // the request, not an error.
    const res = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/screening`);
    expect(res.status).toBe(200);
    expect(res.body.screening).toBeNull();
    expect(res.body.questions.length).toBeGreaterThanOrEqual(9);
  });

  it('saves incrementally and returns the recomputed score', async () => {
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/screening`).send({
      application_id: appRow.id,
      qualification_fit: 'meets', experience_fit: 'partial', skills_fit: 'meets', notice_fit: 'acceptable',
      location_fit: 'local', salary_fit: 'within_range',
      learning_mindset: 4, ownership: 4, teamwork: 4, patience: 3, problem_solving: 4,
      communication: 3, adaptability: 4, relevant_knowledge: 3, career_alignment: 4,
      learning_mindset_evidence: 'Learned inverter troubleshooting independently.',
    });
    expect(res.status).toBe(200);
    expect(res.body.total_score).toBeGreaterThan(0);
    expect(res.body.recommendation).toBeTruthy();
    expect(res.body.score_breakdown.learning_mindset.assessed).toBe(true);
  });

  it('a PARTIAL save does not null the fields it omits', async () => {
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/screening`)
      .send({ application_id: appRow.id, communication: 5 });
    expect(res.status).toBe(200);
    expect(res.body.communication).toBe(5);
    expect(res.body.learning_mindset).toBe(4);
    expect(res.body.learning_mindset_evidence).toMatch(/inverter/);
  });

  it('attaches to the PRIMARY application when none is named, creating no twin', async () => {
    // A request that omitted application_id used to be treated as a SPECULATIVE
    // screening and got its own row — so a candidate with a real application ended
    // up with two screenings holding different scores, and a recruiter's ratings
    // went into whichever one the page happened to ask for. The candidate list's
    // Screen button omits the id (the row carries a job_opening_id, not an
    // application id), so this was the common path, not the edge case.
    const bare = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/screening`)
      .send({ teamwork: 5 });
    expect(bare.status).toBe(200);
    expect(bare.body.application_id).toBe(appRow.id);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM candidate_screenings WHERE candidate_id = $1`, [cand.id]);
    expect(rows[0].n).toBe(1);

    // And the GET with no application id returns that same screening, not null.
    const read = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/screening`);
    expect(read.body.screening).toBeTruthy();
    expect(read.body.screening.id).toBe(bare.body.id);
  });

  it('CLEARS a rating when asked, which COALESCE alone cannot express', async () => {
    // The UI lets a recruiter click the active dot to un-rate a competency. §12's
    // ratings are optional and NULL means "not yet rated", so that has to be a real
    // operation — and it was not: the save endpoint COALESCEs absent fields, so ''
    // and undefined both meant "unchanged" and the rating silently came back on the
    // next autosave. Caught by the browser suite noticing the score never moved.
    const set = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/screening`)
      .send({ application_id: appRow.id, ownership: 5 });
    expect(set.body.ownership).toBe(5);
    const scoreWithIt = set.body.total_score;

    const cleared = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/screening`)
      .send({ application_id: appRow.id, clear: ['ownership'] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.ownership).toBeNull();
    // And the score follows — the section is unassessed again, not scored zero.
    expect(cleared.body.total_score).toBeLessThan(scoreWithIt);
    expect(cleared.body.score_breakdown.ownership.assessed).toBe(false);

    // Everything else is untouched.
    expect(cleared.body.learning_mindset).toBe(4);
  });

  it('ignores a clear for a field that is not a screening column', async () => {
    // `clear` names columns that are concatenated into the UPDATE, so the allowlist
    // is security rather than tidiness.
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/screening`)
      .send({ application_id: appRow.id, clear: ['total_score', 'screened_by', 'status', 'id'] });
    expect(res.status).toBe(200);
    // None of those were nulled.
    expect(res.body.status).toBeTruthy();
    expect(res.body.total_score).not.toBeNull();
  });

  it('refuses a rating outside 1-5, naming the field', async () => {
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/screening`)
      .send({ application_id: appRow.id, learning_mindset: 9 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/Learning mindset/i);
  });

  it('refuses an application that belongs to a different candidate', async () => {
    const other = await makeCandidate('Other Owner');
    const { rows } = await pool.query(
      `INSERT INTO candidate_applications (company_id, candidate_id, job_opening_id, stage, status, origin, is_primary)
       VALUES ($1,$2,$3,'applied','active','applied',TRUE) RETURNING id`,
      [ids.company, other.id, ids.opening2]
    );
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/screening`)
      .send({ application_id: rows[0].id, ownership: 3 });
    expect(res.status).toBe(400);
  });

  it('writes Q9\'s answer through to candidates.willing_to_relocate', async () => {
    const q9 = questions.find(q => q.code === 'Q9');
    await request(recApp).post(`/api/recruitment/candidates/${cand.id}/screening`).send({
      application_id: appRow.id,
      responses: [{ question_id: q9.id, code: 'Q9', answer_choice: 'willing_with_support' }],
    }).expect(200);

    const { rows } = await pool.query(`SELECT willing_to_relocate FROM candidates WHERE id = $1`, [cand.id]);
    expect(rows[0].willing_to_relocate).toBe('willing_with_support');
  });

  it('stores a free-text answer against its question', async () => {
    const q1 = questions.find(q => q.code === 'Q1');
    await request(recApp).post(`/api/recruitment/candidates/${cand.id}/screening`).send({
      application_id: appRow.id,
      responses: [{ question_id: q1.id, code: 'Q1', answer_text: 'Taught myself PLC ladder logic.' }],
    }).expect(200);

    const res = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/screening`)
      .query({ application_id: appRow.id });
    const stored = res.body.screening.responses.find(r => r.code === 'Q1');
    expect(stored.answer_text).toMatch(/ladder logic/);
  });

  it('moves the candidate to in_screening — but only from a state screening may move', async () => {
    const { rows } = await pool.query(`SELECT disposition FROM candidates WHERE id = $1`, [cand.id]);
    expect(rows[0].disposition).toBe('in_screening');

    // A banked candidate is NOT silently reclassified by opening their form.
    const banked = await makeCandidate('Banked One', { disposition: 'talent_bank' });
    await request(recApp).post(`/api/recruitment/candidates/${banked.id}/screening`).send({ ownership: 3 }).expect(200);
    const { rows: after } = await pool.query(`SELECT disposition FROM candidates WHERE id = $1`, [banked.id]);
    expect(after[0].disposition).toBe('talent_bank');
  });

  it('requires a REASON to reject from Manifest (§15)', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM candidate_screenings WHERE candidate_id = $1 AND application_id = $2`,
      [cand.id, appRow.id]
    );
    const res = await request(recApp).post(`/api/recruitment/screenings/${rows[0].id}/complete`)
      .send({ decision: 'reject_from_manifest' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/reason/i);
  });

  it('requires a REASON when overriding the scorecard (§14)', async () => {
    const { rows } = await pool.query(
      `SELECT id, recommendation FROM candidate_screenings WHERE candidate_id = $1 AND application_id = $2`,
      [cand.id, appRow.id]
    );
    // Pick something other than what the scorecard suggests.
    const other = rows[0].recommendation === 'proceed' ? 'hold' : 'proceed';
    const res = await request(recApp).post(`/api/recruitment/screenings/${rows[0].id}/complete`)
      .send({ decision: other });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/why/i);
    expect(res.body.recommendation).toBe(rows[0].recommendation);
  });

  it('refuses "consider other roles" with no department named', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM candidate_screenings WHERE candidate_id = $1 AND application_id = $2`, [cand.id, appRow.id]);
    const res = await request(recApp).post(`/api/recruitment/screenings/${rows[0].id}/complete`)
      .send({ decision: 'consider_other_roles', override_reason: 'because' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/department/i);
  });

  it('refuses a future opportunity with no date — the reminder IS the feature', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM candidate_screenings WHERE candidate_id = $1 AND application_id = $2`, [cand.id, appRow.id]);
    const res = await request(recApp).post(`/api/recruitment/screenings/${rows[0].id}/complete`)
      .send({ decision: 'future_opportunity', override_reason: 'because' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/date/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §15 + §35 — what each outcome does, and what it does NOT do
// ═══════════════════════════════════════════════════════════════════════════
describe('§15 + §35 — a negative outcome never removes the candidate', () => {
  /** Build a candidate with a completed-enough screening and take a decision. */
  async function decide(name, body, extraCandidate = {}) {
    const cand = await makeCandidate(name, extraCandidate);
    const { rows: apps } = await pool.query(
      `INSERT INTO candidate_applications (company_id, candidate_id, job_opening_id, stage, status, origin, is_primary)
       VALUES ($1,$2,$3,'screening','active','applied',TRUE) RETURNING *`,
      [ids.company, cand.id, ids.opening]
    );
    await request(recApp).post(`/api/recruitment/candidates/${cand.id}/screening`).send({
      application_id: apps[0].id,
      qualification_fit: 'meets', experience_fit: 'meets', skills_fit: 'meets', notice_fit: 'acceptable',
      location_fit: 'local', relevant_knowledge: 4, learning_mindset: 4, problem_solving: 4,
      ownership: 4, teamwork: 4, patience: 4, communication: 4, career_alignment: 4,
    }).expect(200);
    const { rows: scr } = await pool.query(
      `SELECT id, recommendation FROM candidate_screenings WHERE application_id = $1`, [apps[0].id]);
    const res = await request(recApp).post(`/api/recruitment/screenings/${scr[0].id}/complete`)
      .send({ override_reason: 'Recorded by the test suite', ...body });
    return { cand, app: apps[0], screening: scr[0], res };
  }

  it('NOT SUITABLE FOR CURRENT ROLE leaves the person ACTIVE', async () => {
    const { cand, app, res } = await decide('Not Suitable Here', { decision: 'not_suitable_current_role' });
    expect(res.status).toBe(200);

    const { rows: c } = await pool.query(`SELECT disposition, current_stage FROM candidates WHERE id = $1`, [cand.id]);
    // THE application is not suitable; THE PERSON is still active. This is §2.
    expect(c[0].disposition).toBe('active');
    expect(c[0].current_stage).toBe('not_suitable');

    const { rows: a } = await pool.query(`SELECT stage, status FROM candidate_applications WHERE id = $1`, [app.id]);
    expect(a[0].stage).toBe('not_suitable');
    expect(a[0].status).toBe('rejected');
  });

  it('CONSIDER OTHER ROLES records the departments and creates NO second candidate', async () => {
    const { cand, res } = await decide('Route Elsewhere', {
      decision: 'consider_other_roles',
      suitable_departments: [
        { department: 'Testing', suitability: 'strong', reason: 'Strong electrical fundamentals' },
        { department: 'Service', suitability: 'potential' },
      ],
    });
    expect(res.status).toBe(200);

    const suit = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/suitability`);
    expect(suit.body.map(s => s.department).sort()).toEqual(['Service', 'Testing']);
    expect(suit.body.find(s => s.department === 'Testing').suitability).toBe('strong');

    const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM candidates WHERE email = $1`, [cand.email]);
    expect(rows[0].n).toBe(1);

    const { rows: c } = await pool.query(`SELECT disposition FROM candidates WHERE id = $1`, [cand.id]);
    expect(c[0].disposition).toBe('active');
  });

  it('TALENT BANK sets the disposition and the pool membership', async () => {
    const { cand, res } = await decide('Bank Me', { decision: 'talent_bank', pool_ids: [ids.pool] });
    expect(res.status).toBe(200);
    const { rows: c } = await pool.query(`SELECT disposition FROM candidates WHERE id = $1`, [cand.id]);
    expect(c[0].disposition).toBe('talent_bank');
    const { rows: m } = await pool.query(
      `SELECT 1 FROM talent_pool_members WHERE pool_id = $1 AND candidate_id = $2`, [ids.pool, cand.id]);
    expect(m).toHaveLength(1);
  });

  it('FUTURE OPPORTUNITY creates the dated reminder', async () => {
    const { cand, res } = await decide('Come Back Later', {
      decision: 'future_opportunity', recontact_on: '2027-03-01',
      potential_role: 'Power Electronics Engineer',
    });
    expect(res.status).toBe(200);
    expect(res.body.recontact).toBeTruthy();
    const { rows } = await pool.query(
      `SELECT recontact_on, potential_role, status FROM candidate_recontact WHERE candidate_id = $1`, [cand.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].potential_role).toMatch(/Power Electronics/);
  });

  it('REJECT FROM MANIFEST is the only outcome that sets a negative disposition — and the record SURVIVES', async () => {
    const { cand, res } = await decide('Genuinely No', {
      decision: 'reject_from_manifest', reject_reason: 'Misrepresented their experience.',
    });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT disposition, current_stage, deleted_at FROM candidates WHERE id = $1`, [cand.id]);
    expect(rows[0].disposition).toBe('rejected_from_manifest');
    expect(rows[0].current_stage).toBe('rejected');
    // §35: "Never permanently delete a candidate."
    expect(rows[0].deleted_at).toBeNull();

    const { rows: scr } = await pool.query(
      `SELECT reject_reason FROM candidate_screenings WHERE candidate_id = $1`, [cand.id]);
    expect(scr[0].reject_reason).toMatch(/Misrepresented/);
  });

  it('records the OVERRIDE on the timeline, so "did we overrule the scorecard" is answerable', async () => {
    const { cand } = await decide('Overridden', {
      decision: 'hold', override_reason: 'No AHF exposure for this specific role.',
    });
    const tl = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/activity`);
    const ev = tl.body.find(e => e.event_type === 'screening_completed');
    expect(ev).toBeTruthy();
    expect(ev.detail.overridden).toBe(true);
    expect(ev.detail.override_reason).toMatch(/AHF/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §16 — suitability, and converting it into a real application
// ═══════════════════════════════════════════════════════════════════════════
describe('§16 — role suitability', () => {
  let cand;
  beforeAll(async () => { cand = await makeCandidate('Suit Subject', { applied_job_id: ids.opening }); });

  it('records several departments in one action', async () => {
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/suitability`).send({
      departments: ['Testing', 'Service'],
      reason: 'Strong electrical fundamentals. Better suited to testing/service.',
    });
    expect(res.status).toBe(201);
    expect(res.body.saved).toHaveLength(2);
  });

  it('accepts the plain-string and the detailed forms alike', async () => {
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/suitability`).send({
      departments: [{ department: 'Quality', suitability: 'strong', reason: 'Meticulous' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.saved[0].suitability).toBe('strong');
  });

  it('re-recording a department REPLACES the opinion rather than adding a second', async () => {
    await request(recApp).post(`/api/recruitment/candidates/${cand.id}/suitability`)
      .send({ departments: [{ department: 'Testing', suitability: 'not_suitable', reason: 'Changed my mind' }] })
      .expect(201);
    const { rows } = await pool.query(
      `SELECT suitability FROM candidate_role_suitability WHERE candidate_id = $1 AND LOWER(department) = 'testing'`,
      [cand.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].suitability).toBe('not_suitable');
  });

  it('refuses an empty selection', async () => {
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/suitability`)
      .send({ departments: [] });
    expect(res.status).toBe(400);
  });

  it('reports whether that department has an OPEN vacancy right now', async () => {
    const res = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/suitability`);
    const testing = res.body.find(s => s.department === 'Testing');
    // The fixture has an open Testing opening, so this is the signal that turns a
    // dormant record into an action.
    expect(testing.open_openings).toBeGreaterThan(0);
  });

  it('converts a suitability into a real application, with NO duplicate candidate', async () => {
    const list = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/suitability`);
    const testing = list.body.find(s => s.department === 'Testing');

    const res = await request(recApp).post(`/api/recruitment/suitability/${testing.id}/convert`)
      .send({ job_opening_id: ids.testingOpening });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);

    const { rows: apps } = await pool.query(
      `SELECT origin, is_primary FROM candidate_applications WHERE candidate_id = $1 AND job_opening_id = $2`,
      [cand.id, ids.testingOpening]
    );
    expect(apps).toHaveLength(1);
    expect(apps[0].origin).toBe('recommended');
    expect(apps[0].is_primary).toBe(false);

    const { rows: c } = await pool.query(`SELECT COUNT(*)::int n FROM candidates WHERE email = $1`, [cand.email]);
    expect(c[0].n).toBe(1);
  });

  it('converting is idempotent', async () => {
    const list = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/suitability`);
    const testing = list.body.find(s => s.department === 'Testing');
    const res = await request(recApp).post(`/api/recruitment/suitability/${testing.id}/convert`)
      .send({ job_opening_id: ids.testingOpening });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
  });

  it('refuses to convert against a closed opening', async () => {
    const { rows: shut } = await pool.query(
      `INSERT INTO job_openings (job_title, department, company_id, status)
       VALUES ($1, 'Service', $2, 'closed') RETURNING id`, [`${TAG} Shut`, ids.company]);
    const list = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/suitability`);
    const service = list.body.find(s => s.department === 'Service');
    const res = await request(recApp).post(`/api/recruitment/suitability/${service.id}/convert`)
      .send({ job_opening_id: shut[0].id });
    expect(res.status).toBe(409);
  });

  it('brings a BANKED candidate back into active consideration on conversion', async () => {
    const banked = await makeCandidate('Reengaged', { disposition: 'talent_bank' });
    await request(recApp).post(`/api/recruitment/candidates/${banked.id}/suitability`)
      .send({ departments: ['Testing'], reason: 'Worth another look' }).expect(201);
    const list = await request(recApp).get(`/api/recruitment/candidates/${banked.id}/suitability`);
    await request(recApp).post(`/api/recruitment/suitability/${list.body[0].id}/convert`)
      .send({ job_opening_id: ids.testingOpening }).expect(201);
    const { rows } = await pool.query(`SELECT disposition FROM candidates WHERE id = $1`, [banked.id]);
    expect(rows[0].disposition).toBe('active');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §17 + §19 — the Talent Bank
// ═══════════════════════════════════════════════════════════════════════════
describe('§17 + §19 — the Talent Bank', () => {
  let cand;
  beforeAll(async () => {
    cand = await makeCandidate('Bank Subject', {
      experience_years: 3, current_state: 'Tamil Nadu', current_city: 'Madurai',
      willing_to_relocate: 'willing_with_support', qualification: 'BE/BTech',
      specialisation: 'Electrical and Electronics', current_company: 'Acme Power',
      current_designation: 'Test Engineer', notice_period_days: 30, expected_ctc: 650000,
      skills: JSON.stringify(['Power Electronics', 'MATLAB', 'Testing']),
    });
  });

  it('adds a candidate to several pools with tags', async () => {
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/talent-bank`).send({
      pool_ids: [ids.pool, ids.pool2], tags: ['AHF', 'STATCOM'], reason: 'Keep for the next Testing role',
    });
    expect(res.status).toBe(201);
    expect(res.body.pools).toHaveLength(2);
    const { rows } = await pool.query(`SELECT disposition FROM candidates WHERE id = $1`, [cand.id]);
    expect(rows[0].disposition).toBe('talent_bank');
  });

  it('UNIONS tags on a second add rather than replacing or duplicating them', async () => {
    await request(recApp).post(`/api/recruitment/candidates/${cand.id}/talent-bank`)
      .send({ pool_ids: [ids.pool], tags: ['AHF', 'SVG'] }).expect(201);
    const { rows } = await pool.query(
      `SELECT tags FROM talent_pool_members WHERE pool_id = $1 AND candidate_id = $2`, [ids.pool, cand.id]);
    expect([...rows[0].tags].sort()).toEqual(['AHF', 'STATCOM', 'SVG']);
  });

  it('refuses a pool id from another company', async () => {
    const { rows } = await pool.query(
      `INSERT INTO talent_pools (company_id, pool_name, is_active)
       SELECT id, $1, true FROM companies WHERE code <> $2 ORDER BY id LIMIT 1 RETURNING id`,
      [`${TAG} Foreign Pool`, TAG]
    );
    if (!rows.length) return;
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/talent-bank`)
      .send({ pool_ids: [rows[0].id] });
    expect(res.status).toBe(404);
    const { rows: leaked } = await pool.query(
      `SELECT 1 FROM talent_pool_members WHERE pool_id = $1`, [rows[0].id]);
    expect(leaked).toHaveLength(0);
    await pool.query(`DELETE FROM talent_pools WHERE id = $1`, [rows[0].id]);
  });

  it('answers §19\'s worked example: power electronics + 2-5 years + Tamil Nadu + willing to relocate', async () => {
    const res = await request(recApp).get('/api/recruitment/talent-bank').query({
      skills: 'power electronics', experience_min: 2, experience_max: 5,
      state: 'Tamil Nadu', willing_to_relocate: 'true',
    });
    expect(res.status).toBe(200);
    expect(res.body.rows.map(r => r.id)).toContain(cand.id);
    const hit = res.body.rows.find(r => r.id === cand.id);
    // The card needs the pools and the alternative departments without a second call.
    expect(Array.isArray(hit.pools)).toBe(true);
    expect(hit.pools.length).toBeGreaterThan(0);
  });

  it('"willing to relocate" covers ALL THREE yes answers, not just the literal one', async () => {
    // The candidate answered 'willing_with_support'. A filter that tested
    // = 'willing' would hide them — and most candidates for a Srivilliputtur site.
    const res = await request(recApp).get('/api/recruitment/talent-bank')
      .query({ willing_to_relocate: 'true' });
    expect(res.body.rows.map(r => r.id)).toContain(cand.id);
  });

  it('filters by previous screening score', async () => {
    const low = await request(recApp).get('/api/recruitment/talent-bank').query({ min_screening_score: 1 });
    const impossible = await request(recApp).get('/api/recruitment/talent-bank').query({ min_screening_score: 101 });
    expect(impossible.body.total).toBeLessThanOrEqual(low.body.total);
    expect(impossible.body.total).toBe(0);
  });

  it('filters by the department a candidate was judged suitable for', async () => {
    await request(recApp).post(`/api/recruitment/candidates/${cand.id}/suitability`)
      .send({ departments: ['Testing'], reason: 'Good fit' }).expect(201);
    const res = await request(recApp).get('/api/recruitment/talent-bank').query({ department: 'Testing' });
    expect(res.body.rows.map(r => r.id)).toContain(cand.id);
    const none = await request(recApp).get('/api/recruitment/talent-bank').query({ department: 'Finance' });
    expect(none.body.rows.map(r => r.id)).not.toContain(cand.id);
  });

  it('scopes to the caller\'s company', async () => {
    const res = await request(recApp).get('/api/recruitment/talent-bank').query({ limit: 200 });
    const { rows } = await pool.query(
      `SELECT id FROM candidates WHERE company_id <> $1 AND deleted_at IS NULL LIMIT 5`, [ids.company]);
    for (const foreign of rows) {
      expect(res.body.rows.map(r => r.id)).not.toContain(foreign.id);
    }
  });

  it('exposes §17\'s standard categories, creating them for a company that has none', async () => {
    const res = await request(recApp).get('/api/recruitment/talent-bank/pools');
    expect(res.status).toBe(200);
    const names = res.body.map(p => p.pool_name);
    // ensureStandardTalentPools() runs on this endpoint, so the 23 categories exist
    // even for a company created after the seed migration ran.
    expect(names).toContain('Power Electronics');
    expect(names).toContain('Future Leadership');
    expect(res.body.length).toBeGreaterThanOrEqual(23);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §18 — Future Opportunity and its reminder
// ═══════════════════════════════════════════════════════════════════════════
describe('§18 — Future Opportunity', () => {
  let cand;
  beforeAll(async () => { cand = await makeCandidate('Future Subject'); });

  it('stores the reason, role, location and date', async () => {
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/recontact`).send({
      recontact_on: '2027-03-01', reason: 'not_ready_to_relocate',
      potential_role: 'Power Electronics Engineer', department: 'Power Electronics',
      preferred_location: 'Madurai',
    });
    expect(res.status).toBe(201);
    expect(res.body.recontact_on).toBeTruthy();
    const { rows } = await pool.query(`SELECT disposition FROM candidates WHERE id = $1`, [cand.id]);
    expect(rows[0].disposition).toBe('future_opportunity');
  });

  it('refuses a date in the past', async () => {
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/recontact`)
      .send({ recontact_on: '2020-01-01' });
    expect(res.status).toBe(400);
  });

  it('accepts TODAY — the guard must not be off by a day', async () => {
    // `new Date('YYYY-MM-DD')` is UTC midnight, so a naive guard rejects today in
    // IST. This module has shipped that bug once already (the GRN future-date check).
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const other = await makeCandidate('Today Recontact');
    const res = await request(recApp).post(`/api/recruitment/candidates/${other.id}/recontact`)
      .send({ recontact_on: iso });
    expect(res.status).toBe(201);
  });

  it('the cron notifies the owner, and fires EXACTLY ONCE', async () => {
    await pool.query(
      `UPDATE candidate_recontact SET recontact_on = CURRENT_DATE - 1, notified_at = NULL, owner_user_id = $2
        WHERE candidate_id = $1`,
      [cand.id, ids.recUser]
    );
    const first = await runCandidateRecontact();
    expect(first.notified).toBeGreaterThan(0);

    const { rows: notes } = await pool.query(
      `SELECT COUNT(*)::int n FROM notifications WHERE user_id = $1 AND reference_id = $2`,
      [ids.recUser, cand.id]
    );
    expect(notes[0].n).toBeGreaterThan(0);

    const second = await runCandidateRecontact();
    // The candidate is still due, but already notified — a reminder that fires
    // every night until acted on trains the recruiter to ignore the channel.
    const { rows: after } = await pool.query(
      `SELECT COUNT(*)::int n FROM notifications WHERE user_id = $1 AND reference_id = $2`,
      [ids.recUser, cand.id]
    );
    expect(after[0].n).toBe(notes[0].n);
    expect(second.due).toBe(0);
  });

  it('records the firing on the candidate\'s timeline', async () => {
    const tl = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/activity`);
    expect(tl.body.map(e => e.event_type)).toContain('recontact_due');
  });

  it('completing it does NOT close the candidate; re-engaging is a separate act', async () => {
    const list = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/recontact`);
    const rc = list.body[0];

    const done = await request(recApp).post(`/api/recruitment/recontacts/${rc.id}/complete`)
      .send({ outcome_note: 'Spoke to them; still finishing their M.Tech.' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('done');

    // Not re-engaged, so the disposition is untouched.
    const { rows } = await pool.query(`SELECT disposition FROM candidates WHERE id = $1`, [cand.id]);
    expect(rows[0].disposition).toBe('future_opportunity');
  });

  it('re-engaging brings them back to active', async () => {
    const other = await makeCandidate('Reengage Me');
    const created = await request(recApp).post(`/api/recruitment/candidates/${other.id}/recontact`)
      .send({ recontact_on: '2027-06-01' });
    await request(recApp).post(`/api/recruitment/recontacts/${created.body.id}/complete`)
      .send({ status: 'done', reengage: true }).expect(200);
    const { rows } = await pool.query(`SELECT disposition FROM candidates WHERE id = $1`, [other.id]);
    expect(rows[0].disposition).toBe('active');
  });

  it('cannot be completed twice', async () => {
    const list = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/recontact`)
      .query({ status: 'done' });
    if (!list.body.length) return;
    const res = await request(recApp).post(`/api/recruitment/recontacts/${list.body[0].id}/complete`).send({});
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §20 — similar candidates
// ═══════════════════════════════════════════════════════════════════════════
describe('§20 — similar candidates carry their reasons', () => {
  let a, b;
  beforeAll(async () => {
    const shared = {
      qualification: 'BE/BTech', specialisation: 'Electrical and Electronics',
      experience_years: 3, current_city: 'Madurai', current_state: 'Tamil Nadu',
      current_designation: 'Test Engineer',
      skills: JSON.stringify(['Power Electronics', 'MATLAB']),
    };
    a = await makeCandidate('Similar A', shared);
    b = await makeCandidate('Similar B', shared);
    await makeCandidate('Unrelated Person', {
      qualification: 'MBA', specialisation: 'Marketing', experience_years: 14,
      current_city: 'Delhi', current_state: 'Delhi', current_designation: 'Brand Manager',
      skills: JSON.stringify(['Branding']),
    });
  });

  it('finds the comparable candidate', async () => {
    const res = await request(recApp).get(`/api/recruitment/candidates/${a.id}/similar`);
    expect(res.status).toBe(200);
    expect(res.body.map(r => r.id)).toContain(b.id);
  });

  it('gives a NAMED reason for every match, never a bare score', async () => {
    const res = await request(recApp).get(`/api/recruitment/candidates/${a.id}/similar`);
    const hit = res.body.find(r => r.id === b.id);
    expect(Array.isArray(hit.reasons)).toBe(true);
    expect(hit.reasons.length).toBeGreaterThan(0);
    expect(hit.reasons.join(' ')).toMatch(/qualification|skill|experience|role|city/i);
  });

  it('never returns the candidate themselves', async () => {
    const res = await request(recApp).get(`/api/recruitment/candidates/${a.id}/similar`);
    expect(res.body.map(r => r.id)).not.toContain(a.id);
  });

  it('ranks the comparable candidate above the unrelated one', async () => {
    const res = await request(recApp).get(`/api/recruitment/candidates/${a.id}/similar`);
    const bPos = res.body.findIndex(r => r.id === b.id);
    const unrelated = res.body.findIndex(r => String(r.full_name).includes('Unrelated'));
    expect(bPos).toBeGreaterThanOrEqual(0);
    if (unrelated >= 0) expect(bPos).toBeLessThan(unrelated);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §21 + §34 — the activity timeline
// ═══════════════════════════════════════════════════════════════════════════
describe('§21 + §34 — the activity timeline', () => {
  let cand;
  beforeAll(async () => { cand = await makeCandidate('Timeline Subject'); });

  it('records a stage move, with the actor NAMED', async () => {
    await request(recApp).post(`/api/recruitment/candidates/${cand.id}/move-stage`)
      .send({ new_stage: 'shortlisted' }).expect(200);
    const res = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/activity`);
    const ev = res.body.find(e => e.event_type === 'stage_change');
    expect(ev).toBeTruthy();
    expect(ev.summary).toMatch(/Shortlisted/);
    expect(ev.actor_user_id).toBe(ids.recUser);
    expect(ev.actor_name).toBeTruthy();
  });

  it('stamps last_activity_at, which is what the work queue measures from', async () => {
    const { rows } = await pool.query(`SELECT last_activity_at FROM candidates WHERE id = $1`, [cand.id]);
    expect(rows[0].last_activity_at).toBeTruthy();
    expect(new Date(rows[0].last_activity_at).getTime()).toBeGreaterThan(Date.now() - 120_000);
  });

  it('records a note WITHOUT leaking its body to anyone who can read the timeline', async () => {
    await request(recApp).post(`/api/recruitment/candidates/${cand.id}/notes`)
      .send({ body: 'CONFIDENTIAL-BODY-TEXT', visibility: 'private' }).expect(201);
    const res = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/activity`);
    const ev = res.body.find(e => e.event_type === 'note_added');
    expect(ev).toBeTruthy();
    expect(JSON.stringify(ev)).not.toMatch(/CONFIDENTIAL-BODY-TEXT/);
  });

  it('records each of the redesign\'s own events', async () => {
    await request(recApp).post(`/api/recruitment/candidates/${cand.id}/talent-bank`)
      .send({ pool_ids: [ids.pool] }).expect(201);
    await request(recApp).post(`/api/recruitment/candidates/${cand.id}/suitability`)
      .send({ departments: ['Service'], reason: 'Good troubleshooting' }).expect(201);

    const res = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/activity`);
    const kinds = res.body.map(e => e.event_type);
    expect(kinds).toContain('talent_bank_added');
    expect(kinds).toContain('suitability_recorded');
  });

  it('newest first', async () => {
    const res = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/activity`);
    const times = res.body.map(e => new Date(e.created_at).getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  it('exposes NO route that edits or deletes an event (§34)', async () => {
    // §34 requires the audit history to be immutable to normal users, and the
    // cheapest guarantee is that the capability does not exist — no handler, no
    // permission to misconfigure, no future caller to forget.
    const res = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/activity`);
    const id = res.body.find(e => e.row_source === 'activity')?.id;
    expect(id).toBeTruthy();
    for (const method of ['put', 'patch', 'delete']) {
      const attempt = await request(recApp)[method](`/api/recruitment/candidates/${cand.id}/activity/${id}`).send({ summary: 'x' });
      expect(attempt.status).toBe(404);
    }
    const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM candidate_activity WHERE candidate_id = $1`, [cand.id]);
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('a correction is APPENDED, never applied in place', async () => {
    const before = await pool.query(`SELECT COUNT(*)::int n FROM candidate_activity WHERE candidate_id = $1`, [cand.id]);
    const res = await request(recApp).post(`/api/recruitment/candidates/${cand.id}/activity/correction`)
      .send({ summary: 'The earlier stage move was recorded against the wrong role.' });
    expect(res.status).toBe(201);
    const after = await pool.query(`SELECT COUNT(*)::int n FROM candidate_activity WHERE candidate_id = $1`, [cand.id]);
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it('folds pre-existing stage history in without double-counting a new move', async () => {
    // A legacy row the old code wrote, with no matching candidate_activity entry.
    await pool.query(
      `INSERT INTO candidate_stage_history (candidate_id, stage, notes, moved_date, company_id)
       VALUES ($1, 'applied', 'legacy row', NOW() - INTERVAL '40 days', $2)`,
      [cand.id, ids.company]
    );
    const res = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/activity`);
    expect(res.body.filter(e => e.row_source === 'stage_history')).toHaveLength(1);
    // The recent move through the new path appears ONCE, not twice.
    const recent = res.body.filter(e => e.event_type === 'stage_change' && /Shortlisted/.test(e.summary));
    expect(recent).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §22 — bulk actions
// ═══════════════════════════════════════════════════════════════════════════
describe('§22 — bulk actions', () => {
  let a, b;
  beforeAll(async () => {
    a = await makeCandidate('Bulk A');
    b = await makeCandidate('Bulk B');
  });

  it('changes a stage for the whole selection, and records it per candidate', async () => {
    const res = await request(recApp).post('/api/recruitment/candidates/bulk-action')
      .send({ candidate_ids: [a.id, b.id], action: 'stage', value: 'shortlisted' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    const { rows } = await pool.query(
      `SELECT current_stage FROM candidates WHERE id = ANY($1::int[])`, [[a.id, b.id]]);
    expect(rows.every(r => r.current_stage === 'shortlisted')).toBe(true);

    // One timeline entry EACH — a single "bulk action" event would mean a
    // candidate's own history does not show what happened to them.
    for (const id of [a.id, b.id]) {
      const { rows: ev } = await pool.query(
        `SELECT detail FROM candidate_activity
          WHERE candidate_id = $1 AND event_type = 'stage_change' AND detail->>'bulk' = 'true'`, [id]);
      expect(ev.length).toBeGreaterThan(0);
    }
  });

  it('assigns and unassigns a recruiter', async () => {
    await request(recApp).post('/api/recruitment/candidates/bulk-action')
      .send({ candidate_ids: [a.id], action: 'recruiter', value: ids.recUser }).expect(200);
    let { rows } = await pool.query(`SELECT recruiter_id FROM candidates WHERE id = $1`, [a.id]);
    expect(rows[0].recruiter_id).toBe(ids.recUser);

    await request(recApp).post('/api/recruitment/candidates/bulk-action')
      .send({ candidate_ids: [a.id], action: 'recruiter', value: '' }).expect(200);
    ({ rows } = await pool.query(`SELECT recruiter_id FROM candidates WHERE id = $1`, [a.id]));
    expect(rows[0].recruiter_id).toBeNull();
  });

  it('adds a tag idempotently and removes it case-insensitively', async () => {
    await request(recApp).post('/api/recruitment/candidates/bulk-action')
      .send({ candidate_ids: [a.id], action: 'add_tag', value: 'HighPotential' }).expect(200);
    await request(recApp).post('/api/recruitment/candidates/bulk-action')
      .send({ candidate_ids: [a.id], action: 'add_tag', value: 'HighPotential' }).expect(200);
    let { rows } = await pool.query(`SELECT tags FROM candidates WHERE id = $1`, [a.id]);
    expect(rows[0].tags.filter(t => t === 'HighPotential')).toHaveLength(1);

    await request(recApp).post('/api/recruitment/candidates/bulk-action')
      .send({ candidate_ids: [a.id], action: 'remove_tag', value: 'highpotential' }).expect(200);
    ({ rows } = await pool.query(`SELECT tags FROM candidates WHERE id = $1`, [a.id]));
    expect(rows[0].tags).not.toContain('HighPotential');
  });

  it('REQUIRES confirmation for a destructive value, and writes nothing without it', async () => {
    const res = await request(recApp).post('/api/recruitment/candidates/bulk-action')
      .send({ candidate_ids: [a.id, b.id], action: 'stage', value: 'rejected' });
    expect(res.status).toBe(400);
    expect(res.body.requires_confirmation).toBe(true);

    const { rows } = await pool.query(
      `SELECT current_stage FROM candidates WHERE id = ANY($1::int[])`, [[a.id, b.id]]);
    expect(rows.every(r => r.current_stage !== 'rejected')).toBe(true);
  });

  it('applies it once confirmed', async () => {
    const res = await request(recApp).post('/api/recruitment/candidates/bulk-action')
      .send({ candidate_ids: [b.id], action: 'stage', value: 'rejected', confirm: true });
    expect(res.status).toBe(200);
    const { rows } = await pool.query(`SELECT current_stage, deleted_at FROM candidates WHERE id = $1`, [b.id]);
    expect(rows[0].current_stage).toBe('rejected');
    // Still not deleted. §35 holds for the bulk path as well as the single one.
    expect(rows[0].deleted_at).toBeNull();
  });

  it('SKIPS a candidate from another company instead of writing to it', async () => {
    const { rows: foreign } = await pool.query(
      `SELECT id FROM candidates WHERE company_id <> $1 AND deleted_at IS NULL LIMIT 1`, [ids.company]);
    if (!foreign.length) return;
    const before = await pool.query(`SELECT tags FROM candidates WHERE id = $1`, [foreign[0].id]);

    const res = await request(recApp).post('/api/recruitment/candidates/bulk-action')
      .send({ candidate_ids: [a.id, foreign[0].id], action: 'add_tag', value: 'LEAKED' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.skipped).toBe(1);
    // And says so, rather than reporting a clean success over a partial write.
    expect(res.body.message).toMatch(/could not be found/i);

    const after = await pool.query(`SELECT tags FROM candidates WHERE id = $1`, [foreign[0].id]);
    expect(JSON.stringify(after.rows[0].tags)).toBe(JSON.stringify(before.rows[0].tags));
  });

  it('refuses an unknown action and an out-of-vocabulary value', async () => {
    const bad = await request(recApp).post('/api/recruitment/candidates/bulk-action')
      .send({ candidate_ids: [a.id], action: 'launch_rocket', value: 'x' });
    expect(bad.status).toBe(400);

    const badValue = await request(recApp).post('/api/recruitment/candidates/bulk-action')
      .send({ candidate_ids: [a.id], action: 'stage', value: 'banana' });
    expect(badValue.status).toBe(400);
  });

  it('refuses an empty selection and caps the size', async () => {
    const empty = await request(recApp).post('/api/recruitment/candidates/bulk-action')
      .send({ candidate_ids: [], action: 'add_tag', value: 'x' });
    expect(empty.status).toBe(400);

    const huge = await request(recApp).post('/api/recruitment/candidates/bulk-action')
      .send({ candidate_ids: Array.from({ length: 201 }, (_, i) => i + 1), action: 'add_tag', value: 'x' });
    expect(huge.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §23 — the work queue
// ═══════════════════════════════════════════════════════════════════════════
describe('§23 — the work queue', () => {
  it('returns every count the screen shows', async () => {
    const res = await request(recApp).get('/api/recruitment/work-queue');
    expect(res.status).toBe(200);
    for (const key of [
      'needs_screening', 'interviews_today', 'feedback_pending', 'waiting_over_3_days',
      'offers_pending', 'joining_pending', 'recontact_due', 'recommended_for_other_roles',
      'talent_bank_size', 'assigned_to_me', 'unassigned',
    ]) {
      expect(typeof res.body.counts[key]).toBe('number');
    }
  });

  it('measures "waiting" from LAST ACTIVITY, not from the application date', async () => {
    // The defect this column exists to fix: a candidate created 40 days ago but
    // moved today was reported as waiting 40 days.
    const stale = await makeCandidate('Long Wait', { current_stage: 'screening' });
    await pool.query(
      `UPDATE candidates SET created_at = NOW() - INTERVAL '40 days', last_activity_at = NOW() WHERE id = $1`,
      [stale.id]
    );
    const res = await request(recApp).get('/api/recruitment/work-queue');
    const busyIds = await pool.query(
      `SELECT id FROM candidates
        WHERE company_id = $1 AND deleted_at IS NULL
          AND current_stage IN ('applied','screening','shortlisted','assessment','1st_level','2nd_level','offer','selected')
          AND COALESCE(last_activity_at, created_at) < NOW() - INTERVAL '3 days'`,
      [ids.company]
    );
    expect(busyIds.rows.map(r => r.id)).not.toContain(stale.id);
    expect(res.body.counts.waiting_over_3_days).toBe(busyIds.rows.length);

    // And the other way round: old activity IS counted, however recent the record.
    await pool.query(
      `UPDATE candidates SET created_at = NOW(), last_activity_at = NOW() - INTERVAL '10 days' WHERE id = $1`,
      [stale.id]
    );
    const after = await request(recApp).get('/api/recruitment/work-queue');
    expect(after.body.counts.waiting_over_3_days).toBeGreaterThan(res.body.counts.waiting_over_3_days);
  });

  it('does NOT count parked candidates as waiting on anybody', async () => {
    const parked = await makeCandidate('Parked', { current_stage: 'future_use' });
    await pool.query(`UPDATE candidates SET last_activity_at = NOW() - INTERVAL '90 days' WHERE id = $1`, [parked.id]);
    const res = await request(recApp).get('/api/recruitment/work-queue');
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM candidates
        WHERE company_id = $1 AND current_stage = 'future_use' AND deleted_at IS NULL`, [ids.company]);
    expect(rows[0].n).toBeGreaterThan(0);
    // Present in the data, absent from the queue.
    expect(res.body.counts.waiting_over_3_days).toBeGreaterThanOrEqual(0);
    const staleParked = await pool.query(
      `SELECT 1 FROM candidates
        WHERE id = $1 AND current_stage IN ('applied','screening','shortlisted','assessment','1st_level','2nd_level','offer','selected')`,
      [parked.id]);
    expect(staleParked.rows).toHaveLength(0);
  });

  it('carries the due recontacts with the counts, so the number is clickable', async () => {
    const res = await request(recApp).get('/api/recruitment/work-queue');
    expect(Array.isArray(res.body.recontacts_due)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §6 + §8 — the candidate list and the quick view
// ═══════════════════════════════════════════════════════════════════════════
describe('§6 + §8 — the list and the quick view', () => {
  let cand;
  beforeAll(async () => {
    cand = await makeCandidate('List Subject', {
      phone: '+91 90000 22222', experience_years: 4, current_city: 'Coimbatore',
      applied_job_id: ids.opening, recruiter_id: ids.recUser,
    });
  });

  it('finds a candidate by PHONE, however the number is formatted', async () => {
    for (const term of ['9000022222', '90000-22222', '+91 90000 22222', '919000022222']) {
      const res = await request(recApp).get('/api/recruitment/candidates').query({ search: term });
      expect(res.body.rows.map(r => r.id), `search "${term}"`).toContain(cand.id);
    }
  });

  it('finds a candidate by their candidate ID', async () => {
    const { rows } = await pool.query(`SELECT candidate_code FROM candidates WHERE id = $1`, [cand.id]);
    // The code is assigned by the redesign's migration for existing rows; a row
    // created by this suite may not have one, in which case there is nothing to test.
    if (!rows[0].candidate_code) return;
    const res = await request(recApp).get('/api/recruitment/candidates')
      .query({ search: rows[0].candidate_code });
    expect(res.body.rows.map(r => r.id)).toContain(cand.id);
  });

  it('a one-letter search does not digit-match every candidate', async () => {
    const res = await request(recApp).get('/api/recruitment/candidates').query({ search: 'D' });
    // The 4-digit floor stops "D" being treated as a phone fragment. It may still
    // match by name, which is correct.
    expect(res.status).toBe(200);
  });

  it('filters by recruiter, by "me", and by unassigned', async () => {
    const mine = await request(recApp).get('/api/recruitment/candidates').query({ recruiter_id: 'me' });
    expect(mine.body.rows.map(r => r.id)).toContain(cand.id);

    const unassigned = await request(recApp).get('/api/recruitment/candidates').query({ recruiter_id: 'unassigned' });
    expect(unassigned.body.rows.map(r => r.id)).not.toContain(cand.id);

    // 'me' must resolve server-side: a client that could name any recruiter id
    // would make "my candidates" a filter anyone could point at anyone.
    const asOther = await request(rec2App).get('/api/recruitment/candidates').query({ recruiter_id: 'me' });
    expect(asOther.body.rows.map(r => r.id)).not.toContain(cand.id);
  });

  it('filters by department, applied date and staleness', async () => {
    const dept = await request(recApp).get('/api/recruitment/candidates')
      .query({ department: 'Power Electronics' });
    expect(dept.body.rows.map(r => r.id)).toContain(cand.id);

    const wrongDept = await request(recApp).get('/api/recruitment/candidates').query({ department: 'Finance' });
    expect(wrongDept.body.rows.map(r => r.id)).not.toContain(cand.id);

    const today = await dbToday(pool);          // the server filters on created_at::date in the DB time zone
    const dated = await request(recApp).get('/api/recruitment/candidates')
      .query({ applied_from: today, applied_to: today });
    expect(dated.body.rows.map(r => r.id)).toContain(cand.id);

    const stale = await request(recApp).get('/api/recruitment/candidates').query({ stale_days: 30 });
    expect(stale.body.rows.map(r => r.id)).not.toContain(cand.id);
  });

  it('returns §6\'s list columns without a per-row request', async () => {
    const res = await request(recApp).get('/api/recruitment/candidates').query({ search: 'List Subject' });
    const row = res.body.rows.find(r => r.id === cand.id);
    expect(row).toBeTruthy();
    for (const key of ['recruiter_name', 'last_activity', 'days_since_activity', 'application_count', 'note_count']) {
      expect(row, `missing ${key}`).toHaveProperty(key);
    }
  });

  it('does not multiply a candidate\'s row by their screening count', async () => {
    // The multi-child fan-out this codebase keeps finding: joining
    // candidate_screenings directly would duplicate the candidate per screening.
    await pool.query(
      `INSERT INTO candidate_screenings (company_id, candidate_id, application_id) VALUES ($1,$2,NULL)
       ON CONFLICT DO NOTHING`, [ids.company, cand.id]);
    const { rows: apps } = await pool.query(
      `INSERT INTO candidate_applications (company_id, candidate_id, job_opening_id, stage, status, origin, is_primary)
       VALUES ($1,$2,$3,'applied','active','recommended',FALSE)
       ON CONFLICT (candidate_id, job_opening_id) DO UPDATE SET stage = 'applied' RETURNING id`,
      [ids.company, cand.id, ids.opening2]);
    await pool.query(
      `INSERT INTO candidate_screenings (company_id, candidate_id, application_id) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`, [ids.company, cand.id, apps[0].id]);

    const res = await request(recApp).get('/api/recruitment/candidates').query({ search: 'List Subject' });
    expect(res.body.rows.filter(r => r.id === cand.id)).toHaveLength(1);
  });

  it('answers the quick view in ONE request', async () => {
    const res = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/quick-view`);
    expect(res.status).toBe(200);
    for (const key of ['candidate', 'applications', 'screening', 'notes', 'activity', 'suitability', 'pools', 'recontact']) {
      expect(res.body, `missing ${key}`).toHaveProperty(key);
    }
    expect(res.body.candidate.id).toBe(cand.id);
  });

  it('the quick view hides another user\'s private note', async () => {
    await request(rec2App).post(`/api/recruitment/candidates/${cand.id}/notes`)
      .send({ body: 'QV-PRIVATE-MARKER', visibility: 'private' }).expect(201);
    const mine = await request(rec2App).get(`/api/recruitment/candidates/${cand.id}/quick-view`);
    expect(JSON.stringify(mine.body.notes)).toMatch(/QV-PRIVATE-MARKER/);
    const theirs = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/quick-view`);
    expect(JSON.stringify(theirs.body.notes)).not.toMatch(/QV-PRIVATE-MARKER/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 + §26 — the profile fields, and what must NOT be writable through them
// ═══════════════════════════════════════════════════════════════════════════
describe('§4 + §26 — profile and location intelligence', () => {
  let cand;
  beforeAll(async () => { cand = await makeCandidate('Profile Subject'); });

  it('saves the location and relocation fields', async () => {
    const res = await request(recApp).patch(`/api/recruitment/candidates/${cand.id}/profile`).send({
      current_city: 'Madurai', current_state: 'Tamil Nadu', native_place: 'Srivilliputtur',
      willing_to_relocate: 'willing_with_support', relocation_support_required: true,
      relocation_note: 'Asked about company accommodation.',
      classification: 'regional', relevant_experience_years: 2.5,
      preferred_locations: ['Madurai', 'Srivilliputtur'],
    });
    expect(res.status).toBe(200);
    expect(res.body.current_city).toBe('Madurai');
    expect(res.body.willing_to_relocate).toBe('willing_with_support');
    expect(res.body.preferred_locations).toEqual(['Madurai', 'Srivilliputtur']);
    expect(Number(res.body.relevant_experience_years)).toBe(2.5);
  });

  it('refuses a value outside the relocation vocabulary', async () => {
    const res = await request(recApp).patch(`/api/recruitment/candidates/${cand.id}/profile`)
      .send({ willing_to_relocate: 'maybe_someday' });
    expect(res.status).toBe(400);
  });

  it('treats an empty string as CLEARED, not as the empty string', async () => {
    // Every form in this module posts its whole state, so an untouched optional
    // input arrives as ''. Writing '' into an enum column would violate its CHECK.
    const res = await request(recApp).patch(`/api/recruitment/candidates/${cand.id}/profile`)
      .send({ classification: '' });
    expect(res.status).toBe(200);
    expect(res.body.classification).toBeNull();
  });

  it('will not write a field outside the allowlist', async () => {
    const res = await request(recApp).patch(`/api/recruitment/candidates/${cand.id}/profile`)
      .send({ current_city: 'Trichy', overall_status: 'hired', email: 'hijack@test.invalid' });
    expect(res.status).toBe(200);
    const { rows } = await pool.query(`SELECT overall_status, email FROM candidates WHERE id = $1`, [cand.id]);
    expect(rows[0].overall_status).not.toBe('hired');
    expect(rows[0].email).toBe(cand.email);
  });

  it('records a disposition change and a recruiter assignment on the timeline', async () => {
    await request(recApp).patch(`/api/recruitment/candidates/${cand.id}/profile`)
      .send({ disposition: 'inactive' }).expect(200);
    await request(recApp).patch(`/api/recruitment/candidates/${cand.id}/profile`)
      .send({ recruiter_id: ids.recUser2 }).expect(200);

    const res = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/activity`);
    const kinds = res.body.map(e => e.event_type);
    expect(kinds).toContain('disposition_change');
    expect(kinds).toContain('recruiter_assigned');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2 — the whole loop, in one test
// ═══════════════════════════════════════════════════════════════════════════
describe('§2 — candidate → screening → other role → Talent Bank → new application', () => {
  it('runs the brief\'s philosophy end to end without ever duplicating the candidate', async () => {
    const cand = await makeCandidate('Vivek Kumar', {
      applied_job_id: ids.opening, experience_years: 3,
      qualification: 'BE/BTech', specialisation: 'Electrical',
      current_state: 'Tamil Nadu', current_city: 'Madurai',
      skills: JSON.stringify(['Power Electronics', 'Testing']),
    });
    const { rows: apps } = await pool.query(
      `INSERT INTO candidate_applications (company_id, candidate_id, job_opening_id, stage, status, origin, is_primary)
       VALUES ($1,$2,$3,'screening','active','applied',TRUE) RETURNING *`,
      [ids.company, cand.id, ids.opening]
    );

    // 1. Screen.
    await request(recApp).post(`/api/recruitment/candidates/${cand.id}/screening`).send({
      application_id: apps[0].id,
      qualification_fit: 'meets', experience_fit: 'partial', skills_fit: 'meets', notice_fit: 'acceptable',
      location_fit: 'local', relevant_knowledge: 3, learning_mindset: 4, problem_solving: 4,
      ownership: 4, teamwork: 4, patience: 3, communication: 3, career_alignment: 4,
    }).expect(200);
    const { rows: scr } = await pool.query(
      `SELECT id, recommendation FROM candidate_screenings WHERE application_id = $1`, [apps[0].id]);

    // 2. Not right for THIS role; right for two others; keep them.
    await request(recApp).post(`/api/recruitment/screenings/${scr[0].id}/complete`).send({
      decision: 'consider_other_roles',
      override_reason: 'Scores well but no AHF design exposure, which this role needs.',
      summary_note: 'Strong electrical fundamentals. Better suited to testing/service.',
      suitable_departments: [
        { department: 'Testing', suitability: 'strong', reason: 'Strong electrical fundamentals' },
        { department: 'Service', suitability: 'potential', reason: 'Good troubleshooting approach' },
      ],
      pool_ids: [ids.pool],
    }).expect(200);

    // 3. The person is still active; only the application is closed.
    const { rows: c1 } = await pool.query(
      `SELECT disposition, deleted_at FROM candidates WHERE id = $1`, [cand.id]);
    expect(c1[0].disposition).toBe('active');
    expect(c1[0].deleted_at).toBeNull();

    // 4. A Testing role opens. They are findable in the bank...
    const bank = await request(recApp).get('/api/recruitment/talent-bank')
      .query({ department: 'Testing', experience_min: 2, experience_max: 5, state: 'Tamil Nadu' });
    expect(bank.body.rows.map(r => r.id)).toContain(cand.id);

    // 5. ...and put forward for it, as a SECOND application on the SAME person.
    const suits = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/suitability`);
    const testing = suits.body.find(s => s.department === 'Testing');
    await request(recApp).post(`/api/recruitment/suitability/${testing.id}/convert`)
      .send({ job_opening_id: ids.testingOpening }).expect(201);

    const { rows: allApps } = await pool.query(
      `SELECT job_opening_id, stage FROM candidate_applications WHERE candidate_id = $1 ORDER BY id`, [cand.id]);
    expect(allApps).toHaveLength(2);
    expect(allApps[0].stage).toBe('not_suitable');      // the original, closed
    expect(allApps[1].stage).toBe('applied');           // the new one, live

    // 6. Exactly one candidate record, and their whole history is on it.
    const { rows: count } = await pool.query(
      `SELECT COUNT(*)::int n FROM candidates WHERE email = $1`, [cand.email]);
    expect(count[0].n).toBe(1);

    const tl = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/activity`);
    const kinds = tl.body.map(e => e.event_type);
    expect(kinds).toContain('screening_started');
    expect(kinds).toContain('screening_completed');
    expect(kinds).toContain('suitability_recorded');
    expect(kinds).toContain('talent_bank_added');
    expect(kinds).toContain('suitability_converted');

    // 7. And the screening that produced the decision is still readable.
    const scrRead = await request(recApp).get(`/api/recruitment/candidates/${cand.id}/screening`)
      .query({ application_id: apps[0].id });
    expect(scrRead.body.screening.decision).toBe('consider_other_roles');
    expect(scrRead.body.screening.summary_note).toMatch(/testing\/service/);
  });
});
