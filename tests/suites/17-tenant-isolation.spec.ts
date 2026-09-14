/**
 * 17-tenant-isolation.spec.ts — cross-tenant regression tests for Analytics & AI.
 *
 * WHY THIS EXISTS
 * ---------------
 * The database ships with exactly one company, which makes every isolation
 * claim unfalsifiable: a query that ignores company_id entirely still returns
 * the right answer when there is only one tenant. A previous audit inspected the
 * code and recorded the unscoped queries as "latent, 1 tenant today". They were
 * not latent — they were live defects that no single-tenant test could see.
 *
 * Seeding a second company made nine of them visible at once:
 *   * /analytics/manufacturing/work-centre reported `in_progress: 3` to BOTH
 *     tenants — two orders from one company plus one from the other;
 *   * /dashboard/finance, /dashboard/cash and /dashboard/data carried Company
 *     B's 7,777,777 invoice into Company A's receivable and Revenue-MTD KPI;
 *   * /dashboard/sales added B's 8,888,888 opportunity to A's pipeline;
 *   * /dashboard/project-health, /dashboard/top-customers, /dashboard/top-vendors
 *     and /ai/predictions all aggregated both companies.
 *
 * This spec creates Company B, drives every Analytics & AI endpoint as an admin
 * of each company, and fails if either tenant's data appears in the other's
 * response. Both fixtures hold the SAME role, so any difference is scoping and
 * nothing else.
 *
 * The fixture is torn down in afterAll and every row it writes is marked
 * ZZTENANT, so a crashed run leaves removable debris rather than plausible data.
 *
 * Run: npx playwright test --project=tenant-isolation
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Repo root resolved from this file, not hard-coded: tests/suites/ -> repo root.
// The suite used to live outside the repository and pointed at an absolute
// developer path, which is why it could never run on a CI runner.
const REPO = process.env.PULSE_ROOT ?? path.resolve(__dirname, '..', '..');
const API = process.env.PULSE_API ?? 'http://localhost:5000/api/v1';

/** Company A's admin. Same role as the seeded Company B admin, by construction. */
const A_EMAIL = process.env.TENANT_A_EMAIL ?? 'admin@manifest.in';

type Report = {
  company_a: number;
  company_b: number;
  a_roles: string[];
  b_roles: string[];
  endpoints: number;
  a_status: Record<string, number>;
  b_status: Record<string, number>;
  findings: Array<{ ep: string; kind: string; value?: number; sample?: string; len?: number }>;
};

let report: Report;

/** Run a backend audit script and return its fenced JSON payload. */
function runFenced(args: string[], begin: string, end: string) {
  const out = execFileSync('node', args, {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, PROBE_API: API, TENANT_A_EMAIL: A_EMAIL },
  });
  const body = out.split(begin)[1]?.split(end)[0];
  expect(body, `no fenced payload from ${args.join(' ')}:\n${out}`).toBeTruthy();
  return JSON.parse(body!.trim());
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  runFenced(['backend/scripts/audit/tenant-fixture.mjs', '--up'],
    '---FIXTURE_BEGIN---', '---FIXTURE_END---');
  // The probe writes the full matrix to disk and prints a summary; read the
  // file so individual assertions can name the endpoint that failed.
  runFenced(['backend/scripts/audit/tenant-leak-probe.mjs'],
    '---REPORT_BEGIN---', '---REPORT_END---');
  report = JSON.parse(
    execFileSync('node', ['-e', 'process.stdout.write(require("fs").readFileSync("tenant-leaks.json","utf8"))'],
      { cwd: REPO, encoding: 'utf8' }),
  );
});

test.afterAll(() => {
  execFileSync('node', ['backend/scripts/audit/tenant-fixture.mjs', '--down'],
    { cwd: REPO, encoding: 'utf8' });
});

test.describe('@P0 Multi-tenant isolation', () => {
  test('the fixture really is two companies with identical roles', () => {
    // If this ever collapses to one company, or the roles diverge, every other
    // assertion below becomes meaningless — so it is checked first.
    expect(report.company_a).not.toBe(report.company_b);
    expect(report.a_roles.sort()).toEqual(report.b_roles.sort());
    expect(report.endpoints).toBeGreaterThan(50);
  });

  test('both tenants can reach every endpoint (no false PASS from a 403)', () => {
    // An endpoint that 403s for one tenant would trivially "not leak". The
    // isolation claim only means something where both sides get a 200.
    // Two statuses are legitimately not 200 and are not false passes:
    //   501 — the nine intelligence capabilities with no backing table,
    //         short-circuited on purpose (analytics.intelligenceContract.test.js)
    //   404 — a path param the probe fills with an id that exists in neither
    //         tenant, which the probe documents as an honest miss
    // Everything else must be 200, and — the stronger half — both tenants must
    // get the SAME status, so an endpoint reachable by one but not the other is
    // still caught.
    const ALLOWED_NON_200 = new Set([404, 501]);
    const bad = [
      ...Object.entries(report.a_status)
        .filter(([, c]) => c !== 200 && !ALLOWED_NON_200.has(c)).map(([e, c]) => `A ${e}:${c}`),
      ...Object.entries(report.b_status)
        .filter(([, c]) => c !== 200 && !ALLOWED_NON_200.has(c)).map(([e, c]) => `B ${e}:${c}`),
    ];
    expect(bad, bad.join('\n')).toEqual([]);

    // A 200/404 split on an endpoint that takes a record id is isolation WORKING,
    // not failing: the probe substitutes id=1, that record belongs to one tenant,
    // and the other correctly cannot see it. Anything else asymmetric means one
    // tenant can reach a surface the other cannot, which would make "no leaks"
    // vacuous for that endpoint.
    const isRecordScoped = (a: number, b: number) =>
      (a === 200 && b === 404) || (a === 404 && b === 200);
    const asymmetric = Object.keys(report.a_status)
      .filter((e) => report.a_status[e] !== report.b_status[e])
      .filter((e) => !isRecordScoped(report.a_status[e], report.b_status[e]))
      .map((e) => `${e}: A=${report.a_status[e]} B=${report.b_status[e]}`);
    expect(asymmetric, asymmetric.join('\n')).toEqual([]);

    // And the comparison must stay worth making: most of the surface has to be
    // genuinely readable by both, or "no leaks found" means nothing.
    const both200 = Object.keys(report.a_status)
      .filter((e) => report.a_status[e] === 200 && report.b_status[e] === 200).length;
    expect(both200).toBeGreaterThan(Object.keys(report.a_status).length * 0.8);
  });

  test("Company B's records never appear in Company A's responses", () => {
    const leaks = report.findings.filter((f) => f.kind === 'B-marker-in-A');
    expect(leaks, JSON.stringify(leaks, null, 2)).toEqual([]);
  });

  test("Company B's values never appear inside Company A's aggregates", () => {
    // A string marker cannot survive SUM(); these three amounts exist only in
    // Company B, so finding one in Company A means an aggregate crossed over.
    const leaks = report.findings.filter((f) => f.kind === 'B-value-in-A');
    expect(leaks, JSON.stringify(leaks, null, 2)).toEqual([]);
  });

  test('no endpoint returns byte-identical data to two different tenants', () => {
    // The signature of a query that never bound company_id at all.
    const same = report.findings.filter((f) => f.kind === 'identical-across-tenants');
    expect(same, JSON.stringify(same.map((f) => ({ ep: f.ep, sample: f.sample })), null, 2)).toEqual([]);
  });

  test('the probe found nothing of any kind', () => {
    expect(report.findings, JSON.stringify(report.findings, null, 2)).toEqual([]);
  });
});
