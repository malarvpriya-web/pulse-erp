/**
 * Suite 08 — Route Discovery & Gap Analysis
 *
 * Cross-checks three sources of truth:
 *   A. React Routes  — ALL_ROUTES / SMOKE_ROUTES from tests/helpers/routes.ts
 *   B. Sidebar Roles — role-filtered nav items (admin/manager/employee)
 *   C. API Modules   — backend route prefixes known from server.js
 *
 * Identifies:
 *   • Orphan routes   — in React router but NOT in sidebar nav
 *   • Hidden routes   — in React router, not reachable without direct URL
 *   • Unreachable     — smoke manifest missing routes that exist in sidebar
 *   • No-API routes   — UI page with no backend module behind it
 *
 * Output:
 *   tests/reports/route-gap-analysis.md
 *
 * Run:
 *   npx playwright test --project=route-discovery
 */

import { test, expect } from '../fixtures/base';
import { ALL_ROUTES }   from '../helpers/routes';
import {
  waitForPageLoad,
  assertNoErrorBoundary,
} from '../helpers/page-helpers';
import fs   from 'fs';
import path from 'path';

const BASE = 'http://localhost:5173';

// ─── Sidebar nav inventory (sourced from Sidebar.jsx / NAV_ITEMS) ─────────────
// These are the paths that appear in the sidebar for each role.

const SIDEBAR_ADMIN_PATHS: string[] = [
  '/', '/ApprovalCenter', '/NotificationCenter',
  '/CEOIntelligenceDashboard', '/ExecutiveDashboard', '/CFODashboard', '/HRBenchmarkingDashboard',
  '/HRDashboard', '/AdminDashboard', '/ERPIntelligence', '/SystemHealth',
  '/EmployeesDashboard', '/EmployeesData', '/ExEmployees',
  '/EmployeeDirectory', '/SuccessionCenter',
  '/SkillMatrix', '/EmployeeReports', '/EmployeeAssets', '/EmployeeDocuments',
  '/EmployeeSelfService', '/Announcements', '/Probation', '/Policies',
  '/Downloads', '/Offboarding', '/ExitManagement',
  '/PayrollCenter', '/Payroll',
  '/LearningDashboard', '/LearningDevelopment', '/LearningPaths',
  '/AssessmentCenter', '/CertificationManagement', '/CompetencyFramework',
  '/TrainerManagement', '/TrainingReports', '/LNDSettings',
  '/LiveWorkforceDashboard', '/AttendanceDashboard', '/QRAttendance',
  '/TeamAttendance', '/ShiftCalendar', '/RegularizationApprovals',
  '/OvertimeApprovals', '/AttendanceReportsHub',
  '/ShiftManagement', '/GeoFencing', '/AttendanceSettings', '/AttendanceAuditLogs',
  '/WorkCentres', '/ContractLabour', '/PayrollSync',
  '/MyLeaves', '/ApplyLeave', '/LeaveApprovals', '/TeamLeaves',
  '/LeaveCalendar', '/HolidayCalendar', '/CompOff', '/AllLeaves',
  '/LeaveReports', '/LeaveEncashment', '/LeaveSettings',
  '/FinanceDashboardNew', '/AccountingEngine', '/ReceivablesPage',
  '/PayablesPage', '/PaymentBatch', '/TaxManagement', '/BudgetManagement',
  '/FixedAssets', '/FinanceReports', '/Parties', '/FinanceSettings',
  '/RecruitmentDashboard', '/JobRequisitionPipeline', '/JobOpenings',
  '/AllCandidates', '/CandidatePipeline', '/InterviewScheduler',
  '/OfferManagement', '/OnboardingChecklist', '/EmailTemplates',
  '/HiringForecasts', '/EmployeeAutoCreation', '/RecruitmentSettings',
  '/ResumeDatabase', '/TalentPools', '/InterviewQuestionBank',
  '/RecruitmentAgencies', '/RecruiterDashboard',
  '/SalesDashboard', '/Leads', '/Accounts', '/Contacts',
  '/OpportunitiesKanban', '/Proposals', '/Customer360',
  '/SalesCommandCenter', '/SalesTargets', '/SalesConversionAnalytics',
  '/SalesAnalytics', '/SalesFunnel',
  '/PurchaseRequestDashboard', '/PurchaseOrders', '/GoodsReceipt',
  '/VendorManagement', '/Vendor360', '/VendorPortal',
  '/VendorRiskDashboard', '/VendorApprovalQueue', '/RFQManagement',
  '/ThreeWayMatch', '/ProcurementReports',
  '/InventoryDashboard', '/ItemMaster', '/StockMovements',
  '/WarehouseManagement', '/BatchTracking', '/SerialTracking',
  '/InventoryReports', '/AdvancedInventory',
  '/ProductionDashboard', '/ProductionOrders', '/BOMBuilder',
  '/ShopFloor', '/QualityDashboard', '/EngineeringDashboard', '/ECNManagement',
  '/ProjectsDashboard', '/ProjectDetail', '/KanbanBoard', '/GanttChart',
  '/ProjectCosting', '/ResourceManagement', '/ProjectReports',
  '/ProjectEVMDashboard', '/IssueManagement', '/FATTracker', '/SATTracker',
  '/AMCManagement', '/WarrantyManagement',
  '/OrgChart', '/AuditLogs',
  '/Timesheets', '/MyTimesheets',
  '/PerformanceDashboard', '/Feedback360', '/Increments',
  '/Promotions', '/OKRDashboard', '/KRAManagement', '/CalibrationCenter',
  '/PerformanceReports',
  '/MarketingDashboard', '/Campaigns', '/MarketingReports',
  '/TravelDashboard', '/MyTrips', '/TravelApprovals', '/CustomerVisits',
  '/TravelReimbursements', '/TravelDesk', '/TravelReports',
  '/ComplaintsDashboard', '/Complaints', '/SupportDashboard', '/ServiceDesk',
  '/VoiceOfCustomer', '/ServiceAnalytics', '/FailureAnalytics',
  '/CommissioningWorkflow',
  '/Reports', '/DocumentSigning', '/DocumentMaster',
  '/SettingsCenter', '/SystemSettings', '/IntegrationsHub',
  '/SetupCenter', '/AccessControl', '/WorkflowBuilder', '/CompanyProfile',
  '/BranchManagement',
  '/ProjectProfitabilityDashboard', '/Project360', '/CEOCommandCenter',
];

