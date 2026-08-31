/**
 * analytics.intelligenceContract.test.js — the 501 short-circuit is load-bearing.
 *
 * WHY THIS EXISTS
 * ---------------
 * `check-sql-references.mjs` carries a list of nine tables that have never
 * existed in any migration (`sla_config`, `dashboard_widgets`, `project_costs`,
 * …). It reports them as UNIMPLEMENTED rather than MISSING and does NOT fail the
 * build, on one stated condition: the routes that query them are short-circuited
 * to 501 in intelligence.routes.js, so no request can ever reach the dead SQL.
 *
 * That comment names THIS FILE as the guard on that condition — and this file did
 * not exist. The checker's safety story pointed at nothing for as long as the
 * exemption did. Delete the short-circuit while leaving the query text and the
 * gate would stay green over nine broken endpoints.
 *
 * If a table here is genuinely built later, the fix is: add the migration, remove
 * its entry from UNBACKED_PREFIXES, remove it from UNIMPLEMENTED_TABLES in the
 * checker, and delete its case below. All four, together.
 *
 * Runner: Vitest | npx vitest run src/__tests__/analytics.intelligenceContract.test.js
 */
import { describe, test, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';

// Real DB credentials — see integration.salesPartners.test.js for why.
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

const { default: pool }               = await import('../config/db.js');
const { default: intelligenceRoutes } = await import('../modules/intelligence/intelligence.routes.js');
const { buildApp }                    = await import('./helpers/testApp.js');

const here     = dirname(fileURLToPath(import.meta.url));
const ROUTES_SRC = readFileSync(resolve(here, '../modules/intelligence/intelligence.routes.js'), 'utf8');
const CHECKER_SRC = readFileSync(resolve(here, '../../scripts/check-sql-references.mjs'), 'utf8');

/** The capabilities the checker is allowed to skip, and their backing tables. */
const UNBACKED = [
  ['/sla-config',       'sla_config'],
  ['/sla-tracking',     'sla_tracking'],
  ['/widgets',          'dashboard_widgets'],
  ['/documents',        'documents'],
  ['/project-costs',    'project_costs'],
  ['/budget-vs-actual', 'budget_vs_actual'],
  ['/profit-tracker',   'profit_tracker'],
  ['/masters',          'masters'],
  ['/insights',         'insights_cache'],
];

const app = buildApp(['/api/intelligence', intelligenceRoutes]);

afterAll(async () => { await pool.end().catch(() => {}); });

describe('unbacked intelligence capabilities are short-circuited', () => {
  test.each(UNBACKED)('GET %s returns 501, never reaching its dead SQL', async (prefix) => {
    const res = await request(app).get(`/api/intelligence${prefix}`);
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ available: false });
    expect(res.body.capability).toBe(prefix.slice(1));
  });

  test.each(UNBACKED)('a sub-path under %s is short-circuited too', async (prefix) => {
    const res = await request(app).get(`/api/intelligence${prefix}/1`);
    expect(res.status).toBe(501);
  });

  test('the short-circuit list in the router still matches this one', () => {
    // A capability quietly removed from UNBACKED_PREFIXES would start serving a
    // query against a table that does not exist, while the checker carried on
    // exempting it.
    for (const [prefix, table] of UNBACKED) {
      expect(ROUTES_SRC).toContain(`'${prefix}'`);
      expect(ROUTES_SRC).toContain(`'${table}'`);
    }
  });

  test("the checker's exemption list matches the router's", () => {
    for (const [, table] of UNBACKED) {
      expect(CHECKER_SRC).toContain(`'${table}'`);
    }
  });
});

describe('the exempted tables really are absent from the schema', () => {
  test('none of them exists — the exemption is a fact, not an assumption', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name = ANY($1::text[])`,
      [UNBACKED.map(([, t]) => t)]);
    // If one of these ever appears, the capability should be built and unexempted
    // rather than left 501-ing over a table that now exists.
    expect(rows.map(r => r.table_name)).toEqual([]);
  });
});
