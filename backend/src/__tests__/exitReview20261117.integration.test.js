/**
 * Exit Management review, 2026-11-17 — real routers against the test database:
 *   - one exit interview per exit (409 INTERVIEW_EXISTS); the overall rating is
 *     required and every rating is 1–5 (400 BAD_RATING); the reason comes from
 *     the EXIT_REASON master (400 BAD_REASON), old keys read as their names
 *   - GET /exit/active: days_remaining is signed (0 = the last day itself)
 *   - GET /exit/fnf/rules says whether the caller may save rules (can_edit)
 *   - the Exit Checklist API is on the exit matrix: HR Executive (exit:view
 *     only) reads it but cannot change it; POST …/complete is gone
 *   - GET /exit/fnf/review/:id/statement: 409 before any settlement, a PDF after
 * Isolated companies; everything is removed in afterAll.
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
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { requireCompanyScope } = await import('../shared/scope.js');
const { default: hrRouter } = await import('../modules/hr/hr.routes.js');
const { default: exitRouter } = await import('../modules/hr/exit.routes.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');

const PREFIX = 'ZZEXREV';
const app = express();
app.use(express.json());
app.use('/api/hr', verifyToken, requireCompanyScope, hrRouter);   // as in server.js
app.use('/api/exit', verifyToken, exitRouter);
const fx = { A: null, hr: null, hrExec: null };
const call = (who, method, path, body) =>
  request(app)[method](path).set('Authorization', `Bearer ${who.token()}`).send(body ?? undefined);

async function cleanupCompany(id) {
  const emps = `SELECT id FROM employees WHERE company_id = $1`;
  const q = (sql) => pool.query(sql, [id]);
  await q(`DELETE FROM audit_logs WHERE company_id = $1`);
  await q(`DELETE FROM hr_offboarding_checklist_progress WHERE employee_id IN (${emps})`);
  await q(`DELETE FROM hr_offboarding_checklist_templates WHERE company_id = $1`);
  await q(`DELETE FROM exit_interviews WHERE employee_id IN (${emps})`);
  await q(`DELETE FROM exit_clearance WHERE employee_id IN (${emps})`);
  await q(`DELETE FROM fnf_settlement_events WHERE settlement_id IN (SELECT id FROM fnf_settlements WHERE employee_id IN (${emps}))`);
  await q(`DELETE FROM fnf_settlements WHERE employee_id IN (${emps})`);
  await q(`DELETE FROM exit_requests WHERE employee_id IN (${emps})`);
  await q(`DELETE FROM employees WHERE company_id = $1`);
  await dropIsolatedCompany(pool, id);
}

let seq = 0;
async function leaver(lwdOffset = 10) {
  seq += 1;
  const emp = (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, joining_date)
     VALUES ($1,$2,'Zz',$3,$4,'Notice','2024-01-01') RETURNING id`,
    [fx.A.companyId, `EMP1117${String(seq).padStart(3, '0')}`, `Exrev${seq}`, `zz.exrev.${fx.A.code.toLowerCase()}.${seq}@example.com`])).rows[0].id;
  const er = (await pool.query(
    `INSERT INTO exit_requests (employee_id, separation_type, last_working_date, status, reason, notice_period)
     VALUES ($1,'resignation',CURRENT_DATE + $2::int,'active','zz',30) RETURNING id`, [emp, lwdOffset])).rows[0].id;
  return { emp, er };
}
const RATINGS = { rating_management: 3, rating_culture: 4, rating_work: 4, rating_growth: 2, overall_rating: 4 };

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) await cleanupCompany(id);
  fx.A = await createIsolatedCompany(pool, `${PREFIX}A`);
  fx.hr = await addUser(pool, fx.A, { label: 'hr', roleCode: 'hr' });
  fx.hrExec = await addUser(pool, fx.A, { label: 'hrexec', roleCode: 'hr_exec' });
});
afterAll(async () => {
  await new Promise(r => setTimeout(r, 400)); // fire-and-forget audit writes
  if (fx.A) await cleanupCompany(fx.A.companyId);
});

describe('exit interview', () => {
  it('records one interview per exit, by reason name', async () => {
    const s = await leaver();
    const ok = await call(fx.A, 'post', '/api/exit/interview', { employee_id: s.emp, reason_category: 'Compensation', would_rejoin: 'no', ...RATINGS });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ exit_request_id: s.er, reason_category: 'Compensation', rating_growth: 2 });
    const again = await call(fx.A, 'post', '/api/exit/interview', { employee_id: s.emp, reason_category: 'Personal', ...RATINGS });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INTERVIEW_EXISTS');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM exit_interviews WHERE exit_request_id = $1`, [s.er]);
    expect(rows[0].n).toBe(1);
  });

  it('an old reason key is stored as its name', async () => {
    const s = await leaver();
    const r = await call(fx.A, 'post', '/api/exit/interview', { employee_id: s.emp, reason_category: 'better_opportunity', overall_rating: 5 });
    expect(r.status).toBe(201);
    expect(r.body.reason_category).toBe('Better Opportunity');
  });

  it.each([
    [{ reason_category: 'Personal' }, 'BAD_RATING'],                                      // no overall rating
    [{ reason_category: 'Personal', overall_rating: 6 }, 'BAD_RATING'],
    [{ reason_category: 'Personal', overall_rating: 4, rating_work: 2.5 }, 'BAD_RATING'],
    [{ reason_category: 'Not a listed reason', overall_rating: 4 }, 'BAD_REASON'],
    [{ overall_rating: 4 }, 'BAD_REASON'],
  ])('%j → 400 %s, nothing stored', async (body, code) => {
    const s = await leaver();
    const r = await call(fx.A, 'post', '/api/exit/interview', { employee_id: s.emp, ...body });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe(code);
    const { rows } = await pool.query(`SELECT interview_done FROM exit_requests WHERE id = $1`, [s.er]);
    expect(rows[0].interview_done).not.toBe(true);
  });
});

describe('GET /exit/active', () => {
  it('days_remaining is signed: 0 on the last day, negative after it', async () => {
    const today = await leaver(0);
    const past = await leaver(-3);
    const rows = (await call(fx.A, 'get', '/api/exit/active')).body;
    expect(Number(rows.find(r => r.id === today.er).days_remaining)).toBe(0);
    expect(Number(rows.find(r => r.id === past.er).days_remaining)).toBe(-3);
  });
});

describe('GET /exit/fnf/rules — can_edit', () => {
  it('admin may save rules, HR may not', async () => {
    expect((await call(fx.A, 'get', '/api/exit/fnf/rules')).body.can_edit).toBe(true);
    const hr = await call(fx.hr, 'get', '/api/exit/fnf/rules');
    expect(hr.status).toBe(200);
    expect(hr.body.can_edit).toBe(false);
  });
});

describe('Exit Checklist API on the exit matrix', () => {
  it('HR Executive (exit:view) reads the checklist but cannot change it', async () => {
    const s = await leaver();
    expect((await call(fx.hrExec, 'get', '/api/hr/offboarding')).status).toBe(200);
    expect((await call(fx.hrExec, 'get', `/api/hr/offboarding/${s.emp}/checklist`)).status).toBe(200);
    expect((await call(fx.hrExec, 'patch', `/api/hr/offboarding/${s.emp}/checklist`, { items: [] })).status).toBe(403);
    expect((await call(fx.hrExec, 'put', '/api/hr/offboarding/templates', { items: [] })).status).toBe(403);
    expect((await call(fx.hr, 'patch', `/api/hr/offboarding/${s.emp}/checklist`, { items: [] })).status).not.toBe(403);
  });

  it('POST /hr/offboarding/:id/complete no longer exists', async () => {
    const s = await leaver();
    expect((await call(fx.A, 'post', `/api/hr/offboarding/${s.emp}/complete`)).status).toBe(404);
  });
});

describe('GET /exit/fnf/review/:id/statement', () => {
  it('409 before a settlement exists; a DRAFT PDF of the latest version after', async () => {
    const s = await leaver();
    const none = await call(fx.A, 'get', `/api/exit/fnf/review/${s.er}/statement`);
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('SETTLEMENT_NOT_COMPUTED');

    await pool.query(
      `INSERT INTO fnf_settlements (exit_request_id, employee_id, company_id, version, separation_type, last_working_date,
          total_payable, total_recoverable, net_payable, lines, warnings, inputs, rules, rules_unconfirmed, computed_by)
       VALUES ($1,$2,$3,1,'resignation',CURRENT_DATE + 10,1000,100,900,$4,'[]','{}','{}','[]',NULL)`,
      [s.er, s.emp, fx.A.companyId, JSON.stringify([
        { code: 'SALARY', label: 'Salary', direction: 'payable', amount: 1000 },
        { code: 'TDS', label: 'TDS on settlement', direction: 'recoverable', amount: 100 },
      ])]);
    const pdf = await request(app).get(`/api/exit/fnf/review/${s.er}/statement`)
      .set('Authorization', `Bearer ${fx.A.token()}`)
      .buffer(true).parse((res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(pdf.headers['content-disposition']).toMatch(/_v1_DRAFT\.pdf/);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    // computed_at is a timestamptz (a Date): it printed "Invalid Date" in the first live run.
    // pdf-parse needs a native canvas binding that does not load on ARM64, so read
    // pdfkit's text directly: inflate each content stream, decode its hex strings.
    const { inflateSync } = await import('node:zlib');
    const raw = pdf.body.toString('latin1');
    let text = '';
    for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      let content;
      try { content = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { continue; }
      for (const tj of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
        text += [...tj[1].matchAll(/<([0-9a-fA-F]+)>/g)].map(h => Buffer.from(h[1], 'hex').toString('latin1')).join('') + '\n';
      }
    }
    expect(text).toMatch(/DRAFT - not yet approved/);
    expect(text).toMatch(/1, computed \d{2} [A-Z][a-z]{2} \d{4}/);
    expect(text).not.toMatch(/Invalid Date/);
  });

  it('another company cannot read it', async () => {
    const s = await leaver();
    const B = await createIsolatedCompany(pool, `${PREFIX}B`);
    try {
      expect((await call(B, 'get', `/api/exit/fnf/review/${s.er}/statement`)).status).toBe(404);
    } finally { await cleanupCompany(B.companyId); }
  });
});