const SIDEBAR_EMPLOYEE_PATHS: string[] = [
  '/', '/NotificationCenter', '/ApprovalCenter',
  '/AttendanceDashboard', '/MyLeaves', '/ApplyLeave', '/LeaveCalendar',
  '/CompOff', '/HolidayCalendar',
  '/TravelDashboard', '/MyTrips',
  '/SupportDashboard', '/ServiceDesk',
  '/EmployeeSelfService',
  '/Timesheets', '/MyTimesheets',
  '/PerformanceDashboard', '/Feedback360',
];

// ─── Backend API modules ──────────────────────────────────────────────────────
const API_MODULE_PREFIXES = [
  'employees', 'auth', 'home', 'notes', 'announcements', 'probation',
  'leaves', 'comp-off', 'leave-encashment', 'leave-accrual',
  'finance', 'statements', 'accounting', 'gst', 'tds', 'budgets',
  'fixed-assets', 'forex',
  'procurement', 'vendors', 'rfqs', 'inventory', 'warehouse', 'logistics',
  'bom', 'production', 'quality',
  'projects', 'tasks', 'gantt', 'project-members',
  'timesheets', 'performance', 'recruitment', 'talent',
  'attendance', 'holidays', 'payroll', 'salary-structures',
  'hr', 'training', 'certifications', 'learning-paths', 'assessments',
  'succession', 'onboarding', 'exit',
  'crm', 'sales', 'sales-command-center', 'pricing', 'commissions', 'marketing',
  'master', 'operations', 'maintenance', 'workflows', 'admin',
  'settings', 'company-profile', 'branches',
  'travel', 'customer-visits', 'reimbursement', 'travel-policy',
  'vendor-portal', 'vendor-360', 'vendor-registration', 'vendor-approval', 'vendor-health',
  'project-profitability', 'project-360',
  'reports', 'documents', 'signatures', 'notifications', 'audit',
  'orgchart', 'approvals', 'dashboard', 'servicedesk', 'complaints',
  'customer-portal', 'commissioning', 'service-analytics', 'failure-analytics',
  'global-search', 'engineering', 'ai', 'intelligence', 'ceo-intelligence',
  'analytics', 'recruitment-analytics',
];

