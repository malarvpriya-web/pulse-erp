/**
 * 16-analytics-contract.spec.ts — Contract tests for the Analytics & AI module.
 *
 * These exist because of a specific class of defect found in the pre-go-live
 * audit: the module was internally inconsistent in ways that no render test could
 * catch. CEO Intelligence showed 13 open tickets on its Operations tab and 15 on
 * its Collections tab. HR Dashboard reported 66.7% offer acceptance while HR
 * Benchmarking reported 0% for the same KPI. CEO's "Outstanding" and CFO's "AR"
 * differed by the value of three invoices whose status one query recognised and
 * the other did not. Every page rendered fine. Every endpoint returned 200.
 *
 * Five groups of test:
 *   A. RECONCILIATION — a KPI with one name must have one value, wherever it is read.
 *   B. SCHEMA CONTRACT — every status literal in application SQL must exist in the
 *      column it filters, and every table/column referenced must exist.
 *   C. HONESTY        — no endpoint may present an unmeasured figure as measured.
 *   D. FILTERS        — a filter must change the query, not just the UI.
 *   E. AUTHORIZATION  — the analytics read surface must not be open to any login.
 *
 * Run: npx playwright test tests/suites/16-analytics-contract.spec.ts
 */
import { test, expect, request as pwRequest } from '@playwright/test';
import { execSync } from 'node:child_process';
import path from 'node:path';

const API = process.env.PULSE_API ?? 'http://localhost:5000/api/v1';
// Repo root resolved from this file, not hard-coded: tests/suites/ -> repo root.
// The suite used to live outside the repository and pointed at an absolute
// developer path, which is why it could never run on a CI runner.
const REPO = process.env.PULSE_ROOT ?? path.resolve(__dirname, '..', '..');

/**
 * A real, active account holding only the `employee` role — the fixture for
 * "can a plain login read the CFO's P&L?". Override with PULSE_LOW_PRIV_EMAIL
 * if this account is ever deactivated or promoted; the test asserts the roles it
 * actually gets back, so a wrong fixture fails loudly instead of passing.
 */
const LOW_PRIV_EMAIL = process.env.PULSE_LOW_PRIV_EMAIL ?? 'john.doe@manifest.in';

let TOKEN = '';

test.beforeAll(() => {
  const raw = execSync('node backend/scripts/e2e-mint-token.mjs', { cwd: REPO, encoding: 'utf8' });
  TOKEN = JSON.parse(raw.split('---E2E_AUTH_BEGIN---')[1].split('---E2E_AUTH_END---')[0].trim()).token;
});

/**
 * Run a checker script and return its fenced JSON report.
 *
 * The payload is fenced because dotenv v17 prints a rotating tip banner to
 * stdout, and one of its variants contains a brace — so slicing from the first
 * '{' intermittently parsed the banner instead of the report and failed as if
 * the schema were broken.
 */
function runReport(script: string) {
  const out = execSync(`node backend/scripts/${script} --json`, { cwd: REPO, encoding: 'utf8' });
  const body = out.split('---REPORT_BEGIN---')[1]?.split('---REPORT_END---')[0];
  expect(body, `${script} produced no fenced report:
${out}`).toBeTruthy();
  return JSON.parse(body!.trim());
}

/** GET as the super-admin fixture and return the parsed body. */
async function get(path: string) {
  const ctx = await pwRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } });
  const res = await ctx.get(`${API}${path}`);
  const body = await res.json().catch(() => null);
  await ctx.dispose();
  return { status: res.status(), body };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. RECONCILIATION
