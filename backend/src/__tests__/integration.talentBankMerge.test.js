/**
 * integration.talentBankMerge.test.js — 2026-11-17 Talent Bank merge.
 *
 * "Talent Pools" (Sourcing tab) and the Talent Bank's categories were the same
 * table on two screens with two add-member paths. Merged into the Talent Bank;
 * this suite pins the behaviour that came with it, through the REAL routers
 * against the REAL database:
 *
 *   · categories: group (category) stored, duplicate names refused, partial
 *     update keeps other fields, standard categories switch off instead of
 *     deleting (they used to come straight back), in-use ones refuse
 *   · search: Skills matches candidate skills OR banking tags, every term;
 *     bank_size ignores filters
 *   · remove from one category / from the whole bank
 *   · putting a banked candidate forward brings them back into hiring
 *   · bulk "add to Talent Bank" parks the stage like the single path
 *   · the old /talent/pools/:id/members routes are gone
 *
 * Self-cleaning (swept in and out). Does NOT call pool.end().
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
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }          = await import('../config/db.js');
const { default: recruitRouter } = await import('../modules/recruitment/routes/recruitment.routes.js');
const { default: ciRouter }      = await import('../modules/recruitment/routes/candidateIntelligence.routes.js');
const { default: talentRouter }  = await import('../modules/talent/talent.routes.js');
const { _clearActorNameCache }   = await import('../modules/recruitment/actorName.js');

const TAG = 'ZZTBM';
const ids = { company: null, employee: null, role: null, user: null, openA: null, openB: null };
let app;

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = $1`, [TAG]);
  const companyId = rows[0]?.id;
  if (companyId) {
    const cands = `(SELECT id FROM candidates WHERE company_id = ${Number(companyId)})`;
    await pool.query(`DELETE FROM candidate_activity WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM candidate_recontact WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM candidate_role_suitability WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM talent_pool_members WHERE pool_id IN (SELECT id FROM talent_pools WHERE company_id = $1)`, [companyId]);
    await pool.query(`DELETE FROM talent_pools WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM candidate_applications WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM candidate_stage_history WHERE candidate_id IN ${cands}`);
    await pool.query(`DELETE FROM candidates WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM job_openings WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM employees WHERE company_id = $1`, [companyId]);
  }
  await pool.query(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE LOWER(email) LIKE LOWER($1))`, [`${TAG}%`]);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE LOWER(email) LIKE LOWER($1))`, [`${TAG}%`]);
  await pool.query(`DELETE FROM users WHERE LOWER(email) LIKE LOWER($1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code LIKE $1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM roles WHERE code LIKE $1`, [`${TAG}%`]);
  if (companyId) await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
}

async function makeCandidate(name, extra = {}) {
  const cols = {
    company_id: ids.company, full_name: `${TAG} ${name}`,
    email: `${TAG}.${name.replace(/\s+/g, '').toLowerCase()}@test.invalid`,
    source: 'naukri', current_stage: 'applied', overall_status: 'active',
    disposition: 'new', last_activity_at: new Date().toISOString(),
    ...extra,
  };
  const keys = Object.keys(cols);
  const { rows } = await pool.query(
    `INSERT INTO candidates (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    keys.map(k => (k === 'skills' ? JSON.stringify(cols[k]) : cols[k]))
  );
  return rows[0];
}

async function makePool(name, { seeded = false, category = 'engineering' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO talent_pools (company_id, pool_name, category, is_active, is_seeded)
     VALUES ($1, $2, $3, true, $4) RETURNING id`,
    [ids.company, name, category, seeded]
  );
  return rows[0].id;
}

const bank = (q = {}) => request(app).get('/api/recruitment/talent-bank').query(q);

beforeAll(async () => {
  await sweep();
  _clearActorNameCache();
  const { rows: co } = await pool.query(`INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co`, TAG]);
  ids.company = co[0].id;
  const { rows: emp } = await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id) VALUES (${FIXTURE_CODE_SQL}, $1, 'Tester', $2) RETURNING id`,
    [TAG, ids.company]
  );
  ids.employee = emp[0].id;
  const { rows: role } = await pool.query(
    `INSERT INTO roles (role_name, code, is_active) VALUES ($1, $2, true) RETURNING id`, [`${TAG} rec`, `${TAG}_REC`]
  );
  ids.role = role[0].id;
  await pool.query(
    `INSERT INTO role_permissions (role_id, module, can_view, can_add, can_edit, can_delete, can_export)
     VALUES ($1, 'recruitment', true, true, true, true, true)`, [ids.role]
  );
  const { rows: u } = await pool.query(
    `INSERT INTO users (email, role, is_active, company_id) VALUES ($1, 'employee', true, $2) RETURNING id`,
    [`${TAG}.rec@test.invalid`, ids.company]
  );
  ids.user = u[0].id;
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [ids.user, ids.role]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId: ids.user, id: ids.user, roles: [`${TAG}_rec`], role: `${TAG}_rec`, company_id: ids.company, employee_id: ids.employee, email: `${TAG}.rec@test.invalid` };
    req.scope = { company_id: ids.company };
    next();
  });
  app.use('/api/recruitment', ciRouter);
  app.use('/api/recruitment', recruitRouter);
  app.use('/api/talent', talentRouter);

  const mk = async (title) => (await pool.query(
    `INSERT INTO job_openings (job_title, department, company_id, status, posted_date)
     VALUES ($1, 'Engineering', $2, 'open', CURRENT_DATE) RETURNING id`, [title, ids.company])).rows[0].id;
  ids.openA = await mk(`${TAG} Old Role`);
  ids.openB = await mk(`${TAG} New Role`);
}, 60000);

afterAll(async () => { await sweep(); });

describe('categories', () => {
  it('stores the group, refuses a duplicate name, and a partial update keeps the rest', async () => {
    const created = await request(app).post('/api/talent/pools')
      .send({ pool_name: `${TAG} Battery`, category: 'product', department: 'R&D', description: 'Cells and BMS' });
    expect(created.status).toBe(201);
    expect(created.body.data.category).toBe('product');
    expect(created.body.data.is_seeded).toBe(false);

    const dup = await request(app).post('/api/talent/pools').send({ pool_name: `${TAG} battery` });
    expect(dup.status).toBe(409);

    const off = await request(app).put(`/api/talent/pools/${created.body.data.id}`).send({ is_active: false });
    expect(off.status).toBe(200);
    expect(off.body.data.is_active).toBe(false);
    expect(off.body.data.department).toBe('R&D');
    expect(off.body.data.description).toBe('Cells and BMS');
    expect(off.body.data.category).toBe('product');

    // An unknown group falls back to 'other' rather than being stored as typed.
    const odd = await request(app).post('/api/talent/pools').send({ pool_name: `${TAG} Odd`, category: 'whatever' });
    expect(odd.body.data.category).toBe('other');
  });

  it('switches a standard category off instead of deleting it, and it does not come back', async () => {
    // Seeds the standard set for this company (what opening the page does).
    await bank();
    const { rows: [statcom] } = await pool.query(
      `SELECT id FROM talent_pools WHERE company_id = $1 AND pool_name = 'STATCOM'`, [ids.company]);
    expect(statcom).toBeTruthy();

    const del = await request(app).delete(`/api/talent/pools/${statcom.id}`);
    expect(del.status).toBe(200);
    expect(del.body.deactivated).toBe(true);

    await bank();  // would re-create a hard-deleted standard category
    const { rows } = await pool.query(
      `SELECT id, is_active FROM talent_pools WHERE company_id = $1 AND pool_name = 'STATCOM'`, [ids.company]);
    expect(rows).toEqual([{ id: statcom.id, is_active: false }]);

    const list = await request(app).get('/api/recruitment/talent-bank/pools');
    expect(list.body.map(p => p.id)).not.toContain(statcom.id);
  });

  it('refuses to delete a category someone is kept under, and deletes an empty custom one', async () => {
    const used = await makePool(`${TAG} Used`);
    const c = await makeCandidate('Kept Person');
    await request(app).post(`/api/recruitment/candidates/${c.id}/talent-bank`).send({ pool_ids: [used] });
    expect((await request(app).delete(`/api/talent/pools/${used}`)).status).toBe(409);

    const empty = await makePool(`${TAG} Empty`);
    expect((await request(app).delete(`/api/talent/pools/${empty}`)).status).toBe(200);
    const { rows } = await pool.query(`SELECT 1 FROM talent_pools WHERE id = $1`, [empty]);
    expect(rows.length).toBe(0);
  });

  it('no longer serves the old member routes that skipped status and history', async () => {
    const p = await makePool(`${TAG} Legacy`);
    expect((await request(app).get(`/api/talent/pools/${p}/members`)).status).toBe(404);
    expect((await request(app).post(`/api/talent/pools/${p}/members`).send({ candidate_id: 1 })).status).toBe(404);
  });
});

describe('search', () => {
  let poolId, withSkill, withTag;
  beforeAll(async () => {
    poolId = await makePool(`${TAG} Search`);
    withSkill = await makeCandidate('Skill Holder', { skills: ['Power electronics', 'Troubleshooting'] });
    withTag = await makeCandidate('Tag Holder', { skills: [] });
    await request(app).post(`/api/recruitment/candidates/${withSkill.id}/talent-bank`).send({ pool_ids: [poolId] });
    await request(app).post(`/api/recruitment/candidates/${withTag.id}/talent-bank`).send({ pool_ids: [poolId], tags: ['STATCOM'] });
  });

  it('Skills matches a candidate skill (the page used to search tags only)', async () => {
    const res = await bank({ skills: 'power electronics' });
    expect(res.body.rows.map(r => r.id)).toEqual([withSkill.id]);
  });

  it('Skills also matches a banking tag, and needs every term', async () => {
    expect((await bank({ skills: 'statcom' })).body.rows.map(r => r.id)).toEqual([withTag.id]);
    expect((await bank({ skills: 'power electronics, statcom' })).body.rows).toEqual([]);
  });

  it('returns category ids and tags on each row, and bank_size ignores filters', async () => {
    const res = await bank({ skills: 'statcom' });
    expect(res.body.rows[0].pool_list).toEqual([{ id: poolId, name: `${TAG} Search` }]);
    expect(res.body.rows[0].bank_tags).toEqual(['STATCOM']);
    const all = await bank();
    expect(res.body.bank_size).toBe(all.body.total);
    expect(res.body.total).toBe(1);
  });
});

describe('remove from the Talent Bank', () => {
  it('removes one category only; the candidate stays in the bank', async () => {
    const a = await makePool(`${TAG} RmA`);
    const b = await makePool(`${TAG} RmB`);
    const c = await makeCandidate('Two Pools');
    await request(app).post(`/api/recruitment/candidates/${c.id}/talent-bank`).send({ pool_ids: [a, b] });

    const res = await request(app).delete(`/api/recruitment/candidates/${c.id}/talent-bank`).query({ pool_id: a });
    expect(res.status).toBe(200);
    const { rows } = await pool.query(`SELECT pool_id FROM talent_pool_members WHERE candidate_id = $1`, [c.id]);
    expect(rows.map(r => r.pool_id)).toEqual([b]);
    expect((await bank({ search: 'Two Pools' })).body.rows.map(r => r.id)).toEqual([c.id]);

    expect((await request(app).delete(`/api/recruitment/candidates/${c.id}/talent-bank`).query({ pool_id: a })).status).toBe(404);
  });

  it('removes from the whole bank: categories gone, reminder cancelled, status inactive, nothing deleted', async () => {
    const p = await makePool(`${TAG} RmAll`);
    const c = await makeCandidate('Leaving Bank');
    await request(app).post(`/api/recruitment/candidates/${c.id}/talent-bank`).send({ pool_ids: [p] });
    await pool.query(
      `INSERT INTO candidate_recontact (company_id, candidate_id, recontact_on, status) VALUES ($1, $2, CURRENT_DATE + 30, 'pending')`,
      [ids.company, c.id]);

    const res = await request(app).delete(`/api/recruitment/candidates/${c.id}/talent-bank`).send({ reason: 'Joined elsewhere' });
    expect(res.status).toBe(200);
    expect(res.body.whole_bank).toBe(true);

    const { rows: [after] } = await pool.query(`SELECT disposition, deleted_at FROM candidates WHERE id = $1`, [c.id]);
    expect(after).toEqual({ disposition: 'inactive', deleted_at: null });
    const { rows: rc } = await pool.query(`SELECT status FROM candidate_recontact WHERE candidate_id = $1`, [c.id]);
    expect(rc.map(r => r.status)).toEqual(['cancelled']);
    expect((await bank({ search: 'Leaving Bank' })).body.rows).toEqual([]);
    const { rows: act } = await pool.query(
      `SELECT 1 FROM candidate_activity WHERE candidate_id = $1 AND event_type = 'talent_bank_removed'`, [c.id]);
    expect(act.length).toBe(1);
  });
});

describe('put forward from the Talent Bank', () => {
  it('brings a banked candidate back into hiring on the new job', async () => {
    const c = await makeCandidate('Came Back', {
      disposition: 'future_opportunity', current_stage: 'future_use', applied_job_id: ids.openA,
    });
    const { rows: [oldApp] } = await pool.query(
      `INSERT INTO candidate_applications (company_id, candidate_id, job_opening_id, stage, status, origin, is_primary)
       VALUES ($1, $2, $3, 'future_use', 'active', 'applied', true) RETURNING id`,
      [ids.company, c.id, ids.openA]);
    await pool.query(
      `INSERT INTO candidate_recontact (company_id, candidate_id, recontact_on, status) VALUES ($1, $2, CURRENT_DATE, 'pending')`,
      [ids.company, c.id]);

    const res = await request(app).post(`/api/recruitment/candidates/${c.id}/recommend`).send({ job_opening_ids: [ids.openB] });
    expect(res.status).toBe(201);
    expect(res.body.brought_back).toBe(true);

    const { rows: [cand] } = await pool.query(
      `SELECT disposition, current_stage, applied_job_id FROM candidates WHERE id = $1`, [c.id]);
    expect(cand).toEqual({ disposition: 'active', current_stage: 'applied', applied_job_id: ids.openB });
    const { rows: apps } = await pool.query(
      `SELECT id, job_opening_id, is_primary FROM candidate_applications WHERE candidate_id = $1 ORDER BY id`, [c.id]);
    expect(apps.find(a => a.id === oldApp.id).is_primary).toBe(false);
    expect(apps.find(a => a.job_opening_id === ids.openB).is_primary).toBe(true);
    const { rows: rc } = await pool.query(`SELECT status, outcome_note FROM candidate_recontact WHERE candidate_id = $1`, [c.id]);
    expect(rc[0].status).toBe('done');
    expect(rc[0].outcome_note).toContain('New Role');
  });

  it('leaves an active candidate\'s main application alone', async () => {
    const c = await makeCandidate('Still Active', { current_stage: 'screening', applied_job_id: ids.openA });
    await pool.query(
      `INSERT INTO candidate_applications (company_id, candidate_id, job_opening_id, stage, status, origin, is_primary)
       VALUES ($1, $2, $3, 'screening', 'active', 'applied', true)`, [ids.company, c.id, ids.openA]);
    const res = await request(app).post(`/api/recruitment/candidates/${c.id}/recommend`).send({ job_opening_ids: [ids.openB] });
    expect(res.status).toBe(201);
    expect(res.body.brought_back).toBe(false);
    const { rows: [cand] } = await pool.query(`SELECT current_stage, applied_job_id FROM candidates WHERE id = $1`, [c.id]);
    expect(cand).toEqual({ current_stage: 'screening', applied_job_id: ids.openA });
  });
});

describe('bulk add to the Talent Bank', () => {
  it('parks the stage the way the single-candidate path does', async () => {
    const p = await makePool(`${TAG} Bulk`);
    const c = await makeCandidate('Bulk Kept', { current_stage: 'applied' });
    await pool.query(
      `INSERT INTO candidate_applications (company_id, candidate_id, job_opening_id, stage, status, origin, is_primary)
       VALUES ($1, $2, $3, 'applied', 'active', 'applied', true)`, [ids.company, c.id, ids.openA]);
    const res = await request(app).post('/api/recruitment/candidates/bulk-action')
      .send({ candidate_ids: [c.id], action: 'talent_bank', value: [p] });
    expect(res.status).toBe(200);
    const { rows: [cand] } = await pool.query(`SELECT disposition, current_stage FROM candidates WHERE id = $1`, [c.id]);
    expect(cand).toEqual({ disposition: 'talent_bank', current_stage: 'future_use' });
    const { rows: [a] } = await pool.query(`SELECT stage FROM candidate_applications WHERE candidate_id = $1 AND is_primary`, [c.id]);
    expect(a.stage).toBe('future_use');
  });
});
