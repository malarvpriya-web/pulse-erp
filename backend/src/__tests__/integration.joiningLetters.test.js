/**
 * Joining letters at onboarding (owner 18 Nov 26), against a real database:
 *   - the offer e-mail carries no letter (approval path builds no PDF)
 *   - HR issues offer / appointment / confidentiality letters; each is filed on
 *     the employee record (the Add/Edit Employee document slots), named after
 *     the employee, and kept in employee_letter_issues
 *   - an offer letter needs an accepted offer; non-HR is refused; other
 *     tenants' employees are not found
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import { FIXTURE_CODE_SQL } from '../shared/employeeCode.js';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool } = await import('../config/db.js');
const { default: onboardingRouter } = await import('../modules/hr/onboarding.routes.js');
const { LOCAL_UPLOAD_DIR } = await import('../services/StorageService.js');

const TAG = 'ZZJLT';
const ids = {};
const written = [];

function appAs(roles, company = () => ids.company) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: ids.user, id: ids.user, roles, role: roles[0], company_id: company() };
    req.scope = { company_id: company() };
    next();
  });
  app.use('/api/onboarding', onboardingRouter);
  return app;
}

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = $1`, [TAG]);
  const c = rows[0]?.id;
  if (c) {
    for (const sql of [
      `DELETE FROM employee_letter_issues WHERE company_id = $1`,
      `DELETE FROM offer_letters WHERE company_id = $1`,
      `DELETE FROM employees WHERE company_id = $1`,
      `DELETE FROM candidates WHERE company_id = $1`,
    ]) await pool.query(sql, [c]).catch(() => {});
    await pool.query(`DELETE FROM companies WHERE id = $1`, [c]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE LOWER(email) LIKE LOWER($1)`, [`${TAG}%`]);
}

beforeAll(async () => {
  await sweep();
  ids.company = (await pool.query(`INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co`, TAG])).rows[0].id;
  ids.user = (await pool.query(`INSERT INTO users (email, role, is_active, name) VALUES ($1, 'hr', true, 'Hema HR') RETURNING id`, [`${TAG}.hr@test.invalid`])).rows[0].id;
  ids.cand = (await pool.query(`INSERT INTO candidates (full_name, email, company_id) VALUES ($1, $2, $3) RETURNING id`,
    [`${TAG} Asha`, `${TAG.toLowerCase()}.asha@test.invalid`, ids.company])).rows[0].id;
  ids.emp = (await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id, designation, department, joining_date,
                            probation_months, probation_end_date, notice_period_days, source_candidate_id)
     VALUES (${FIXTURE_CODE_SQL}, $1, 'Asha', $2, 'Test Engineer', 'Engineering', CURRENT_DATE, 6, CURRENT_DATE + 180, 60, $3) RETURNING id, office_id`,
    [TAG, ids.company, ids.cand])).rows[0];
  await pool.query(
    `INSERT INTO offer_letters (candidate_id, company_id, offer_status, offered_salary, designation, joining_date, offer_no)
     VALUES ($1, $2, 'accepted', 900000, 'Test Engineer', CURRENT_DATE, $3)`, [ids.cand, ids.company, `${TAG}-1`]);
  // Added directly (no recruitment offer).
  ids.direct = (await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id, designation) VALUES (${FIXTURE_CODE_SQL}, $1, 'Bala', $2, 'Fitter') RETURNING id`,
    [TAG, ids.company])).rows[0].id;
});

afterAll(async () => {
  for (const f of written) { try { unlinkSync(join(LOCAL_UPLOAD_DIR, basename(f))); } catch { /* gone */ } }
  await sweep();
});

describe('offer e-mail carries no letter', () => {
  it('the approval path builds no PDF and sends no attachment', () => {
    const src = readFileSync(resolve(here, '../modules/approvals/approvals.controller.js'), 'utf8');
    const offerCase = src.slice(src.indexOf("case 'offer': {"), src.indexOf('default:', src.indexOf("case 'offer': {")));
    expect(offerCase).toContain("triggerEmail('offer_sent'");
    expect(offerCase).not.toMatch(/buildOfferLetterPdf|attachments/);
  });
});

