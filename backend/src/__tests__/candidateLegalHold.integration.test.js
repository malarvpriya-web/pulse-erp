/**
 * Candidate legal hold (2026-10-21).
 *
 * A held candidate is never anonymised by the retention job and nothing of
 * theirs is queued for résumé deletion — checked in selection AND under the row
 * lock, so a hold that races the job cannot be bypassed. Only recruitment:approve
 * holders (admin, super_admin, hr_manager) may place / amend / release a hold;
 * every change is in candidate_retention_log (same transaction) and audit_logs.
 *
 * Real recruitment router behind real verifyToken + auditMutations, real logins,
 * real role_permissions, live database. Registry tenants 999992 / 999993; every
 * row is removed in afterAll. Retention runs are company-scoped and use a
 * private temp directory as the upload dir — no real candidate, purge row or
 * uploaded file is ever touched.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

vi.setConfig({ testTimeout: 30_000 });

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
const { auditMutations } = await import('../middlewares/auditMutations.js');
const { default: recruitRouter } = await import('../modules/recruitment/routes/recruitment.routes.js');
const { runCandidateRetention } = await import('../jobs/candidateRetention.cron.js');
const { changeLegalHold } = await import('../modules/recruitment/candidateLegalHold.js');

const A = 999992;
const B = 999993;
const PW = 'Zz-LegalHold-Test-9!';
const MAIL = 'zz.legalhold.';
const RUN = `zzlh_${process.pid}_${Date.now().toString(36)}`;
const DIR = mkdtempSync(join(tmpdir(), 'zz-legal-hold-'));
const fx = { tok: {}, user: {} };

const app = express();
app.use(express.json());
app.use('/api/recruitment', verifyToken, auditMutations('recruitment'), recruitRouter);   // as in server.js
const call = (who, method, path, body) =>
  request(app)[method](`/api/recruitment${path}`).set({ Authorization: `Bearer ${fx.tok[who]}` }).send(body ?? {});

const run = (opts = {}) => runCandidateRetention({ companyId: A, uploadDir: DIR, ...opts });
let seq = 0;
const makeFile = () => { const n = `${RUN}_${++seq}.pdf`; writeFileSync(join(DIR, n), '%PDF zz'); return n; };

async function cleanup() {
  const c = [A, B];
  const users = `SELECT id FROM users WHERE email LIKE '${MAIL}%@example.com'`;
  await pool.query(`DELETE FROM audit_logs WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM access_denials WHERE user_id IN (${users})`).catch(() => {});
  await pool.query(`DELETE FROM candidate_resume_purges WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM candidate_retention_log WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM candidate_applications WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM candidate_stage_history WHERE candidate_id IN (SELECT id FROM candidates WHERE company_id = ANY($1::int[]))`, [c]);
  await pool.query(`DELETE FROM candidates WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM notifications WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE '${MAIL}%@example.com'`);
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM notification_rules WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

async function login(key, role, cid) {
  const email = `${MAIL}${key}@example.com`;
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id)
     VALUES ($1,$2,$3,$4,true,$5) RETURNING id`, [`Zz ${key}`, email, await bcrypt.hash(PW, 4), role, cid])).rows[0].id;
  await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [fx.user[key], cid]);
  await syncPrimaryRole(fx.user[key], role, cid);
  fx.tok[key] = (await loginUser(email, PW)).token;
}

/** A candidate in `cid`. `due` = retention expired and not in an active pipeline. */
async function candidate(cid, { due = true, withdrawn = false, file = null } = {}) {
  seq += 1;
  const { rows: [c] } = await pool.query(
    `INSERT INTO candidates (full_name, email, company_id, overall_status, retain_until,
                             consent_withdrawn_at, resume_file_url, consent_basis)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'consent') RETURNING id`,
    [`Zz Hold ${seq}`, `zz.hold.${RUN}.${seq}@test.invalid`, cid, due ? 'rejected' : 'active',
     due ? '2020-01-01' : '2099-01-01', withdrawn ? new Date() : null, file ? `/uploads/${file}` : null]);
  return c.id;
}

const state = async (id) => (await pool.query(
  `SELECT legal_hold, legal_hold_reason, legal_hold_by, legal_hold_at, anonymised_at, full_name
     FROM candidates WHERE id = $1`, [id])).rows[0];