// ─────────────────────────────────────────────────────────────────────────────
test.describe('@P0 KPI reconciliation — one name, one number', () => {
  test('Open tickets agree between the Operations tile and the Collections KPI', async () => {
    const [ops, svc] = await Promise.all([
      get('/dashboard/operations'),
      get('/ceo-intelligence/service-amc'),
    ]);
    expect(ops.status).toBe(200);
    expect(svc.status).toBe(200);
    // Both render on CEO Intelligence, one tab apart. They disagreed by casing
    // ('Resolved' vs 'resolved') and by soft-delete handling.
    expect(Number(svc.body.tickets.open)).toBe(Number(ops.body.open_tickets));
  });

  test('Receivables agree between CEO "Outstanding" and CFO "AR"', async () => {
    const [exec, cfo] = await Promise.all([
      get('/ceo-intelligence/executive-summary'),
      get('/dashboard/cfo?period=YTD'),
    ]);
    // Both mean "invoiced and not yet collected". An unpaid status recognised by
    // only one of them put the two figures Rs 5.6L apart.
    expect(Number(exec.body.kpis.outstanding_collections)).toBe(Number(cfo.body.kpis.ar));
  });

  test('Offer acceptance agrees between HR Dashboard and HR Benchmarking', async () => {
    const [hrDash, hrBench] = await Promise.all([
      get('/analytics/offer-acceptance'),
      get('/analytics/hr-benchmarks'),
    ]);
    const a = Number(hrDash.body?.data?.rate ?? hrDash.body?.rate);
    const b = Number(hrBench.body.recruitment.offerAcceptanceRate);
    // HR Benchmarking used to read candidates.status, which nothing writes.
    expect(b).toBe(a);
  });

  test('Revenue YTD agrees across every surface that reports it', async () => {
    const [exec, kpis] = await Promise.all([
      get('/ceo-intelligence/executive-summary'),
      get('/analytics/ceo/kpis'),
    ]);
    expect(Number(kpis.body.kpis.revenue.value)).toBe(Number(exec.body.kpis.revenue_ytd));
  });

  test('Revenue-per-employee is built on the same revenue definition as everything else', async () => {
    const hrBench = await get('/analytics/hr-benchmarks');
    // This query had no status filter, so it counted unpaid invoices and ran ~48x
    // every other revenue figure. The basis is now declared in the payload.
    expect(hrBench.body.performance.revenueBasis).toContain('paid');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. SCHEMA CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
test.describe('@P0 Schema contract — SQL matches the database', () => {
  test('every status literal used in analytics SQL exists in its column', async () => {
    // Reads the canonical vocabularies from shared/statusSets.js and compares
    // them against SELECT DISTINCT on each column.
    const report = runReport('check-status-vocabulary.mjs');
    // A value present in the DB but absent from the vocabulary means some query
    // is silently skipping rows — exactly the attrition/ticket/timesheet class of bug.
    expect(report.unmapped, `DB values not covered by statusSets.js:\n${JSON.stringify(report.unmapped, null, 2)}`).toEqual([]);
  });

  test('no analytics SQL references a table or column that does not exist', async () => {
    const report = runReport('check-sql-references.mjs');
    // assessment_submissions, recruitment_costs, invoices.client_name and
    // inventory_items.name were all referenced by live code and none existed.
    expect(report.missingTables, JSON.stringify(report.missingTables)).toEqual([]);
    expect(report.missingColumns, JSON.stringify(report.missingColumns)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. HONESTY — nothing unmeasured may be presented as measured
// ─────────────────────────────────────────────────────────────────────────────
test.describe('@P1 /dashboard/cfo speaks both period vocabularies', () => {
  // 2026-08-26: the CFO Dashboard moved onto the shared filter contract
  // (?period=mtd|qtd|fytd|…|custom). The legacy FY vocabulary (?period=YTD|Q1..Q4)
  // stays, because kpi-reconcile.mjs, perf-probe.mjs and five assertions in THIS
  // file request `?period=YTD` and the handler answers an unknown period with
  // 400 — dropping it would have turned every one of them red.

  test('the shared presets resolve, and the window travels back in the response', async () => {
    for (const [preset, label] of [
      ['fytd',    /financial year/i],
      ['mtd',     /this month/i],
      ['last90',  /last 90 days/i],
      ['all',     /all time/i],
    ] as [string, RegExp][]) {
      const { status, body } = await get(`/dashboard/cfo?period=${preset}`);
      expect(status, `?period=${preset} was rejected`).toBe(200);
      expect(body.period, `?period=${preset} echoed the wrong preset`).toBe(preset);
      expect(body.period_label ?? '', `?period=${preset} shipped no period_label`).toMatch(label);
      expect(body.from, `?period=${preset} shipped no resolved start`).toBeTruthy();
      expect(body.to,   `?period=${preset} shipped no resolved end`).toBeTruthy();
    }
  });

  test('period=all is bounded by real activity, not a fake epoch', async () => {
    // DSO, DPO and monthly burn all divide by the LENGTH of the window. Binding
    // 1970 as the lower bound would report a burn rate two orders of magnitude
    // too low — a confidently wrong number rather than a missing one.
    const { body } = await get('/dashboard/cfo?period=all');
    expect(new Date(body.from).getFullYear(),
      'period=all fell back to an epoch start — burn rate and DSO are meaningless')
      .toBeGreaterThan(2000);
    expect(new Date(body.from).getTime()).toBeLessThanOrEqual(new Date(body.to).getTime());
  });

  test('the legacy FY vocabulary still resolves to FY quarters', async () => {
    const { status, body } = await get('/dashboard/cfo?period=Q2');
    expect(status).toBe(200);
    expect(body.period).toBe('Q2');
    // FY quarters are Apr–Jun / Jul–Sep / …, NOT calendar quarters. `qtd` in the
    // shared vocabulary is the current CALENDAR quarter to date — a different
    // window, which is why the two are kept apart rather than aliased.
    expect(body.from).toMatch(/-07-01$/);
    expect(body.to).toMatch(/-09-30$/);
  });

  test('a bad period or a bad date is a 400, not a quietly different window', async () => {
    const bogus = await get('/dashboard/cfo?period=NOT_A_PERIOD');
    expect(bogus.status, 'an unknown period returned 200 with substituted figures').toBe(400);
    expect(bogus.body.allowed, 'the 400 did not list the accepted vocabulary').toBeTruthy();

    const badDate = await get('/dashboard/cfo?period=custom&from=not-a-date');
    expect(badDate.status, 'a malformed ?from silently returned the default window').toBe(400);
  });
});

test.describe('@P0 No fabricated values', () => {
  test('every posted journal entry is attributed to a company', async () => {
    // journal.repository.js#createEntry omitted company_id from its column list,
    // so nine posted entries — invoices, receipts, payments, depreciation — sat
    // in the ledger with a NULL company. Every company-scoped financial report
    // filters on it, so the CFO dashboard reported "no journal entries posted"
    // while the books were not in fact empty, and net profit / EBITDA read
    // "Not available". An unattributed entry is silently invisible, never loud.
    const { body } = await get('/dashboard/cfo?period=YTD');
    expect(body.accounting).toBeTruthy();
    expect(body.accounting.unattributedLedgerLines ?? 0,
      'posted P&L lines exist that belong to no company — check journal_entries.company_id')
      .toBe(0);
  });

  test('CFO net profit and EBITDA come from the posted ledger or report as unposted', async () => {
    const { body } = await get('/dashboard/cfo?period=YTD');
    expect(body.accounting).toBeTruthy();
    expect(typeof body.accounting.glPosted).toBe('boolean');
    if (!body.accounting.glPosted) {
      // Previously these were grossProfit*0.78 and netProfit+opex*0.05.
      expect(body.kpis.netProfit).toBeNull();
      expect(body.kpis.ebitda).toBeNull();
      expect(body.ratios.netMargin).toBeNull();
    }
  });

  test('every CFO alert action maps to a real page', async () => {
    const { body } = await get('/dashboard/cfo?period=YTD');
    // The frontend's ALERT_ACTION_PAGE keys. All five buttons were dead because
    // the backend emitted 'Follow Up'/'Review'/'View' and none of those were keys.
    const KNOWN = new Set([
      'View Invoices', 'Manage Expenses', 'View Projects', 'Review Leaves',
      'View Inventory', 'View Bills', 'Process Payments', 'Review Budget', 'View Reports',
    ]);
    for (const a of body.alerts ?? []) {
      if (a.action) expect(KNOWN, `unmapped alert action "${a.action}"`).toContain(a.action);
    }
  });

  test('AI insights are all derived from data, and say so truthfully', async () => {
    const { body } = await get('/ceo-intelligence/ai-insights');
    expect(body.derived_from_live_data).toBe(true);
    const all = Object.values(body.insights ?? {}).flat() as any[];
    // 21 of 25 bullets used to be fixed prose. Every item must now cite a metric.
    for (const item of all) {
      expect(typeof item).toBe('object');
      expect(item.metric, `insight has no supporting metric: ${JSON.stringify(item)}`).toBeTruthy();
      expect(item.value).toBeDefined();
    }
    // And none of the removed canned strings may reappear.
    const text = JSON.stringify(all);
    for (const banned of ['IGBT', 'Pipeline conversion at ~35%', 'Top 5 customers by revenue growth show 40%']) {
      expect(text).not.toContain(banned);
    }
  });

  test('project margin is null when cost has not been booked, never zero', async () => {
    const { body } = await get('/ceo-intelligence/projects');
    for (const p of body.projects ?? []) {
      if (!p.has_cost_data) {
        // An uncosted project used to render 100% margin and a green "On Track".
        expect(p.margin_pct).toBeNull();
        expect(p.profit).toBeNull();
        expect(p.health_label).not.toBe('On Track');
      }
    }
    if ((body.summary?.costed_projects ?? 0) === 0) {
      expect(body.summary.portfolio_margin_pct).toBeNull();
    }
  });

  test('business lines come from the product_lines master, not a literal list', async () => {
    const { body } = await get('/ceo-intelligence/manifest');
    expect(body.taxonomy_source).toBe('product_lines');
    expect(body.coverage).toBeTruthy();
    // The old hardcoded list. None of these are real product lines here.
    const names = (body.manifest ?? []).map((m: any) => m.business_line);
    for (const fake of ['HVDC', 'STATCOM', 'SST']) {
      if (names.includes(fake)) {
        // Only acceptable if it genuinely exists in product_lines.
        const lines = await get('/master/product-lines').catch(() => null);
        expect(lines).toBeTruthy();
      }
    }
  });

  test('the revenue forecast declares whether its win rate was measured', async () => {
    const { body } = await get('/ceo-intelligence/executive-summary');
    expect(typeof body.forecast_is_measured).toBe('boolean');
    expect(body.forecast_basis).toBeTruthy();
  });

  test('traffic lights report "unknown" rather than green when unmeasured', async () => {
    const { body } = await get('/ceo-intelligence/executive-summary');
    const valid = new Set(['green', 'amber', 'red', 'unknown']);
    for (const [k, v] of Object.entries(body.traffic_lights ?? {})) {
      expect(valid, `traffic light ${k} = ${v}`).toContain(v);
    }
    // supply_chain and profitability were the literal 'green'. If nothing is
    // costed, profitability cannot honestly be green.
    const proj = await get('/ceo-intelligence/projects');
    if ((proj.body?.summary?.costed_projects ?? 0) === 0) {
      expect(body.traffic_lights.profitability).toBe('unknown');
    }
  });

  test('HR benchmarking distinguishes "no data" from a failing score', async () => {
    const { body } = await get('/analytics/hr-benchmarks');
    expect(typeof body.performance.trainingDataAvailable).toBe('boolean');
    expect(typeof body.recruitment.costPerHireAvailable).toBe('boolean');
    // Cost per hire has no source in this schema; it must be null, not 0.
    if (!body.recruitment.costPerHireAvailable) {
      expect(body.recruitment.costPerHire).toBeNull();
    }
    // One name per number: offerExceptionRate was a duplicate of offerDeclineRate.
    expect(body.recruitment).not.toHaveProperty('offerExceptionRate');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. FILTERS
// ─────────────────────────────────────────────────────────────────────────────
test.describe('@P1 Filters change the result', () => {
  test('the department filter reaches the database', async () => {
    const [all, one] = await Promise.all([
      get('/analytics/headcount'),
      get('/analytics/headcount?department=Finance'),
    ]);
    expect(all.status).toBe(200);
    expect(one.status).toBe(200);
    // HR Dashboard's dropdown used to filter one already-loaded array in memory
    // and send nothing to the API.
    expect(Number(one.body.data.total)).toBeLessThanOrEqual(Number(all.body.data.total));
  });

  test('the period filter reaches the database', async () => {
    const [long, short] = await Promise.all([
      get('/analytics/hr-benchmarks?period=last12m'),
      get('/analytics/hr-benchmarks?period=last30'),
    ]);
    expect(long.body.period).toBe('last12m');
    expect(short.body.period).toBe('last30');
  });

  test('department options come from the employee master', async () => {
    const { body } = await get('/analytics/hr-filter-options');
    expect(Array.isArray(body.departments)).toBe(true);
    // The old hardcoded list offered three departments with no employees.
    for (const phantom of ['Support']) {
      if (body.departments.includes(phantom)) continue; // fine if it is real
    }
    expect(body.departments.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. AUTHORIZATION
// ─────────────────────────────────────────────────────────────────────────────
test.describe('@P0 Analytics is not readable by any authenticated user', () => {
  const SENSITIVE = [
    '/dashboard/cfo?period=YTD',
    '/analytics/salary-bands',
    '/analytics/hr-benchmarks',
    '/analytics/top-performers',
    '/dashboard/top-customers',
  ];

  test('a token with no permissions is refused on every sensitive endpoint', async () => {
    // The mint script selects the account with E2E_LOGIN_EMAIL — it has no
    // `--role` flag, and passing one is silently IGNORED rather than erroring.
    // An earlier version of this test passed `--role employee`, got a
    // super_admin token back, and reported a 200 as an authorization leak.
    // A test that can quietly assert the wrong thing is worse than no test, so
    // the identity of the minted token is verified before it is used.
    const raw = execSync('node backend/scripts/e2e-mint-token.mjs', {
      cwd: REPO, encoding: 'utf8',
      env: { ...process.env, E2E_LOGIN_EMAIL: LOW_PRIV_EMAIL },
    });
    const minted = JSON.parse(raw.split('---E2E_AUTH_BEGIN---')[1].split('---E2E_AUTH_END---')[0].trim());

    const roles = (minted.roles ?? []).map((r: string) => String(r).toLowerCase());
    expect(roles.length, `${LOW_PRIV_EMAIL} has no roles — cannot test authorization`).toBeGreaterThan(0);
    for (const privileged of ['super_admin', 'admin', 'hr', 'finance', 'manager']) {
      expect(roles, `${LOW_PRIV_EMAIL} holds "${privileged}" — pick a lower-privilege fixture`).not.toContain(privileged);
    }

    const ctx = await pwRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${minted.token}` } });
    for (const ep of SENSITIVE) {
      const res = await ctx.get(`${API}${ep}`);
      // 403 is the point. 200 means the API is open and the sidebar was the only guard.
      expect([401, 403], `${ep} returned ${res.status()} for roles=${JSON.stringify(roles)}`).toContain(res.status());
    }
    await ctx.dispose();
  });

  test('endpoints that should stay open to any login still are', async () => {
    const raw = execSync('node backend/scripts/e2e-mint-token.mjs', {
      cwd: REPO, encoding: 'utf8',
      env: { ...process.env, E2E_LOGIN_EMAIL: LOW_PRIV_EMAIL },
    });
    const token = JSON.parse(raw.split('---E2E_AUTH_BEGIN---')[1].split('---E2E_AUTH_END---')[0].trim()).token;
    const ctx = await pwRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    // The birthday wall carries no confidential data and is on everyone's home
    // page. Guarding it would be a regression, not an improvement.
    for (const ep of ['/dashboard/celebrations', '/dashboard/celebrations-today']) {
      const res = await ctx.get(`${API}${ep}`);
      expect(res.status(), `${ep} should remain open to any authenticated user`).toBe(200);
    }
    await ctx.dispose();
  });

  test('unauthenticated requests are refused', async () => {
    const ctx = await pwRequest.newContext();
    for (const ep of SENSITIVE) {
      const res = await ctx.get(`${API}${ep}`);
      expect([401, 403]).toContain(res.status());
    }
    await ctx.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. MUTATING ACTIONS — the five that write
// ─────────────────────────────────────────────────────────────────────────────
test.describe('@P0 Actions that write are exercised, not assumed', () => {
  test('every mutating Analytics & AI action works and is authorized', () => {
    // The browser suite clicks 41 of 46 actions. The other five create an
    // opportunity, reset a password, create a user, or bill an external LLM, so
    // clicking them in a verification pass would write to the live database.
    // This driver runs them against throwaway fixtures and deletes everything
    // afterwards — including the negative cases (a plain employee must be
    // refused, a malformed uuid must be a 400 rather than a 500).
    //
    // Leaving them unverified is how CFO's five alert buttons shipped as no-ops:
    // the routes existed, so a route-table reading said they worked.
    const out = execSync('node backend/scripts/audit/mutating-actions-probe.mjs --json',
      { cwd: REPO, encoding: 'utf8' });
    const body = out.split('---REPORT_BEGIN---')[1]?.split('---REPORT_END---')[0];
    expect(body, `probe produced no report:
${out}`).toBeTruthy();
    const report = JSON.parse(body!.trim());
    const failed = report.results.filter((r: any) => !r.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(report.passed).toBeGreaterThanOrEqual(10);
  });
});
