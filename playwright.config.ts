import { defineConfig } from '@playwright/test';

const AUTH_FILE = 'tests/.auth/user.json';

export default defineConfig({
  testDir: './tests',
  testIgnore: [
    // §220 — writes numbered documents; runs only via playwright.testdb.config.ts.
    '**/03-crud/procurement-hardening.spec.ts',
    // §221 — creates employees, leaves and projects; testdb config only.
    '**/06-db-consistency.spec.ts',
    '**/menu-audit.spec.js',
    '**/menu-crawler.spec.ts',
    '**/full-menu-audit.spec.ts',
  ],
  timeout: 45_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  retries: 1,
  workers: 1,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'tests/reports/html', open: 'never' }],
    ['json', { outputFile: 'tests/reports/results.json' }],
    ['./tests/reporters/bug-report.ts'],
    ['./tests/reporters/production-readiness.ts'],
  ],

  // Global defaults — NO storageState here so setup project does not inherit it
  use: {
    // Matches PULSE_FRONT_BASE in tests/auth.setup.ts so a run can be pointed at
    // a staging build or a second dev pair with one pair of env vars.
    baseURL: process.env.PULSE_FRONT_BASE ?? 'http://localhost:5173',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 12_000,
    navigationTimeout: 20_000,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  },

  projects: [
    // ── Step 1: create the auth file (no storageState needed) ──────────────
    {
      name: 'setup',
      testMatch: '**/auth.setup.ts',
      // storageState intentionally omitted — setup creates the file
    },

    // ── Step 2+: each project reads the auth file ──────────────────────────
    {
      name: 'ceo-drill',
      testMatch: '**/99-ceo-drillthrough.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },
    // PULSE-01: the Integrations pages in a real browser — the GET/PUT round trip
    // is the part only the page can prove.
    {
      name: 'integrations-authz',
      testMatch: '**/30-integrations-authz.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },
    {
      name: 'smoke',
      testMatch: '**/01-smoke.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },
    {
      name: 'navigation',
      testMatch: '**/02-navigation.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },
    {
      name: 'crud-employees',
      testMatch: '**/03-crud/employees.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },
    {
      name: 'crud-leaves',
      testMatch: '**/03-crud/leaves.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },
    {
      name: 'crud-procurement',
      testMatch: '**/03-crud/procurement.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },
    // The 2026-09-03 hardening pass, checked in a browser: the goods-receipt
    // status vocabulary (which decided whether the Confirm button rendered at
    // all), the failed-load state, and the removed shadow endpoints.
    // 'procurement-hardening' MOVED to playwright.testdb.config.ts (§220): it
    // creates a requisition, PO and GRN, and may only run against the isolated
    // test database. Its file fails closed if run any other way.
    {
      name: 'dashboard',
      testMatch: '**/04-dashboard.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },
    // Total cost of ownership — the comparison a buyer awards on. esbuild
    // compiles a page that ReferenceErrors on render, so these drive the real
    // pages rather than trusting a build.
    {
      name: 'tco',
      testMatch: '**/suites/tco-comparison.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },
    // §215 exchange rates — runs on its own throwaway company and mints its own
    // approver token, so it neither needs nor touches the superadmin session.
    {
      name: 'fx',
      testMatch: '**/suites/fx-rates.spec.ts',
    },
    // §216 freight & item weight — own throwaway company, own approver token.
    {
      name: 'freight',
      testMatch: '**/suites/freight.spec.ts',
    },
    // §219 RFQ quote entry — own throwaway company, own token.
    {
      name: 'quote-entry',
      testMatch: '**/suites/quote-entry.spec.ts',
    },
    // Sales Intelligence's Conversion Analytics tab. Every defect section 132
    // fixed compiled clean and answered 200 — a 450% "conversion", a win rate
    // contradicting the funnel beside it, an empty Monthly Trends tab. Only a
    // render catches that class.
    {
      name: 'sales-conversion',
      testMatch: '**/suites/sales-conversion.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },
    // Role/department consolidation pass. Every page here either lost a
    // duplicate role or department editor or was rewired onto the shared
    // roleCatalog / useDepartments source — and an emptied page still builds,
    // so each one is opened for real.
    {
      name: 'consolidation',
      testMatch: '**/suites/consolidation-render.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },
    {
      name: 'forms',
      testMatch: '**/05-forms.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },

    // ── Suite 00: API Health Audit ────────────────────────────────────────────
    // Raw HTTP probes — no browser required, no storageState
    {
      name: 'api-health',
      testMatch: '**/00-api-health.spec.ts',
      timeout: 60_000,
    },

    // ── Suite 06: DB Consistency Audit ────────────────────────────────────────
    {
      name: 'db-consistency',
      testMatch: '**/06-db-consistency.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
      timeout: 60_000,
    },

    // ── Suite 07: Dashboard Reconciliation ────────────────────────────────────
    {
      name: 'dashboard-reconciliation',
      testMatch: '**/07-dashboard-reconciliation.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },

    // ── Suite 08: Route Discovery ─────────────────────────────────────────────
    {
      name: 'route-discovery',
      testMatch: '**/08-route-discovery.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },

    // ── Suite 09: Action Discovery ────────────────────────────────────────────
    // Scans all 163+ routes and builds button-inventory.json
    {
      name: 'action-discovery',
      testMatch: '**/09-action-discovery.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
      timeout: 600_000,
    },

    // ── Suite 10: Safe Action Execution ──────────────────────────────────────
    // Tests filter/export/view/tab buttons — no data mutation
    {
      name: 'safe-actions',
      testMatch: '**/10-safe-actions.spec.ts',
      dependencies: ['action-discovery'],
      use: { storageState: AUTH_FILE },
      timeout: 600_000,
    },

    // ── Suite 11: Form Action Testing ─────────────────────────────────────────
    // Opens create/add forms, fills them, submits
    {
      name: 'form-actions',
      testMatch: '**/11-form-actions.spec.ts',
      dependencies: ['action-discovery'],
      use: { storageState: AUTH_FILE },
      timeout: 2400_000,
    },

    // ── Suite 12: Approval Workflow Testing ───────────────────────────────────
    // Tests approve/reject on all known approval pages
    {
      name: 'approval-workflows',
      testMatch: '**/12-approval-workflows.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
      timeout: 300_000,
    },

    // ── Suite 13: Dangerous Action Protection ─────────────────────────────────
    // Verifies delete/purge/archive require confirmation dialogs
    {
      name: 'dangerous-actions',
      testMatch: '**/13-dangerous-actions.spec.ts',
      dependencies: ['action-discovery'],
      use: { storageState: AUTH_FILE },
      timeout: 300_000,
    },

    // ── Suite 14: Dashboard Validation ────────────────────────────────────────
    // Validates all dashboards: charts render, cards drill-down
    {
      name: 'dashboard-validation',
      testMatch: '**/14-dashboard-validation.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
      timeout: 600_000,
    },

    // ── Suite 15: Action Audit Report Generator ───────────────────────────────
    // Generates HTML/CSV/MD reports from all action audit results
    {
      name: 'action-audit-report',
      testMatch: '**/15-action-audit-report.spec.ts',
      // No dependency — reads whatever result files exist
      use: { storageState: AUTH_FILE },
      timeout: 60_000,
    },
    {
      // Analytics & AI contract tests: KPI reconciliation, schema contract,
      // no-fabricated-values, filter plumbing and authorization.
      //
      // No `setup` dependency and no storageState: every test here drives the
      // API directly through Playwright's request context and mints its own
      // token, because part of what it asserts is what happens with a
      // LOW-PRIVILEGE token and with no token at all. Inheriting the shared
      // super-admin storageState would defeat the authorization group.
      name: 'analytics-contract',
      testMatch: '**/16-analytics-contract.spec.ts',
      timeout: 60_000,
    },
    {
      // Real browser pass over every page in the Analytics & AI menu: render,
      // console/exception cleanliness, deep link, reload, tabs, filters, and
      // the signed-out redirect. Needs the auth file, like the other UI projects.
      name: 'analytics-browser',
      testMatch: '**/18-analytics-browser.spec.ts',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
      timeout: 90_000,
    },
    {
      // Cross-tenant regression. Seeds a second company, sweeps every
      // Analytics & AI endpoint as an admin of each, tears the fixture down.
      // Like analytics-contract it carries no `setup` dependency and no
      // storageState: it mints its own tokens for two specific accounts, and
      // inheriting the super-admin session would not exercise the boundary.
      // Serial by construction (shared DB fixture) and slower than the others.
      name: 'tenant-isolation',
      testMatch: '**/17-tenant-isolation.spec.ts',
      timeout: 300_000,
      fullyParallel: false,
    },
    {
      // CRM pipeline reconciliation. Asserts the opportunity board renders the
      // same population /opportunities/stats counts — the check that neither a
      // silently-dropped stage nor a payload-shape change can pass. Must run in
      // a browser: both historical failures were API-correct and screen-wrong.
      name: 'crm-pipeline',
      testMatch: '**/19-crm-pipeline-reconciliation.spec.ts',
      dependencies: ['setup'],
      use: { storageState: 'tests/.auth/user.json' },
      timeout: 90_000,
    },
    {
      // Industrial IoT. Three of the Phase 4 defects were purely front-end and
      // API-correct — a late response overwriting the newly selected device, a
      // 500 rendering as "no devices found", and company KPIs computed from a
      // search-filtered list. None of them is reachable from an API test, which
      // is why this project exists. It intercepts routes deliberately: the only
      // way to test "a failure must not look like empty data" is to make the
      // call fail.
      name: 'iot',
      testMatch: '**/20-iot.spec.ts',
      dependencies: ['setup'],
      use: { storageState: 'tests/.auth/user.json' },
      timeout: 90_000,
    },
    {
      // Employees ▸ Dashboard. Most of what was wrong with this page was only
      // wrong on screen: a trend chart drawn from the months that happened to
      // contain a hire rather than from the selected period, KPI tiles that
      // looked clickable and were not, "View all" landing on the unfiltered
      // register, a tenure axis rendering mojibake, and the HR alert band
      // sitting below the fold. None of it is reachable from a unit test.
      name: 'employees-dashboard',
      testMatch: '**/21-employees-dashboard.spec.ts',
      dependencies: ['setup'],
      use: { storageState: 'tests/.auth/user.json' },
      timeout: 90_000,
    },
    {
      // Employees ▸ All Employees, from a COLD session: localStorage cleared, so the
      // DEFAULTS (20 rows per page, the default column set) are the product's and not
      // whatever suite 22 left behind — storageState carries localStorage between runs,
      // and suite 22 deliberately switches every column on.
      name: 'all-employees-acceptance',
      testMatch: '**/23-all-employees-acceptance.spec.ts',
      dependencies: ['setup'],
      use: { storageState: 'tests/.auth/user.json' },
      timeout: 90_000,
    },
    {
      // Administration ▸ Master Data. Proves the claim neither a unit test nor
      // an API test can: a value created from the Add Employee form's
      // "+ Add new…" is findable and manageable on the Master Data screen
      // afterwards. Spans two screens and the API between them.
      name: 'master-data',
      testMatch: '**/25-master-data.spec.ts',
      dependencies: ['setup'],
      use: { storageState: 'tests/.auth/user.json' },
      timeout: 90_000,
    },
    {
      // Employees ▸ Add Employee. The reported defect is a LAYOUT defect —
      // Department / Designation / Asset Type opened as a narrow horizontally
      // scrolling strip with the option text clipped to two or three
      // characters. Every one of those pickers rendered the right options and
      // posted the right value, so nothing below a real browser could see it.
      // Runs at 1280, 1440 and 1920 because the clipping was width-dependent:
      // at 1280 the 4-up grid gives each field only ~230px.
      name: 'add-employee',
      testMatch: '**/24-add-employee.spec.ts',
      dependencies: ['setup'],
      use: { storageState: 'tests/.auth/user.json' },
      timeout: 90_000,
    },
    {
      // Edit Employee = the Add Employee form in edit mode: the round trip
      // (edit → save → database → reopen) on the running stack.
      name: 'edit-employee',
      testMatch: '**/26-edit-employee.spec.ts',
      dependencies: ['setup'],
      use: { storageState: 'tests/.auth/user.json' },
      timeout: 120_000,
    },
    {
      // Employees ▸ All Employees. The register's defects were screen-only too:
      // the Manager column printed the literal text `null` (the column holds the
      // STRING 'null', which is truthy, so every falsy-check passed it through),
      // "Showing 20 of 32" with no rows-per-page control and no page numbers,
      // mandatory fields rendering as a neutral em-dash on 24 rows, and a bulk
      // status change that applied on one click.
      name: 'all-employees',
      testMatch: '**/22-all-employees.spec.ts',
      dependencies: ['setup'],
      use: { storageState: 'tests/.auth/user.json' },
      timeout: 90_000,
    },
  ],
});