// ─── Analysis helpers ─────────────────────────────────────────────────────────

interface RouteGap {
  type:        'orphan' | 'missing-smoke' | 'unreachable' | 'no-api-module';
  path:        string;
  module?:     string;
  severity?:   string;
  description: string;
}

function analyzeGaps(): {
  smokeTotal:    number;
  sidebarTotal:  number;
  apiTotal:      number;
  orphans:       RouteGap[];
  missingSmoke:  RouteGap[];
  noApiModules:  RouteGap[];
  coverage:      { smoke: string; sidebar: string };
} {
  const smokePaths   = new Set(ALL_ROUTES.map(r => r.path));
  const sidebarPaths = new Set(SIDEBAR_ADMIN_PATHS);

  // Orphan routes — in smoke manifest but NOT in sidebar
  const orphans: RouteGap[] = ALL_ROUTES
    .filter(r => !sidebarPaths.has(r.path))
    .map(r => ({
      type:        'orphan' as const,
      path:        r.path,
      module:      r.module,
      severity:    r.severity,
      description: `Route in smoke manifest but not in sidebar nav (accessible only via direct URL)`,
    }));

  // Missing from smoke — in sidebar but not smoke-tested
  const missingSmoke: RouteGap[] = SIDEBAR_ADMIN_PATHS
    .filter(p => !smokePaths.has(p))
    .map(p => ({
      type:        'missing-smoke' as const,
      path:        p,
      description: `Sidebar nav path has no smoke test coverage`,
    }));

  // No API module — UI paths with no obvious backend module
  const noApiHeuristic = (path: string): boolean => {
    // Very basic heuristic: path suggests a module, check it's in API list
    const seg = path.replace('/', '').split('/')[0].toLowerCase();
    if (!seg) return false;
    // Check partial match
    return !API_MODULE_PREFIXES.some(m =>
      seg.includes(m.split('-')[0]) ||
      m.includes(seg)
    );
  };

  const noApiModules: RouteGap[] = ALL_ROUTES
    .filter(r => noApiHeuristic(r.path))
    .slice(0, 20) // cap at 20 for readability
    .map(r => ({
      type:        'no-api-module' as const,
      path:        r.path,
      module:      r.module,
      description: `No backend API module found matching this route segment`,
    }));

  const smokeCoverage   = ((smokePaths.size / (smokePaths.size + missingSmoke.length)) * 100).toFixed(1);
  const sidebarCoverage = ((smokePaths.size / sidebarPaths.size) * 100).toFixed(1);

  return {
    smokeTotal:   ALL_ROUTES.length,
    sidebarTotal: SIDEBAR_ADMIN_PATHS.length,
    apiTotal:     API_MODULE_PREFIXES.length,
    orphans,
    missingSmoke,
    noApiModules,
    coverage: { smoke: `${smokeCoverage}%`, sidebar: `${sidebarCoverage}%` },
  };
}

