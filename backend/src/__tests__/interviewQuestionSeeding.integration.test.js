/**
 * Default interview questions — seeded per company on first use, never at
 * module load (2026-10-20, modules/talent/defaultInterviewQuestions.js).
 *
 * The boot seeder gave every ACTIVE company with no questions ten rows each
 * time talent.routes.js was imported. A dev-server restart during an
 * integration run therefore seeded that run's transient test companies, and
 * their FK then blocked the suite's company delete (internConversionWorkflow,
 * 2026-10-19). This pins the replacement:
 *   · importing the router (its DDL block included) seeds nobody;
 *   · the first read of a company's bank — GET /talent/questions or /stats —
 *     gives it exactly the ten defaults, once, even under concurrent reads;
 *   · a company that already has questions (even only inactive ones), an
 *     inactive company, and the global (null-company) view are never seeded.
 *
 * Registry tenants 999948 / 999949; rows removed in afterAll by company id.
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
const { loginUser } = await import('../auth/auth.service.js');
const { syncPrimaryRole } = await import('../services/userRoles.js');
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { ensureDefaultInterviewQuestions, DEFAULT_INTERVIEW_QUESTIONS } =
  await import('../modules/talent/defaultInterviewQuestions.js');

const A = 999948;          // starts with no questions
const B = 999949;          // inactive company, or one with its own questions
const MAIL = 'zz.iqseed.';
const PW = 'Zz-IqSeed-Test-9!';
const fx = { tok: {} };

const count = async (cid, onlyActive = false) => (await pool.query(
  `SELECT COUNT(*)::int n FROM interview_questions WHERE company_id = $1 ${onlyActive ? 'AND is_active' : ''}`, [cid])).rows[0].n;

async function cleanup() {
  const c = [A, B];
  const users = `SELECT id FROM users WHERE email LIKE '${MAIL}%@example.com'`;
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE '${MAIL}%@example.com'`);
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}
async function company(id, code, active = true) {
  await pool.query(`INSERT INTO companies (id, name, code, is_active) VALUES ($1,$2,$3,$4)`, [id, `ZZ IqSeed ${code}`, code, active]);
}
async function login(key, role, cid) {
  const email = `${MAIL}${key}@example.com`;
  const id = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id)
     VALUES ($1,$2,$3,$4,true,$5) RETURNING id`, [`Zz ${key}`, email, await bcrypt.hash(PW, 4), role, cid])).rows[0].id;
  if (cid != null) await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [id, cid]);
  await syncPrimaryRole(id, role, cid);
  fx.tok[key] = (await loginUser(email, PW)).token;
}

let app;
beforeAll(async () => {
  await cleanup();
  await company(A, 'ZZIQA');
  // The companies exist BEFORE the router (and its import-time DDL) loads —
  // the exact situation a dev-server restart mid-run created.
  const talent = await import('../modules/talent/talent.routes.js');
  await talent.talentSchemaReady;
  app = express();
  app.use(express.json());
  app.use('/api/talent', verifyToken, talent.default);
  await login('hrA', 'hr', A);
  await login('super', 'super_admin', null);
}, 60_000);

afterAll(async () => { await cleanup(); });

describe('interview-question default bank', () => {
  it('importing the router seeds no company', async () => {
    expect(await count(A)).toBe(0);
  });

  it('the first read of a company\'s bank gives it exactly the ten defaults', async () => {
    const r = await request(app).get('/api/talent/questions').set({ Authorization: `Bearer ${fx.tok.hrA}` });
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(DEFAULT_INTERVIEW_QUESTIONS.length);
    expect(r.body.data.map(q => q.question).sort())
      .toEqual(DEFAULT_INTERVIEW_QUESTIONS.map(([q]) => q).sort());
    const stats = await request(app).get('/api/talent/questions/stats').set({ Authorization: `Bearer ${fx.tok.hrA}` });
    expect(stats.body.data.total).toBe(10);
  });

  it('repeated reads and repeated calls never add a second set', async () => {
    for (let i = 0; i < 3; i += 1) {
      await request(app).get('/api/talent/questions').set({ Authorization: `Bearer ${fx.tok.hrA}` });
    }
    expect(await ensureDefaultInterviewQuestions(A)).toBe(0);
    expect(await count(A)).toBe(10);
  });

  it('concurrent first reads seed exactly once', async () => {
    await pool.query(`DELETE FROM interview_questions WHERE company_id = $1`, [A]);
    const inserted = await Promise.all([1, 2, 3, 4, 5, 6].map(() => ensureDefaultInterviewQuestions(A)));
    expect(inserted.sort()).toEqual([0, 0, 0, 0, 0, 10]);
    expect(await count(A)).toBe(10);
  });

  it('a bank HR emptied by deactivating every question is not refilled', async () => {
    await pool.query(`UPDATE interview_questions SET is_active = false WHERE company_id = $1`, [A]);
    expect(await ensureDefaultInterviewQuestions(A)).toBe(0);
    expect(await count(A, true)).toBe(0);
    expect(await count(A)).toBe(10);
  });

  it('a company with its own questions is left alone', async () => {
    await company(B, 'ZZIQB');
    await pool.query(`INSERT INTO interview_questions (company_id, question, category, difficulty, is_active)
                      VALUES ($1,'zz our own question','HR','easy',true)`, [B]);
    expect(await ensureDefaultInterviewQuestions(B)).toBe(0);
    expect(await count(B)).toBe(1);
    await pool.query(`DELETE FROM interview_questions WHERE company_id = $1`, [B]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [B]);
  });

  it('an inactive company is not seeded', async () => {
    await company(B, 'ZZIQB', false);
    expect(await ensureDefaultInterviewQuestions(B)).toBe(0);
    expect(await count(B)).toBe(0);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [B]);
  });

  it('the global (null-company) view seeds nothing', async () => {
    expect(await ensureDefaultInterviewQuestions(null)).toBe(0);
    expect(await ensureDefaultInterviewQuestions(undefined)).toBe(0);
    const r = await request(app).get('/api/talent/questions/stats').set({ Authorization: `Bearer ${fx.tok.super}` });
    expect(r.status).toBe(200);
  });
});