const queued = async (id) => Number((await pool.query(
  `SELECT COUNT(*) FROM candidate_resume_purges WHERE candidate_id = $1`, [id])).rows[0].count);
const logRows = async (id) => (await pool.query(
  `SELECT action, reason, triggered_by FROM candidate_retention_log WHERE candidate_id = $1 ORDER BY id`, [id])).rows;
async function auditRows(id, action) {
  for (let i = 0; i < 40; i += 1) {
    const { rows } = await pool.query(
      `SELECT * FROM audit_logs WHERE reference_id = $1 AND action_type = $2`, [String(id), action]);
    if (rows.length) return rows;
    await new Promise((r) => { setTimeout(r, 50); });
  }
  return [];
}

beforeAll(async () => {
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ LegalHold A','ZZLHOLDA'), ($2,'ZZ LegalHold B','ZZLHOLDB')`, [A, B]);
  for (const [k, role] of [['hrMgr', 'hr_manager'], ['admin', 'admin'], ['hr', 'hr'], ['hrExec', 'hr_exec'],
                           ['manager', 'manager'], ['deptHead', 'department_head'], ['employee', 'employee']]) {
    await login(k, role, A);
  }
  await login('hrMgrB', 'hr_manager', B);
}, 90_000);

afterAll(async () => { await cleanup(); rmSync(DIR, { recursive: true, force: true }); });

// ── authority ────────────────────────────────────────────────────────────────

describe('who may place, amend or release a hold', () => {
  it.each(['hr', 'hrExec', 'manager', 'deptHead', 'employee'])('%s is refused on all three, and nothing changes', async (who) => {
    const id = await candidate(A);
    await call('hrMgr', 'post', `/candidates/${id}/legal-hold`, { reason: 'Employment tribunal claim ET/2026/41' });
    const before = { s: await state(id), log: await logRows(id) };
    expect((await call(who, 'post', `/candidates/${id}/legal-hold`, { reason: 'trying to place' })).status).toBe(403);
    expect((await call(who, 'put', `/candidates/${id}/legal-hold`, { reason: 'trying to amend' })).status).toBe(403);
    expect((await call(who, 'delete', `/candidates/${id}/legal-hold`, { reason: 'trying to release' })).status).toBe(403);
    expect({ s: await state(id), log: await logRows(id) }).toEqual(before);
  });

  it('another company\'s HR manager gets 404 and changes nothing', async () => {
    const id = await candidate(A);
    for (const m of ['post', 'put', 'delete']) {
      expect((await call('hrMgrB', m, `/candidates/${id}/legal-hold`, { reason: 'cross tenant attempt' })).status).toBe(404);
    }
    expect((await state(id)).legal_hold).toBe(false);
  });

  it('hr_manager and admin may; the change is logged with actor, time and full reason', async () => {
    const id = await candidate(A);
    const reason = 'Litigation hold — counsel instruction 2026-10-21; preserve all application records. '.repeat(3).trim();
    const placed = await call('hrMgr', 'post', `/candidates/${id}/legal-hold`, { reason });
    expect(placed.status).toBe(200);
    expect(placed.body).toMatchObject({ legal_hold: true, legal_hold_reason: reason, legal_hold_by: fx.user.hrMgr });
    expect(placed.body.legal_hold_at).toBeTruthy();

    expect((await call('admin', 'put', `/candidates/${id}/legal-hold`, { reason: 'Scope widened by counsel' })).status).toBe(200);
    expect(await state(id)).toMatchObject({ legal_hold: true, legal_hold_reason: 'Scope widened by counsel', legal_hold_by: fx.user.admin });

    expect((await call('hrMgr', 'delete', `/candidates/${id}/legal-hold`, { reason: 'Matter closed, counsel confirmed' })).status).toBe(200);
    expect(await state(id)).toMatchObject({ legal_hold: false, legal_hold_reason: null, legal_hold_by: null, legal_hold_at: null });

    expect(await logRows(id)).toEqual([
      { action: 'hold_placed',   reason, triggered_by: fx.user.hrMgr },
      { action: 'hold_amended',  reason: 'Scope widened by counsel', triggered_by: fx.user.admin },
      { action: 'hold_released', reason: 'Matter closed, counsel confirmed', triggered_by: fx.user.hrMgr },
    ]);
    const [audit] = await auditRows(id, 'legal_hold_place');
    expect(audit).toMatchObject({ company_id: A, user_id: fx.user.hrMgr, module_name: 'recruitment' });
    expect(audit.old_data_json.legal_hold).toBe(false);
    expect(audit.new_data_json).toMatchObject({ legal_hold: true, reason });
    expect(await auditRows(id, 'legal_hold_amend')).toHaveLength(1);
    expect(await auditRows(id, 'legal_hold_release')).toHaveLength(1);
    // auditMutations stood down: no generic duplicate for the same request.
    const { rows: dupes } = await pool.query(
      `SELECT action_type FROM audit_logs
        WHERE reference_id = $1 AND company_id = $2 AND module_name = 'recruitment'
          AND action_type NOT LIKE 'legal_hold_%'`, [String(id), A]);
    expect(dupes).toEqual([]);
  });

  it('refuses a missing or oversized reason, and actions that do not fit the state', async () => {
    const id = await candidate(A);
    expect((await call('hrMgr', 'post', `/candidates/${id}/legal-hold`, {})).status).toBe(400);
    expect((await call('hrMgr', 'post', `/candidates/${id}/legal-hold`, { reason: 'abc' })).status).toBe(400);
    expect((await call('hrMgr', 'post', `/candidates/${id}/legal-hold`, { reason: 'x'.repeat(501) })).status).toBe(400);
    expect((await call('hrMgr', 'put', `/candidates/${id}/legal-hold`, { reason: 'amend unheld' })).status).toBe(409);
    expect((await call('hrMgr', 'delete', `/candidates/${id}/legal-hold`, { reason: 'release unheld' })).status).toBe(409);
    expect((await call('hrMgr', 'post', `/candidates/${id}/legal-hold`, { reason: 'first placement' })).status).toBe(200);
    expect((await call('hrMgr', 'post', `/candidates/${id}/legal-hold`, { reason: 'second placement' })).status).toBe(409);
    expect((await call('hrMgr', 'post', '/candidates/abc/legal-hold', { reason: 'bad id here' })).status).toBe(400);
    expect(await logRows(id)).toHaveLength(1);
  });
});