function buildMarkdown(gaps: ReturnType<typeof analyzeGaps>): string {
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const orphanRows = gaps.orphans.length
    ? gaps.orphans.map(g => `| \`${g.path}\` | ${g.module ?? '—'} | ${g.severity ?? '—'} | ${g.description} |`).join('\n')
    : '| — | — | — | No orphan routes detected |';

  const missingSmokeRows = gaps.missingSmoke.length
    ? gaps.missingSmoke.map(g => `| \`${g.path}\` | ${g.description} |`).join('\n')
    : '| — | Full sidebar coverage ✅ |';

  const noApiRows = gaps.noApiModules.length
    ? gaps.noApiModules.map(g => `| \`${g.path}\` | ${g.module ?? '—'} | ${g.description} |`).join('\n')
    : '| — | — | All routes have corresponding API modules |';

  return `# Route Gap Analysis — Pulse ERP
Generated: ${now} IST

## Summary

| Metric | Count |
|--------|-------|
| React smoke-tested routes | ${gaps.smokeTotal} |
| Sidebar admin nav paths | ${gaps.sidebarTotal} |
| Backend API modules | ${gaps.apiTotal} |
| Orphan routes (smoke but not in sidebar) | ${gaps.orphans.length} |
| Missing smoke tests (sidebar paths not tested) | ${gaps.missingSmoke.length} |
| Routes with no clear API module | ${gaps.noApiModules.length} |
| Smoke coverage of sidebar routes | ${gaps.coverage.sidebar} |

## Orphan Routes
Routes that exist in the smoke test manifest but are **not linked from the sidebar navigation**.
These are reachable via direct URL but may be undiscoverable to users.

| Path | Module | Severity | Note |
|------|--------|----------|------|
${orphanRows}

## Missing Smoke Coverage
Sidebar nav paths that **have no Playwright smoke test**. These could silently break.

| Path | Reason |
|------|--------|
${missingSmokeRows}

## Routes with No Clear API Module
UI routes where no corresponding backend API module was identified.
These may be purely frontend pages, or the module mapping could be missing.

| Path | Module | Reason |
|------|--------|--------|
${noApiRows}

## Role Coverage

| Role | Paths accessible | % of all routes |
|------|-----------------|-----------------|
| Admin / Super Admin | ${SIDEBAR_ADMIN_PATHS.length} | ${((SIDEBAR_ADMIN_PATHS.length / gaps.smokeTotal) * 100).toFixed(1)}% |
| Employee | ${SIDEBAR_EMPLOYEE_PATHS.length} | ${((SIDEBAR_EMPLOYEE_PATHS.length / gaps.smokeTotal) * 100).toFixed(1)}% |

## Recommendations

${gaps.missingSmoke.length > 10
  ? `⚠️  **${gaps.missingSmoke.length} sidebar paths lack smoke tests.** Priority: add P0 smoke tests for critical paths.`
  : `✅  Smoke test coverage is acceptable (${gaps.coverage.sidebar} of sidebar routes covered).`}

${gaps.orphans.length > 20
  ? `ℹ️  **${gaps.orphans.length} orphan routes** detected — these are only accessible via direct URL. Verify they have proper auth guards.`
  : `✅  Orphan route count is manageable.`}

---
*Generated by Pulse ERP Test Suite — Suite 08 Route Discovery*
`;
}

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

test('@P0 [ROUTE-DISCOVERY] Route gap analysis generates report', async () => {
  fs.mkdirSync('tests/reports', { recursive: true });

  const gaps = analyzeGaps();
  const md   = buildMarkdown(gaps);

  fs.writeFileSync('tests/reports/route-gap-analysis.md', md, 'utf8');

  console.log(`\n📊 Route Gap Analysis → tests/reports/route-gap-analysis.md`);
  console.log(`   Smoke: ${gaps.smokeTotal} routes | Sidebar: ${gaps.sidebarTotal} | Orphans: ${gaps.orphans.length} | Missing smoke: ${gaps.missingSmoke.length}`);

  // Fail if coverage drops below 60%
  const sidebarCoverageNum = (gaps.smokeTotal / gaps.sidebarTotal) * 100;
  expect(sidebarCoverageNum, `Route coverage too low: ${sidebarCoverageNum.toFixed(1)}% (minimum 60%)`).toBeGreaterThanOrEqual(60);
});

