/**
 * Candidate retention — the résumé FILE of an anonymised candidate (2026-10-21).
 *
 * The job nulled resume_file_url and left the file in uploads/ ("the storage
 * sweep" it relied on never existed). It now queues each stored reference in the
 * anonymising transaction and, after commit, deletes a file only when nothing
 * else references it — verified here for: exclusive ownership, a file shared
 * with another candidate or an employee, the last sharer leaving, a missing
 * file, a failed or ineffective unlink and its retry, unsafe paths, external
 * references, and re-runs.
 *
 * Isolation: every run is scoped to registry tenant 999990 (`companyId`), so no
 * real candidate is ever due here; a due candidate in 999991 proves the scope.
 * Files live in a private temp directory passed as `uploadDir` — the real
 * uploads/ is never read or written by this suite.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Each retention run scans every text column of every table for the queued file
// names (that is the point); a test makes several runs.
vi.setConfig({ testTimeout: 30_000 });
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { runCandidateRetention } = await import('../jobs/candidateRetention.cron.js');
const { classifyRef, MAX_ATTEMPTS } = await import('../jobs/candidateResumePurge.js');

const A = 999990;
const B = 999991;
const RUN = `zzrp_${process.pid}_${Date.now().toString(36)}`;
const DIR = mkdtempSync(join(tmpdir(), 'zz-resume-purge-'));
const OUTSIDE = join(DIR, '..', `${RUN}_outside_sentinel.txt`);   // must survive every run
let seq = 0;

const fileName = () => `${RUN}_${++seq}.pdf`;
const makeFile = (name) => { writeFileSync(join(DIR, name), '%PDF-1.4 zz'); return `/uploads/${name}`; };
const onDisk = (name) => existsSync(join(DIR, name));
const run = (opts = {}) => runCandidateRetention({ companyId: A, uploadDir: DIR, ...opts });

async function candidate(cid, { url = null, resumeUrl = null, gdrive = null, due = true } = {}) {
  seq += 1;
  const { rows: [c] } = await pool.query(
    `INSERT INTO candidates (full_name, email, company_id, overall_status, retain_until,
                             resume_file_url, resume_url, resume_gdrive_file_id, consent_basis)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'consent') RETURNING id`,
    [`Zz Purge ${seq}`, `zz.purge.${RUN}.${seq}@test.invalid`, cid,
     due ? 'rejected' : 'active', due ? '2020-01-01' : '2099-01-01', url, resumeUrl, gdrive]);
  return c.id;
}

const ledger = async (candId) => (await pool.query(
  `SELECT file_ref, status, attempts, last_error, referenced_by FROM candidate_resume_purges
    WHERE candidate_id = $1 ORDER BY id`, [candId])).rows;
const logActions = async (candId) => (await pool.query(
  `SELECT action FROM candidate_retention_log WHERE candidate_id = $1 ORDER BY id`, [candId])).rows.map(r => r.action);
const anonymisedAt = async (candId) => (await pool.query(
  `SELECT anonymised_at, resume_file_url FROM candidates WHERE id = $1`, [candId])).rows[0];

async function cleanup() {
  const c = [A, B];
  await pool.query(`DELETE FROM candidate_resume_purges WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM candidate_retention_log WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM candidate_applications WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM candidate_stage_history WHERE candidate_id IN (SELECT id FROM candidates WHERE company_id = ANY($1::int[]))`, [c]);
  await pool.query(`DELETE FROM candidates WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM notification_rules WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

beforeAll(async () => {
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ ResumePurge A','ZZRPURGEA'), ($2,'ZZ ResumePurge B','ZZRPURGEB')`, [A, B]);
  writeFileSync(OUTSIDE, 'must never be deleted');
}, 60_000);

afterAll(async () => {
  await cleanup();
  rmSync(DIR, { recursive: true, force: true });
  rmSync(OUTSIDE, { force: true });
});

describe('reference classification (path safety)', () => {
  it('accepts only a plain file name directly inside uploads/', () => {
    expect(classifyRef('/uploads/1792_cv.pdf', DIR)).toEqual({ kind: 'local', name: '1792_cv.pdf' });
    for (const bad of ['/uploads/../.env', '/uploads/a/b.pdf', '/uploads/%2e%2e%2f.env', '/uploads/..',
                       '/uploads/.hidden', '/etc/passwd', 'C:\\Windows\\win.ini', '', '/uploads/a%00.pdf']) {
      expect(classifyRef(bad, DIR).kind, bad).toBe('unsafe');
    }
    expect(classifyRef('https://bucket.s3.amazonaws.com/1_cv.pdf', DIR).kind).toBe('external');
    expect(classifyRef('gdrive:1AbC', DIR).kind).toBe('external');
  });
});

describe('exclusive ownership', () => {
  it('anonymises, deletes the file, confirms it gone, and logs it', async () => {
    const name = fileName();
    const id = await candidate(A, { url: makeFile(name) });
    const res = await run();
    expect(res.anonymised).toBeGreaterThanOrEqual(1);
    expect(res.files.deleted).toBeGreaterThanOrEqual(1);
    expect(onDisk(name)).toBe(false);
    const c = await anonymisedAt(id);
    expect(c.anonymised_at).toBeTruthy();
    expect(c.resume_file_url).toBeNull();
    expect(await ledger(id)).toMatchObject([{ file_ref: `/uploads/${name}`, status: 'deleted', attempts: 1 }]);
    // The retention log records the anonymisation once; the file's evidence is its ledger row.
    expect(await logActions(id)).toEqual(['anonymised']);
  });

  it('the same file in resume_file_url and resume_url is queued once', async () => {
    const name = fileName();
    const url = makeFile(name);
    const id = await candidate(A, { url, resumeUrl: url });
    await run();
    expect(await ledger(id)).toHaveLength(1);
    expect(onDisk(name)).toBe(false);
  });
});

describe('shared references are preserved', () => {
  it('a file another (active) candidate still uses is kept, with where it was found', async () => {
    const name = fileName();
    const url = makeFile(name);
    const due = await candidate(A, { url });
    const other = await candidate(A, { url, due: false });
    await run();
    expect(onDisk(name)).toBe(true);
    const [row] = await ledger(due);
    expect(row.status).toBe('retained_shared');
    expect(row.referenced_by).toContain('candidates.resume_file_url');
    expect((await anonymisedAt(other)).anonymised_at).toBeNull();
    expect(await logActions(due)).toEqual(['anonymised']);
  });

  it('a file carried into an employee record is kept', async () => {
    const name = fileName();
    const url = makeFile(name);
    const due = await candidate(A, { url });
    await pool.query(
      `INSERT INTO employees (company_id, office_id, first_name, last_name, status, resume_file)
       VALUES ($1, $2, 'Zz', 'Hired', 'Active', $3)`, [A, `EMP990${seq}`, url]);
    await run();
    expect(onDisk(name)).toBe(true);
    expect((await ledger(due))[0]).toMatchObject({ status: 'retained_shared' });
    expect((await ledger(due))[0].referenced_by).toContain('employees.resume_file');
  });

  it('when every sharer is anonymised, the file goes — exactly once', async () => {
    const name = fileName();
    const url = makeFile(name);
    const one = await candidate(A, { url });
    const two = await candidate(A, { url });
    await run();
    expect(onDisk(name)).toBe(false);
    const statuses = [...await ledger(one), ...await ledger(two)].map(r => r.status).sort();
    expect(statuses).toEqual(['already_absent', 'deleted']);
  });
});

describe('missing, unsafe and external references', () => {
  it('a missing file is recorded as already absent, not as a failure', async () => {
    const name = fileName();                       // never written
    const id = await candidate(A, { url: `/uploads/${name}` });
    const res = await run();
    expect(res.files.failed).toBe(0);
    expect(await ledger(id)).toMatchObject([{ status: 'already_absent' }]);
    expect(await logActions(id)).toEqual(['anonymised']);
  });

  it('a traversal reference is never followed — the file outside is untouched', async () => {
    const id = await candidate(A, { url: `/uploads/../${RUN}_outside_sentinel.txt` });
    await run();
    expect(existsSync(OUTSIDE)).toBe(true);
    expect(await ledger(id)).toMatchObject([{ status: 'unsafe_path' }]);
    expect((await anonymisedAt(id)).anonymised_at).toBeTruthy();   // anonymisation still happens
  });

  it('a directory with the file\'s name is not removed', async () => {
    const name = fileName();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(DIR, name));
    const id = await candidate(A, { url: `/uploads/${name}` });
    await run();
    expect(existsSync(join(DIR, name))).toBe(true);
    expect(await ledger(id)).toMatchObject([{ status: 'unsafe_path' }]);
  });

  it('S3 URLs and Google Drive ids are recorded, not deleted', async () => {
    const id = await candidate(A, { url: 'https://bucket.s3.amazonaws.com/1_cv.pdf', gdrive: 'ZzDriveId' });
    await run();
    const rows = await ledger(id);
    expect(rows.map(r => r.file_ref).sort()).toEqual(['gdrive:ZzDriveId', 'https://bucket.s3.amazonaws.com/1_cv.pdf']);
    expect(rows.every(r => r.status === 'skipped_external')).toBe(true);
  });
});

describe('failure and retry', () => {
  it('a failed unlink is reported as failed (file still there), then retried and completed', async () => {
    const name = fileName();
    const id = await candidate(A, { url: makeFile(name) });
    const eperm = async () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
    const first = await run({ unlink: eperm });
    expect(first.files.failed).toBeGreaterThanOrEqual(1);
    expect(first.files.deleted).toBe(0);
    expect(onDisk(name)).toBe(true);
    expect(await ledger(id)).toMatchObject([{ status: 'failed', attempts: 1 }]);
    expect((await ledger(id))[0].last_error).toMatch(/^EPERM/);

    const second = await run();                       // the next nightly run is the retry
    expect(second.anonymised).toBe(0);                 // the candidate is not anonymised twice
    expect(onDisk(name)).toBe(false);
    expect(await ledger(id)).toMatchObject([{ status: 'deleted', attempts: 2 }]);
    expect(await logActions(id)).toEqual(['anonymised']);   // once, not per retry
  });

  it('an unlink that "succeeds" but leaves the file is still a failure', async () => {
    const name = fileName();
    const id = await candidate(A, { url: makeFile(name) });
    const res = await run({ unlink: async () => {} });
    expect(onDisk(name)).toBe(true);
    expect(res.files.deleted).toBe(0);
    expect(await ledger(id)).toMatchObject([{ status: 'failed' }]);
    expect((await ledger(id))[0].last_error).toMatch(/still present/);
    await run();                                       // tidy: completes on retry
    expect(onDisk(name)).toBe(false);
  });

  it(`stops retrying after ${MAX_ATTEMPTS} attempts and keeps reporting it`, async () => {
    const name = fileName();
    const id = await candidate(A, { url: makeFile(name) });
    const eperm = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) await run({ unlink: eperm });
    const [row] = await ledger(id);
    expect(row).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect((await run({ unlink: eperm })).files.failed_permanently).toBeGreaterThanOrEqual(1);
    expect(onDisk(name)).toBe(true);
    await pool.query(`UPDATE candidate_resume_purges SET attempts = 0 WHERE candidate_id = $1`, [id]);
    await run();                                       // tidy
    expect(onDisk(name)).toBe(false);
  });

  it('re-running the job duplicates nothing', async () => {
    const name = fileName();
    const id = await candidate(A, { url: makeFile(name) });
    await run();
    const before = { anon: (await anonymisedAt(id)).anonymised_at, ledger: await ledger(id), log: await logActions(id) };
    await run(); await run();
    expect((await anonymisedAt(id)).anonymised_at).toEqual(before.anon);
    expect(await ledger(id)).toEqual(before.ledger);
    expect(await logActions(id)).toEqual(before.log);
  });
});

describe('scope', () => {
  it('a company-scoped run never touches another company\'s due candidate or its file', async () => {
    const name = fileName();
    const other = await candidate(B, { url: makeFile(name) });
    await run();
    expect((await anonymisedAt(other)).anonymised_at).toBeNull();
    expect(await ledger(other)).toEqual([]);
    expect(onDisk(name)).toBe(true);
  });
});