// ── the retention job ────────────────────────────────────────────────────────

describe('retention respects the hold', () => {
  it('a held candidate — expired OR withdrawn — is not anonymised, nothing is queued, the file stays; skips are counted', async () => {
    const f1 = makeFile();
    const f2 = makeFile();
    const expired = await candidate(A, { file: f1 });
    const withdrawn = await candidate(A, { withdrawn: true, file: f2 });
    for (const id of [expired, withdrawn]) {
      expect((await call('hrMgr', 'post', `/candidates/${id}/legal-hold`, { reason: 'Regulator enquiry REF-77' })).status).toBe(200);
    }
    const res = await run();
    expect(res.held_skipped).toBeGreaterThanOrEqual(2);
    for (const id of [expired, withdrawn]) {
      const s = await state(id);
      expect(s.anonymised_at).toBeNull();
      expect(s.full_name).toMatch(/^Zz Hold/);
      expect(await queued(id)).toBe(0);
    }
    expect(existsSync(join(DIR, f1)) && existsSync(join(DIR, f2))).toBe(true);
  });

  it('after release, the next run anonymises and purges as usual', async () => {
    const f = makeFile();
    const id = await candidate(A, { file: f });
    await call('hrMgr', 'post', `/candidates/${id}/legal-hold`, { reason: 'Hold pending review' });
    await run();
    expect((await state(id)).anonymised_at).toBeNull();
    await call('hrMgr', 'delete', `/candidates/${id}/legal-hold`, { reason: 'Review complete, released' });
    const res = await run();
    expect(res.anonymised).toBeGreaterThanOrEqual(1);
    expect((await state(id)).anonymised_at).toBeTruthy();
    expect(existsSync(join(DIR, f))).toBe(false);
    expect((await logRows(id)).map((r) => r.action)).toEqual(['hold_placed', 'hold_released', 'anonymised']);
  });

  it('an anonymised candidate cannot be held (nothing left) — 409', async () => {
    const id = await candidate(A);
    await run();
    expect((await state(id)).anonymised_at).toBeTruthy();
    expect((await call('hrMgr', 'post', `/candidates/${id}/legal-hold`, { reason: 'Too late to hold' })).status).toBe(409);
  });

  it('a queued purge row for a held candidate is left pending and counted, never processed', async () => {
    const f = makeFile();
    const id = await candidate(A, { due: false });
    await call('hrMgr', 'post', `/candidates/${id}/legal-hold`, { reason: 'Defensive purge check' });
    // Only reachable by direct database edits; the purge must still refuse it.
    await pool.query(`INSERT INTO candidate_resume_purges (company_id, candidate_id, file_ref) VALUES ($1, $2, $3)`,
      [A, id, `/uploads/${f}`]);
    const res = await run();
    expect(res.files.held).toBeGreaterThanOrEqual(1);
    expect((await pool.query(`SELECT status, attempts FROM candidate_resume_purges WHERE candidate_id = $1`, [id])).rows)
      .toEqual([{ status: 'pending', attempts: 0 }]);
    expect(existsSync(join(DIR, f))).toBe(true);
  });
});