test('@P0 [ROUTE-DISCOVERY] All P0 routes are in smoke manifest', async () => {
  const p0Routes = ALL_ROUTES.filter(r => r.severity === 'P0');
  expect(p0Routes.length, 'There should be P0 routes defined').toBeGreaterThan(0);

  const paths = p0Routes.map(r => r.path);
  const criticalPaths = ['/', '/ApprovalCenter', '/EmployeesData', '/MyLeaves', '/FinanceDashboardNew'];

  for (const cp of criticalPaths) {
    expect(paths, `Critical route ${cp} must be in P0 smoke manifest`).toContain(cp);
  }
});

test('@P0 [ROUTE-DISCOVERY] No duplicate paths in smoke manifest', async () => {
  const paths = ALL_ROUTES.map(r => r.path);
  const seen  = new Set<string>();
  const dups: string[] = [];

  for (const p of paths) {
    if (seen.has(p)) dups.push(p);
    seen.add(p);
  }

  if (dups.length) {
    test.info().annotations.push({
      type: 'warning',
      description: `Duplicate route paths: ${dups.join(', ')}`,
    });
  }

  expect(dups.length, `Duplicate paths found in smoke manifest: ${dups.join(', ')}`).toBe(0);
});

test('@P1 [ROUTE-DISCOVERY] All modules have at least one P0 route', async () => {
  const moduleMap = new Map<string, boolean>();

  for (const r of ALL_ROUTES) {
    if (r.severity === 'P0') moduleMap.set(r.module, true);
    else if (!moduleMap.has(r.module)) moduleMap.set(r.module, false);
  }

  const modulesWithoutP0 = [...moduleMap.entries()]
    .filter(([, hasP0]) => !hasP0)
    .map(([mod]) => mod);

  test.info().annotations.push({
    type: modulesWithoutP0.length ? 'warning' : 'info',
    description: modulesWithoutP0.length
      ? `Modules with no P0 route: ${modulesWithoutP0.join(', ')}`
      : 'All modules have at least one P0 route',
  });
});

test('@P1 [ROUTE-DISCOVERY] Employee-role paths are a subset of admin paths', async () => {
  const adminSet = new Set(SIDEBAR_ADMIN_PATHS);
  const notInAdmin = SIDEBAR_EMPLOYEE_PATHS.filter(p => !adminSet.has(p));

  if (notInAdmin.length) {
    test.info().annotations.push({
      type: 'warning',
      description: `Employee paths not in admin nav: ${notInAdmin.join(', ')}`,
    });
  }

  expect(notInAdmin.length, `Employee-only paths should be accessible to admin too: ${notInAdmin.join(', ')}`).toBe(0);
});

test('@P1 [ROUTE-DISCOVERY] Validate 10 random sidebar paths are actually reachable', async ({ page }) => {
  const sample = SIDEBAR_ADMIN_PATHS
    .filter(p => !p.includes(':'))  // skip dynamic paths
    .sort(() => Math.random() - 0.5)
    .slice(0, 10);

  const unreachable: string[] = [];

  for (const path of sample) {
    await page.goto(`${BASE}${path}`, { timeout: 20_000 }).catch(() => null);
    await waitForPageLoad(page).catch(() => null);

    const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    const crashed  = bodyText.includes('Something went wrong') || bodyText.includes('404');

    if (crashed) {
      unreachable.push(path);
      test.info().annotations.push({
        type: 'critical',
        description: `Path ${path} is UNREACHABLE or crashes`,
      });
    }
  }

  test.info().annotations.push({
    type: 'info',
    description: `Sampled ${sample.length} paths: ${sample.length - unreachable.length} reachable, ${unreachable.length} broken`,
  });

  expect(unreachable.length, `Unreachable sidebar paths: ${unreachable.join(', ')}`).toBe(0);
});
