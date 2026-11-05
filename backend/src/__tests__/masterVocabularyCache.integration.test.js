/**
 * Master-data writes are seen by server-side validation IMMEDIATELY.
 *
 * shared/masterVocabulary.js caches each (type, company) list for 60s, and
 * complaints / servicedesk / delivery-tracker validate against it with
 * canonicalValue() / vocabularyValues(). Nothing invalidated it on a write, so a
 * value created through "+ Add new" was refused (or written as NULL) by the save
 * that followed it, for up to a minute. The existing vocabulary suite never saw
 * this because it called invalidateVocabularyCache() itself between the write and
 * the read — doing by hand the step the application never did.
 *
 * So every case here:
 *  - PRIMES the cache first (a stale cache is only observable if one exists),
 *  - writes through the REAL master router over HTTP,
 *  - reads through the REAL validators, and
 *  - never calls invalidateVocabularyCache().
 *
 * It also pins what must NOT change: reads are still cached (a write that
 * bypasses the API is not seen until something invalidates), a refused write
 * and a GET leave the cache alone, and unrelated lists stay correct.
 *
 * Registry tenants 999952 / 999953 (testTenantIds.contract); zones are global,
 * so they carry the ZZCACHE prefix. Everything is removed on the way in and out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
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
const { default: masterRouter } = await import('../modules/master/master.routes.js');
const { canonicalValue, vocabularyValues } = await import('../shared/masterVocabulary.js');

const A = 999952;
const B = 999953;
const P = 'ZZCACHE';

function appAs(companyId, roles = ['admin']) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 1, roles, role: roles[0], company_id: companyId };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/master', masterRouter);
  return app;
}
const adminA = appAs(A);
const adminB = appAs(B);

async function sweep() {
  await pool.query(`DELETE FROM master_values WHERE company_id IN ($1,$2) OR value LIKE $3`, [A, B, `${P}%`]);
  for (const t of ['master_zones', 'master_departments', 'master_designations']) {
    await pool.query(`DELETE FROM ${t} WHERE name LIKE $1`, [`${P}%`]);
  }
  await pool.query(`DELETE FROM companies WHERE id IN ($1,$2)`, [A, B]);
}

beforeAll(async () => {
  await sweep();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ Cache A','ZZMVA'), ($2,'ZZ Cache B','ZZMVB')`, [A, B]);
});
afterAll(sweep);

describe('a value created through "+ Add new" is recognised by the next validation', () => {
  it('company-specific master_values row: seen at once by its company', async () => {
    const name = `${P} Retrofit`;
    expect(await canonicalValue('PROJECT_TYPE', name, A, [])).toBeNull();          // primes A's cache
    const res = await request(adminA).post('/master/v/project-types').send({ name });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await canonicalValue('PROJECT_TYPE', name.toLowerCase(), A, [])).toBe(name);
  });

  it('…and never by another company, even with its cache freshly rebuilt', async () => {
    expect(await canonicalValue('PROJECT_TYPE', `${P} Retrofit`, B, [])).toBeNull();
    // B adds its own value: B sees it, A does not.
    const own = `${P} B Only`;
    expect(await canonicalValue('PROJECT_TYPE', own, A, [])).toBeNull();           // prime A too
    expect((await request(adminB).post('/master/v/project-types').send({ name: own })).status).toBe(201);
    expect(await canonicalValue('PROJECT_TYPE', own, B, [])).toBe(own);
    expect(await canonicalValue('PROJECT_TYPE', own, A, [])).toBeNull();
  });

  it('table-backed master (zones): a new zone is valid immediately', async () => {
    const zone = `${P} North-East`;
    expect(await vocabularyValues('ZONE', A, [])).not.toContain(zone);              // primes
    const res = await request(adminA).post('/master/zones').send({ name: zone });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(await canonicalValue('ZONE', zone, A, [])).toBe(zone);
  });

  it('a rename is seen at once: the new name validates, the old one does not', async () => {
    const before = `${P} Brownfield`;
    const after = `${P} Brownfield Upgrade`;
    const { body } = await request(adminA).post('/master/v/project-types').send({ name: before });
    expect(await canonicalValue('PROJECT_TYPE', before, A, [])).toBe(before);       // cached
    expect((await request(adminA).put(`/master/v/project-types/${body.id}`).send({ name: after })).status).toBe(200);
    expect(await canonicalValue('PROJECT_TYPE', after, A, [])).toBe(after);
    expect(await canonicalValue('PROJECT_TYPE', before, A, [])).toBeNull();
  });

  it('a retired value stops validating at once, and validates again when reactivated', async () => {
    const name = `${P} Decommissioned`;
    const { body } = await request(adminA).post('/master/v/project-types').send({ name });
    expect(await canonicalValue('PROJECT_TYPE', name, A, [])).toBe(name);
    expect((await request(adminA).delete(`/master/v/project-types/${body.id}`)).status).toBe(200);
    expect(await canonicalValue('PROJECT_TYPE', name, A, [])).toBeNull();
    // Hard-deleted (unused) or deactivated: either way it must be gone. Reactivate
    // applies only to a deactivated row.
    const { rows } = await pool.query(`SELECT id FROM master_values WHERE id = $1`, [body.id]);
    if (rows.length) {
      expect((await request(adminA).post(`/master/v/project-types/${body.id}/reactivate`)).status).toBe(200);
      expect(await canonicalValue('PROJECT_TYPE', name, A, [])).toBe(name);
    }
  });
});

describe(`POST /master/zones (the Zone picker's "+ Add new")`, () => {
  it('creates a zone, and re-posting it in another case returns the same row', async () => {
    const a = await request(appAs(A, ['hr'])).post('/master/zones').send({ name: `${P} Coastal` });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const b = await request(adminA).post('/master/zones').send({ name: `  ${P.toLowerCase()} coastal ` });
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM master_zones WHERE LOWER(name) = LOWER($1)`, [`${P} Coastal`]);
    expect(rows[0].n).toBe(1);
  });

  it('revives a retired zone of the same name instead of adding a second one', async () => {
    const { rows: [z] } = await pool.query(
      `INSERT INTO master_zones (name, is_active) VALUES ($1, false) RETURNING id`, [`${P} Hills`]);
    expect(await canonicalValue('ZONE', `${P} Hills`, A, [])).toBeNull();
    const r = await request(adminA).post('/master/zones').send({ name: `${P} Hills` });
    expect(r.body.id).toBe(z.id);
    expect(await canonicalValue('ZONE', `${P} Hills`, A, [])).toBe(`${P} Hills`);
  });

  it('concurrent adds of one name settle on one row', async () => {
    const res = await Promise.all([1, 2, 3, 4].map(() => request(adminA).post('/master/zones').send({ name: `${P} Delta` })));
    res.forEach(r => expect(r.status, JSON.stringify(r.body)).toBe(200));
    expect(new Set(res.map(r => r.body.id)).size).toBe(1);
  });

  it('is still refused to roles outside admin / HR', async () => {
    expect((await request(appAs(A, ['sales_exec'])).post('/master/zones').send({ name: `${P} Nope` })).status).toBe(403);
  });
});

describe('Setup Wizard bulk imports (same dropped-constraint defect)', () => {
  it('departments/bulk inserts new names, skips existing ones in any case, and is seen at once', async () => {
    expect(await canonicalValue('DEPARTMENT', `${P} Logistics`, A, [])).toBeNull();     // primes
    const first = await request(adminA).post('/master/departments/bulk')
      .send({ departments: [{ name: `${P} Logistics` }, { name: `${P} Treasury` }] });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.inserted).toBe(2);
    expect(await canonicalValue('DEPARTMENT', `${P} Logistics`, A, [])).toBe(`${P} Logistics`);
    const again = await request(adminA).post('/master/departments/bulk')
      .send({ departments: [{ name: `${P.toLowerCase()} logistics ` }, { name: `${P} Audit` }] });
    expect(again.body.inserted).toBe(1);
  });

  it('designations/bulk likewise', async () => {
    const r = await request(adminA).post('/master/designations/bulk')
      .send({ designations: [{ name: `${P} Analyst` }, { name: `${P} ANALYST` }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.inserted).toBe(1);
    expect(await canonicalValue('DESIGNATION', `${P} analyst`, A, [])).toBe(`${P} Analyst`);
  });
});

describe('existing cache behaviour is unchanged', () => {
  it('reads are still cached: a row written around the API is not seen until a write invalidates', async () => {
    const sneaky = `${P} Direct Insert`;
    expect(await canonicalValue('PROJECT_TYPE', sneaky, A, [])).toBeNull();        // prime
    await pool.query(
      `INSERT INTO master_values (type, value, sort_order, company_id, is_active) VALUES ('PROJECT_TYPE',$1,99,$2,true)`,
      [sneaky, A]);
    expect(await canonicalValue('PROJECT_TYPE', sneaky, A, [])).toBeNull();        // still the cached list

    // A GET does not invalidate…
    expect((await request(adminA).get('/master/v/project-types')).status).toBe(200);
    expect(await canonicalValue('PROJECT_TYPE', sneaky, A, [])).toBeNull();

    // …nor does a refused write (duplicate → 409)…
    const dup = await request(adminA).post('/master/v/project-types').send({ name: `${P} Retrofit` });
    expect(dup.status).toBe(409);
    expect(await canonicalValue('PROJECT_TYPE', sneaky, A, [])).toBeNull();

    // …but the next successful write does.
    expect((await request(adminA).post('/master/v/project-types').send({ name: `${P} Trigger` })).status).toBe(201);
    expect(await canonicalValue('PROJECT_TYPE', sneaky, A, [])).toBe(sneaky);
  });

  it('unrelated lists stay correct after writes', async () => {
    // Shared seeds of the same vocabulary still validate for both companies.
    expect(await canonicalValue('PROJECT_TYPE', 'epc', A, [])).toBe('EPC');
    expect(await canonicalValue('PROJECT_TYPE', 'epc', B, [])).toBe('EPC');
    // Another vocabulary is exactly what the database holds for that company.
    const { rows } = await pool.query(
      `SELECT value FROM master_values WHERE type = 'INDUSTRY' AND is_active
          AND (company_id IS NULL OR company_id = $1) ORDER BY sort_order NULLS LAST, value`, [A]);
    expect(await vocabularyValues('INDUSTRY', A, [])).toEqual(rows.map(r => r.value));
    // Zones still match master_zones.
    const { rows: z } = await pool.query(`SELECT name FROM master_zones WHERE is_active ORDER BY name`);
    expect(await vocabularyValues('ZONE', A, [])).toEqual(z.map(r => r.name));
  });
});