describe('joining letters', () => {
  it('lists the three letters, none on file yet', async () => {
    const res = await request(appAs(['hr'])).get(`/api/onboarding/letters/${ids.emp.id}`);
    expect(res.status).toBe(200);
    expect(res.body.letters.map(l => l.type)).toEqual(['offer', 'appointment', 'confidentiality']);
    expect(res.body.letters.every(l => l.file_url === null && l.can_issue)).toBe(true);
  });

  it('previews a PDF without storing it', async () => {
    const res = await request(appAs(['hr'])).get(`/api/onboarding/letters/${ids.emp.id}/appointment/preview`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    const { rows } = await pool.query(`SELECT appointment_letter_file FROM employees WHERE id = $1`, [ids.emp.id]);
    expect(rows[0].appointment_letter_file).toBeNull();
  });

  it('issues each letter onto the employee record, named after the employee', async () => {
    for (const [type, col] of [['offer', 'offer_letter_file'], ['appointment', 'appointment_letter_file'], ['confidentiality', 'confidentiality_letter_file']]) {
      const res = await request(appAs(['hr'])).post(`/api/onboarding/letters/${ids.emp.id}/${type}`);
      expect(res.status).toBe(201);
      written.push(res.body.file_url);
      expect(res.body.filename).toMatch(new RegExp(`^${ids.emp.office_id}_${TAG}_Asha_`));
      const { rows } = await pool.query(`SELECT ${col} AS f FROM employees WHERE id = $1`, [ids.emp.id]);
      expect(rows[0].f).toBe(res.body.file_url);
    }
    const list = await request(appAs(['hr'])).get(`/api/onboarding/letters/${ids.emp.id}`);
    expect(list.body.letters.every(l => l.source === 'issued' && l.last_issued_by === 'Hema HR')).toBe(true);
  });

  it('re-issue replaces the record copy and keeps the history', async () => {
    const res = await request(appAs(['hr'])).post(`/api/onboarding/letters/${ids.emp.id}/appointment`);
    written.push(res.body.file_url);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM employee_letter_issues WHERE employee_id = $1 AND letter_type = 'appointment'`, [ids.emp.id]);
    expect(rows[0].n).toBe(2);
    const list = await request(appAs(['hr'])).get(`/api/onboarding/letters/${ids.emp.id}`);
    expect(list.body.letters.find(l => l.type === 'appointment').times_issued).toBe(2);
  });

  it('a signed copy uploaded on the record shows as uploaded', async () => {
    await pool.query(`UPDATE employees SET confidentiality_letter_file = '/uploads/signed_scan.pdf' WHERE id = $1`, [ids.emp.id]);
    const list = await request(appAs(['hr'])).get(`/api/onboarding/letters/${ids.emp.id}`);
    expect(list.body.letters.find(l => l.type === 'confidentiality').source).toBe('uploaded');
  });

  it('no offer letter without an accepted offer; appointment still works', async () => {
    const list = await request(appAs(['hr'])).get(`/api/onboarding/letters/${ids.direct}`);
    expect(list.body.letters.find(l => l.type === 'offer')).toMatchObject({ can_issue: false });
    const off = await request(appAs(['hr'])).post(`/api/onboarding/letters/${ids.direct}/offer`);
    expect(off.status).toBe(409);
    expect(off.body.code).toBe('NO_ACCEPTED_OFFER');
    const apt = await request(appAs(['hr'])).post(`/api/onboarding/letters/${ids.direct}/appointment`);
    expect(apt.status).toBe(201);
    written.push(apt.body.file_url);
  });

  it('refuses non-HR, unknown letter types and other companies', async () => {
    expect((await request(appAs(['manager'])).get(`/api/onboarding/letters/${ids.emp.id}`)).status).toBe(403);
    expect((await request(appAs(['manager'])).post(`/api/onboarding/letters/${ids.emp.id}/appointment`)).status).toBe(403);
    expect((await request(appAs(['hr'])).post(`/api/onboarding/letters/${ids.emp.id}/salary`)).status).toBe(400);
    const other = (await pool.query(`SELECT id FROM companies WHERE id <> $1 ORDER BY id LIMIT 1`, [ids.company])).rows[0].id;
    expect((await request(appAs(['hr'], () => other)).get(`/api/onboarding/letters/${ids.emp.id}`)).status).toBe(404);
  });
});