// ── concurrency ──────────────────────────────────────────────────────────────

describe('a hold that races the job cannot be bypassed', () => {
  it('a hold committed while the job waits on the row lock wins: no anonymisation, nothing queued', async () => {
    const f = makeFile();
    const id = await candidate(A, { file: f });
    const holder = await pool.connect();
    let result;
    try {
      // The hold transaction locks the row first and is still open when the job
      // selects the candidate (not yet held) and tries to lock it.
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM candidates WHERE id = $1 FOR UPDATE', [id]);
      await holder.query(
        `UPDATE candidates SET legal_hold = true, legal_hold_reason = 'race', legal_hold_at = NOW() WHERE id = $1`, [id]);
      const pending = run();
      await new Promise((r) => { setTimeout(r, 400); });   // the job is now blocked on our lock
      await holder.query('COMMIT');
      result = await pending;
    } finally {
      holder.release();
    }
    expect(result.held_skipped).toBeGreaterThanOrEqual(1);
    expect((await state(id)).anonymised_at).toBeNull();
    expect(await queued(id)).toBe(0);
    expect(existsSync(join(DIR, f))).toBe(true);
  });

  it('placing a hold and running the job at the same time always ends in exactly one consistent outcome', async () => {
    for (let i = 0; i < 6; i += 1) {
      const id = await candidate(A, { file: makeFile() });
      const [hold] = await Promise.allSettled([
        changeLegalHold({ action: 'place', candidateId: id, companyId: A, userId: fx.user.hrMgr, reason: `race round ${i}` }),
        run(),
      ]);
      const s = await state(id);
      if (hold.status === 'fulfilled') {
        // The hold won: untouched, nothing queued.
        expect(s.legal_hold).toBe(true);
        expect(s.anonymised_at).toBeNull();
        expect(await queued(id)).toBe(0);
      } else {
        // The job won: the hold was refused because the record was already anonymised.
        expect(hold.reason.status).toBe(409);
        expect(s.legal_hold).toBe(false);
        expect(s.anonymised_at).toBeTruthy();
      }
    }
  });
});

describe('privacy summary', () => {
  it('reports held records and leaves them out of "due for purge"', async () => {
    const res = await call('hrMgr', 'get', '/privacy/summary');
    expect(res.status).toBe(200);
    const { rows: [want] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE legal_hold AND anonymised_at IS NULL)::int AS held,
              COUNT(*) FILTER (WHERE retain_until < CURRENT_DATE AND anonymised_at IS NULL AND NOT legal_hold
                               AND COALESCE(overall_status,'') NOT IN ('active','hired'))::int AS due
         FROM candidates WHERE company_id = $1 AND deleted_at IS NULL`, [A]);
    expect(res.body.summary.on_legal_hold).toBe(want.held);
    expect(res.body.summary.due_for_purge).toBe(want.due);
    expect(want.held).toBeGreaterThan(0);
  });
});
