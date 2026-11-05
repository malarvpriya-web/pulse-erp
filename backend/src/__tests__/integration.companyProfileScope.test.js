/**
 * Company Profile writes the company payroll's PT/LWF jurisdiction is read
 * from — PAYROLL_DATA_FLOW_AUDIT.md Part 9.
 *
 * Two throwaway companies; company 1 (Manifest) is never read or written by
 * the requests under test — the suite asserts it is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }          = await import('../config/db.js');
const { verifyToken }            = await import('../middlewares/auth.middleware.js');
const { buildApp }               = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies } = await import('./helpers/isolatedCompany.js');
const { default: profileRoutes } = await import('../modules/admin/companyProfile.routes.js');

const app = buildApp(['/api/company-profile', verifyToken, profileRoutes]);
const PREFIX = 'ZZCOPROF';
let A, B, manifestBefore;
const put = (who, body) => request(app).put('/api/company-profile').set('Authorization', `Bearer ${who.token()}`).send(body);
const row = async (id) => (await pool.query('SELECT name, gstin, state, address FROM companies WHERE id = $1', [id])).rows[0];
const cleanup = async (id) => {
  await pool.query(`DELETE FROM company_settings WHERE company_id = $1`, [id]);
  await dropIsolatedCompany(pool, id);
};

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) await cleanup(id);
  A = await createIsolatedCompany(pool, PREFIX);
  B = await createIsolatedCompany(pool, `${PREFIX}B`);
  manifestBefore = await row(1);
}, 60000);

afterAll(async () => {
  for (const c of [A, B]) if (c) await cleanup(c.companyId);
}, 60000);

describe('Company Profile is the caller\'s company', () => {
  it('GET returns the caller\'s company, not the first row of the table', async () => {
    const r = await request(app).get('/api/company-profile').set('Authorization', `Bearer ${B.token()}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(B.companyId);
  });

  it('PUT updates only the caller\'s company — company 1 is untouched', async () => {
    const r = await put(B, { name: `${B.code} Ltd`, gstin: '33AABCZ1234A1Z5', state: 'Tamil Nadu', address: 'Test address, Tamil Nadu' });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(B.companyId);
    expect(await row(B.companyId)).toMatchObject({ name: `${B.code} Ltd`, state: 'Tamil Nadu', gstin: '33AABCZ1234A1Z5' });
    expect(await row(1)).toEqual(manifestBefore);
  });
});

describe('the stored state is not overwritten from the GSTIN', () => {
  it('a save without a state (the Setup Wizard\'s company step) keeps the stored state', async () => {
    await pool.query(`UPDATE companies SET state = 'Tamil Nadu', gstin = '29AABCZ1234A1Z5' WHERE id = $1`, [A.companyId]);
    const r = await put(A, { name: `${A.code} Ltd`, gstin: '29AABCZ1234A1Z5', address: 'Wizard address' });
    expect(r.status).toBe(200);
    expect((await row(A.companyId)).state).toBe('Tamil Nadu');           // was reset to Karnataka from the 29 prefix
  });

  it('a blank state is filled from the GSTIN', async () => {
    await pool.query(`UPDATE companies SET state = NULL WHERE id = $1`, [A.companyId]);
    await put(A, { name: `${A.code} Ltd`, gstin: '33AABCZ1234A1Z5' });
    expect((await row(A.companyId)).state).toBe('Tamil Nadu');
  });

  it('an explicit state that contradicts the GSTIN is refused — nothing is saved', async () => {
    const before = await row(A.companyId);
    const r = await put(A, { name: 'Changed', gstin: '29AABCZ1234A1Z5', state: 'Tamil Nadu' });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/registered in Karnataka/);
    expect(await row(A.companyId)).toEqual(before);
  });

  it('company 1 is unchanged by the whole suite', async () => {
    expect(await row(1)).toEqual(manifestBefore);
  });
});
