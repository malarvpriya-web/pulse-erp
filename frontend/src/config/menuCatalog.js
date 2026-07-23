/**
 * menuCatalog.js — the list of navigable sections used by the
 * "Access Control → Page Access" screen, and the page→section lookup used to
 * enforce those overrides at the route level.
 *
 * Sections mirror exactly what the Sidebar renders (top-level NAV groups), so an
 * admin configures visibility against the same units a user actually sees.
 *
 * Override keys are the group `name` (e.g. 'Finance', 'HR', 'Service Desk').
 */

import { NAV_ITEMS } from './routes';

// Sections that can never be restricted (safety — users must keep a way home).
export const ALWAYS_VISIBLE = new Set(['Home']);

// Sections that hold the screens used to undo a bad access change — protected
// so an admin cannot accidentally lock themselves out of the very screens
// needed to fix it. 'Settings' holds Access Control; 'User Management' holds
// the same Users / Roles / Approver screens as direct entries.
export const SELF_SERVICE_LOCK = new Set(['Settings', 'User Management']);

/** Extract the page key from a submenu/child entry (handles both NAV shapes). */
function entryPage(entry) {
  if (!entry || entry.separator) return null;
  return entry.page || entry.name || null;
}

function entryLabel(entry) {
  return entry?.label || entry?.name || entryPage(entry) || '';
}

/**
 * Returns the configurable sections:
 *   [{ name, page?, pages: [{ page, label }] }]
 */
export function getMenuSections() {
  return NAV_ITEMS
    .filter(g => g && g.name && !ALWAYS_VISIBLE.has(g.name))
    .map(g => {
      const pages = [];
      if (g.page) pages.push({ page: g.page, label: g.name });
      const subs = g.submenu || g.children || [];
      for (const s of subs) {
        const page = entryPage(s);
        if (page) pages.push({ page, label: entryLabel(s) });
      }
      return { name: g.name, page: g.page || null, pages };
    });
}

/**
 * Given a ROUTES page key, returns the NAV section name it belongs to
 * (or null if the page is not part of any sidebar section).
 */
export function getSectionForPage(page) {
  if (!page) return null;
  for (const g of NAV_ITEMS) {
    if (!g || !g.name) continue;
    if (g.page === page) return g.name;
    const subs = g.submenu || g.children || [];
    for (const s of subs) {
      if (entryPage(s) === page) return g.name;
    }
  }
  return null;
}

// ── Employee self-service scoping ──────────────────────────────────────────
// The employee role shares these menus with managers/admins, but employees may
// only reach the self-service pages inside them — never the management/admin
// pages (payroll runs, approvals, SLA config, policy engines, reports, etc.).
export const EMPLOYEE_RESTRICTED_SECTIONS = new Set([
  'HR', 'Service Desk', 'Travel Desk', 'Attendance', 'Leaves', 'Timesheets',
  'Performance',
]);

export const EMPLOYEE_SELF_SERVICE_PAGES = new Set([
  // HR ('Announcements' intentionally excluded — disabled for employee self-service)
  'Policies', 'Downloads', 'EmployeeSelfService',
  'EmployeeDocuments', 'EmployeeAssets', 'SkillMatrix',
  // HR — company phonebook. employee.routes.js's GET /employees/directory
  // carries only `verifyToken`, no allowRoles: the backend's own
  // DIRECTORY_PHONE_ROLES set already documents "regular employees" as an
  // expected caller (they just get `phone` redacted server-side).
  'EmployeeDirectory',
  // Service Desk ('KnowledgeBase' intentionally excluded — admin-only page)
  'MyTickets',
  // Travel Desk ('TravelPayment'/'TravelAudit' intentionally excluded — finance-only)
  'TravelRequests', 'ExpenseClaims', 'VisitReports', 'TravelCalendar',
  'TravelAdvances', 'TravelBookings', 'TravelEntry',
  // Attendance
  'AttendanceDashboard', 'QRAttendance', 'ShiftCalendar',
  // Leaves
  'MyLeaves', 'ApplyLeave', 'LeaveCalendar', 'HolidayCalendar',
  'CompOff', 'LeaveEncashment',
  // Timesheets
  'MyTimesheet', 'MyAnalytics',
  // Performance ('TeamPerformance'/'PerformanceSettings'/'OKRManagement'/
  // 'KRAManagement'/'ReviewCycleManager'/'CalibrationCenter'/'IncrementPlanning'/
  // 'PromotionPlanning'/'PerformanceReports' intentionally excluded — manager/HR-only)
  'PerformanceReviews', 'Goals', 'Feedback360',
]);

// True if an employee may render `page`. Pages inside a shared (restricted)
// menu are allowed only when they are self-service; pages outside those menus
// are governed by the normal module / Page-Access gates.
export function canEmployeeAccessPage(page) {
  const section = getSectionForPage(page);
  if (section && EMPLOYEE_RESTRICTED_SECTIONS.has(section)) {
    return EMPLOYEE_SELF_SERVICE_PAGES.has(page);
  }
  return true;
}

// ── Finance scoping within the shared 'Leaves'/'Attendance' menus ─────────
// Finance gets its own domain in full (the entire 'Finance' section), but
// when its allowlist below also grants it the shared Leaves/Attendance
// sections, it may reach only the self-service pages inside them — never
// leave approvals, team views, or attendance admin/config screens. Mirrors
// the employee self-service pattern above.
export const FINANCE_RESTRICTED_SECTIONS = new Set(['Leaves', 'Attendance']);

export const FINANCE_SELF_SERVICE_PAGES = new Set([
  // Leaves ('Leave Approvals'/'Team Leaves'/'All Leaves'/'Leave Reports'/
  // 'Encashment'/'Leave Settings' intentionally excluded)
  'MyLeaves', 'ApplyLeave', 'LeaveCalendar', 'HolidayCalendar', 'CompOff',
  // Attendance ('Live Workforce'/'Team Attendance'/'Shift Calendar'/
  // 'Regularization'/'Overtime'/etc. intentionally excluded)
  'AttendanceDashboard', 'QRAttendance',
]);

// True if the finance role may render `page`. Pages inside a shared
// (restricted) menu are allowed only when they are self-service; pages
// outside those menus (including the whole 'Finance' section) are governed
// by the normal section allowlist / module gates.
export function canFinanceAccessPage(page) {
  const section = getSectionForPage(page);
  if (section === 'Analytics & AI') {
    return FINANCE_ANALYTICS_SCOPED_PAGES.has(page);
  }
  if (section && FINANCE_RESTRICTED_SECTIONS.has(section)) {
    return FINANCE_SELF_SERVICE_PAGES.has(page);
  }
  return true;
}

// ── HR scoping within the shared 'Analytics & AI' menu ─────────────────────
// HR's allowlist below includes 'Analytics & AI' only for its own two
// dashboards (HR Dashboard, HR Benchmarking) — never the CEO/CFO/Ops/
// Executive/ERP-Intelligence/System-Health pages that share the section.
// Mirrors the employee self-service pattern above: the section is
// allowlisted, but only these pages inside it are reachable by hr.
export const HR_RESTRICTED_SECTIONS = new Set(['Analytics & AI']);

export const HR_SCOPED_PAGES = new Set(['HRDashboard', 'HRBenchmarkingDashboard']);

// True if the hr role may render `page`. Pages inside a shared (restricted)
// menu are allowed only when hr-scoped; pages outside those menus are
// governed by the normal section allowlist / module gates.
export function canHrAccessPage(page) {
  const section = getSectionForPage(page);
  if (section && HR_RESTRICTED_SECTIONS.has(section)) {
    return HR_SCOPED_PAGES.has(page);
  }
  return true;
}

// ── Finance scoping within the shared 'Analytics & AI' menu ────────────────
// Finance's allowlist below now also includes 'Analytics & AI', but only for
// the CFO Dashboard — never the CEO/Ops/Executive/HR/ERP-Intelligence/
// System-Health pages that share the section. Kept as its own constant
// (rather than folded into FINANCE_RESTRICTED_SECTIONS/FINANCE_SELF_SERVICE_
// PAGES below, which govern the unrelated Leaves/Attendance self-service
// downgrade) so canFinanceAccessPage can special-case it without conflating
// the two restrictions.
export const FINANCE_ANALYTICS_SCOPED_PAGES = new Set(['CFODashboard']);

// ── Manager scoping within the shared 'Analytics & AI' menu ────────────────
// manager's allowlist below now also includes 'Analytics & AI', but only for
// the Executive Dashboard (ExecutiveDashboard.jsx itself gates on
// roles={['super_admin', 'admin', 'manager']}) — never the CEO/CFO/Ops/HR/
// ERP-Intelligence/System-Health pages that share the section.
export const MANAGER_ANALYTICS_SCOPED_PAGES = new Set(['ExecutiveDashboard']);

// ── Manager scoping within the shared 'HR' menu ────────────────────────────
// manager's allowlist below now also includes 'HR', but only for Employee
// Directory — never Payroll Center, Offboarding, Exit Management, etc., which
// stay hr-tier-only. employee.routes.js's DIRECTORY_PHONE_ROLES already lists
// 'manager' as someone who should see the phone field, so the backend already
// expected managers to reach this page; the section allowlist was the only
// thing not granting it.
export const MANAGER_HR_SCOPED_PAGES = new Set(['EmployeeDirectory']);

// True if the manager role may render `page`. Mirrors canHrAccessPage/
// canFinanceAccessPage above.
export function canManagerAccessPage(page) {
  const section = getSectionForPage(page);
  if (section === 'Analytics & AI') {
    return MANAGER_ANALYTICS_SCOPED_PAGES.has(page);
  }
  if (section === 'HR') {
    return MANAGER_HR_SCOPED_PAGES.has(page);
  }
  return true;
}

// ── hr_exec scoping within the shared 'HR' menu ────────────────────────────
// hr_exec's allowlist below grants the full 'HR' section (Employee Directory,
// Offboarding, etc.), but role_permissions explicitly denies it 'payroll'
// (unlike hr_manager and payroll_admin, who both get it) — Payroll Center
// must stay unreachable even though it lives in the same submenu.
export const HR_EXEC_EXCLUDED_PAGES = new Set(['PayrollCenter']);

export function canHrExecAccessPage(page) {
  return !HR_EXEC_EXCLUDED_PAGES.has(page);
}

// ── Admin-only pages ────────────────────────────────────────────────────────
// Pages visible ONLY to super_admin and admin, regardless of module grants —
// hidden from the sidebar and blocked at the route level for every other role.
export const ADMIN_ONLY_PAGES = new Set(['KnowledgeBase']);

export function canRoleAccessAdminOnlyPage(role, page) {
  if (!ADMIN_ONLY_PAGES.has(page)) return true;
  return role === 'super_admin' || role === 'admin';
}

// ── Super-admin-only pages ──────────────────────────────────────────────────
// System-governance pages reserved for super_admin — hidden from EVERY other
// role, INCLUDING admin (so an admin cannot manage roles/users, escalate
// privileges, or reach raw system tooling). Enforced in the sidebar (submenu
// filter) and at the route level (direct-URL block).
export const SUPER_ADMIN_ONLY_PAGES = new Set([
  'AccessControl',      // Users · Roles · Approvers · Security hub
  'RolesSetup',
  'UserSetup',
  'SecurityCenter',
  'DatabaseTest',
  'OrganizationSetup',
]);

export function canRoleAccessSuperAdminPage(role, page) {
  if (!SUPER_ADMIN_ONLY_PAGES.has(page)) return true;
  return role === 'super_admin';
}

// ── Per-role section allowlists (explicit, hidden-by-default) ────────────────
// The sidebar shows a role ONLY the top-level NAV sections listed here. Any
// section not listed is hidden, and the matching pages are blocked at the route
// level. super_admin/admin are intentionally absent — they are governed
// separately (super_admin sees all; admin sees all except SUPER_ADMIN_ONLY).
// Section names must match NAV_ITEMS `name` values exactly.
export const ROLE_SECTION_ALLOWLIST = {
  // 'Analytics & AI' is scoped to the Executive Dashboard only — see
  // MANAGER_ANALYTICS_SCOPED_PAGES / canManagerAccessPage above.
  // 'Travel Desk' granted in full: backend already trusts manager with
  // TRAVEL_APPROVE_ROLES (approve/reject requests), ADVANCE_MANAGER_ROLES
  // (advance manager-review) and AUDIT_ROLES (travel audit log) — see
  // travel.routes.js / travel-audit.routes.js. Before this, TravelApprovals/
  // ExpenseReview/TravelAdvances(disburse)/TravelAudit were unreachable by any
  // role that could actually call those endpoints (only super_admin/admin
  // could open the section). No extra page-level scoping needed: each page
  // already conditions its finance-only/manager-only actions on the caller's
  // role (e.g. TravelAdvances.jsx's disburse button).
  // 'HR' is scoped to Employee Directory only — see MANAGER_HR_SCOPED_PAGES /
  // canManagerAccessPage above.
  // 'Operations'/'e-Signatures' (F17 open-items pass, 2026-07-23 — see
  // ROLE_SIDEBAR_REACHABILITY_AUDIT.md): neither carries a `module` key in
  // routes.jsx, and neither backend route (operations/lifecycle.routes.js;
  // documents/signatures.routes.js, documentMaster.routes.js) calls
  // requirePermission anywhere — verifyToken only. Permission-less, same
  // shape as QR Codes/Org Chart, so granted to manager/department_head as
  // the existing broadest cross-departmental allowlists rather than left
  // unreachable for every role.
  manager: [
    'Home', 'Approvals', 'Employees', 'Attendance', 'Leaves', 'Timesheets',
    'Performance', 'Projects', 'Recruitment', 'Reports', 'QR Codes',
    'Notifications', 'Org Chart', 'Analytics & AI', 'Travel Desk', 'HR',
    'Operations', 'e-Signatures',
  ],
  // department_head = manager-tier lead of an operational team (warehouse,
  // production or service), not an office function — manager's baseline plus
  // the domain sections their team actually works in. Backend role_permissions
  // already grants department_head view/add/edit/approve/export on inventory,
  // production and servicedesk (see 20260721000001_department_head_operational_grants.js),
  // so these sections are live, not more dead links.
  // 'Operations' — see manager comment above (F17 pass); permission-less,
  // added for parity as the other broad cross-departmental allowlist.
  department_head: [
    'Home', 'Approvals', 'Employees', 'Attendance', 'Leaves', 'Timesheets',
    'Performance', 'Projects', 'Recruitment', 'Reports', 'QR Codes',
    'Notifications', 'Org Chart', 'Inventory', 'Production', 'Service Desk',
    'Operations',
  ],
  // 'Travel Desk' granted in full: backend trusts hr with TRAVEL_APPROVE_ROLES
  // (approve/reject requests) and ADVANCE_MANAGER_ROLES (advance
  // manager-review) — see travel.routes.js. Not in AUDIT_ROLES, so TravelAudit
  // stays a 403 for hr at the API even though the section is now reachable;
  // that's the same shape as every other shared-section grant in this file.
  // 'Compliance · More'/'Asset Register · More':
  // 20260719000001_seed_role_permission_gaps.js granted hr view-only
  // compliance ("HR owns some certification evidence") and view-only assets
  // ("employee asset allocation") — see the procurement_manager comment below
  // for why these are the orphans' exact names rather than a curated section.
  hr: [
    'Home', 'Approvals', 'Employees', 'HR', 'Learning Center', 'Attendance',
    'Leaves', 'Timesheets', 'Performance', 'Recruitment', 'Talent', 'Reports',
    'QR Codes', 'Notifications', 'Org Chart', 'Analytics & AI', 'Travel Desk',
    'Compliance · More', 'Asset Register · More',
  ],
  // 'Analytics & AI' is scoped to the CFO Dashboard only — see
  // FINANCE_ANALYTICS_SCOPED_PAGES / canFinanceAccessPage above.
  // 'Travel Desk' granted in full: backend trusts finance with AUDIT_ROLES
  // (travel audit log) and ADVANCE_FINANCE_ROLES (advance finance-review +
  // disburse + payment posting) — see travel.routes.js / travel-audit.routes.js.
  // Not in TRAVEL_APPROVE_ROLES, so TravelApprovals'/ExpenseReview's status
  // action stays a 403 for finance at the API even though the section is now
  // reachable.
  finance: [
    'Home', 'Approvals', 'Finance', 'Leaves', 'Attendance', 'Reports',
    'QR Codes', 'Notifications', 'Org Chart', 'Analytics & AI', 'Travel Desk',
  ],
  employee: [
    'Home', 'Attendance', 'Leaves', 'Travel Desk', 'Service Desk', 'HR',
    'Timesheets', 'QR Codes', 'Performance',
  ],
  // Phase-42 granular HR seats (20260529000001_phase42_security_roles.js).
  // Scoped from what role_permissions actually grants each code: hr_manager
  // has recruitment/training/timesheets/reports in full, hr_exec has them
  // view/add/edit but no payroll, payroll_admin has full payroll but no
  // recruitment/training/timesheets. 'Employees' (the manager-facing
  // dashboard) is intentionally excluded — none of the three hold that
  // permission; they work employee records through HR → Employee Directory.
  // 'e-Signatures' (F17 pass): permission-less, see the manager comment
  // above; hr_manager owns offer-letter/onboarding-document signing.
  hr_manager: [
    'Home', 'Approvals', 'HR', 'Learning Center', 'Recruitment', 'Talent',
    'Attendance', 'Leaves', 'Timesheets', 'Performance', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes', 'e-Signatures',
  ],
  hr_exec: [
    'Home', 'Approvals', 'HR', 'Learning Center', 'Recruitment', 'Talent',
    'Attendance', 'Leaves', 'Timesheets', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes',
  ],
  payroll_admin: [
    'Home', 'Approvals', 'HR', 'Attendance', 'Leaves', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes',
  ],
  // Phase-42 granular finance seats (20260529000001_phase42_security_roles.js).
  // Both hold 'Finance'/'Reports' via the module-permission fallback
  // (role_permissions grants finance_manager full finance+accounting+gst+tds,
  // accounts_exec view/add/edit finance with no GL/TDS). 'Approvals' and
  // 'Notifications' are now ALSO covered by that same fallback — their
  // NAV_ITEMS entries carry `module: 'approvals'`/`'notifications'` and
  // [20260721000002_granular_role_approvals_notifications_grants.js] grants
  // both roles a role_permissions row (finance_manager VAEP/VAE as an
  // APPROVER_ROLES member, accounts_exec VA/V as an executor). Listed here
  // too — redundant with the fallback but harmless — so the grant stays
  // visible without cross-referencing role_permissions.
  finance_manager: [
    'Home', 'Approvals', 'Finance', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes',
  ],
  accounts_exec: [
    'Home', 'Approvals', 'Finance', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes',
  ],
  // Phase-42 project-delivery seat (20260529000001_phase42_security_roles.js
  // grants projects/timesheets/reports/documents/master/analytics;
  // [20260721000002_granular_role_approvals_notifications_grants.js] later
  // filled the approvals/notifications gap — project_manager is APPROVER_TIER
  // there, matching its APPROVER_ROLES membership in approvals.authz.js). All
  // six of Projects/Timesheets/Reports/Approvals/Notifications now resolve
  // true via the module-permission fallback; listed here too — redundant with
  // the fallback but harmless — so the grant stays visible without
  // cross-referencing role_permissions, mirroring finance_manager/
  // accounts_exec above. QR Codes/Org Chart (no `module` key on either
  // NAV_ITEMS entry, so unreachable via fallback for any role) added for
  // parity with every other management-tier allowlist in this object.
  // 'R&D · More': 20260719000001_seed_role_permission_gaps.js granted
  // project_manager view-only rd — see the procurement_manager comment below
  // for why orphan modules from that migration are listed by exact synthetic
  // name instead of a curated section.
  // 'Approvals' REMOVED (F16 role-reconciliation pass, 2026-07-22):
  // project_manager was dropped from approvals.authz.js's APPROVER_ROLES —
  // none of the shared Approval Center pool's categories (leave/
  // regularization/OT/purchase request/expense/ECN/payment) are this role's
  // domain, so the section only ever dead-ended every action button on
  // Unauthorized. Same shape as l2_approver having no Approvals section.
  project_manager: [
    'Home', 'Projects', 'Timesheets', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes', 'R&D · More',
  ],
  // Phase-42 granular sales seats (20260529000001_phase42_security_roles.js).
  // CRM/Sales/Marketing are the one curated group with NO `module` key on their
  // NAV_ITEMS entries (routes.jsx) — unlike Finance/Procurement/Inventory/
  // Projects/etc., which all carry one. With `item.module` undefined,
  // isMenuVisible's permission-driven fallback returns false unconditionally,
  // so sales_manager/sales_exec could reach only Home no matter what
  // role_permissions granted them. sales_manager holds FULL crm+sales and VEXP
  // reports, plus VAEP approvals/VAE notifications as an APPROVER_TIER member
  // [20260721000002_granular_role_approvals_notifications_grants.js]. 'Marketing'
  // has no role_permissions module of its own — its pages call crm-gated
  // endpoints (see crm.routes.js GET /marketing-dashboard) — so it's granted
  // here as a frontend-only entry.
  // sales_exec holds VAE crm / view+add+edit sales (no approve — no
  // pricing-approval authority) and VA approvals/V notifications as an
  // EXEC_TIER member, but NONE on reports/analytics — Reports and Marketing
  // are intentionally excluded for it, not an oversight.
  // 'Approvals' REMOVED from sales_manager (F16 role-reconciliation pass,
  // 2026-07-22) — dropped from approvals.authz.js's APPROVER_ROLES, see the
  // project_manager comment above for why.
  // 'e-Signatures' (F17 pass): permission-less, see the manager comment
  // above; sales_manager owns sales-contract signing.
  // 'Tenders · More' (F17 pass): TenderWorkspace.jsx is an autoRouter.js
  // orphan carrying `module: 'crm'` through from FOLDER_CONFIG —
  // tenders.routes.js is gated on that same `crm` permission ("a tender IS
  // an opportunity"). sales_manager/sales_exec already hold FULL/VAE crm
  // respectively, but — same as every other orphan — the module-permission
  // fallback never fires for an allowlisted role unless the exact orphan
  // name is also listed here.
  sales_manager: [
    'Home', 'CRM', 'Sales', 'Marketing', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes', 'e-Signatures', 'Tenders · More',
  ],
  sales_exec: [
    'Home', 'Approvals', 'CRM', 'Sales',
    'Notifications', 'Org Chart', 'QR Codes', 'Tenders · More',
  ],
  // Phase-42 granular procurement seats (20260529000001_phase42_security_roles.js).
  // procurement_manager holds FULL procurement, view/add/edit/delete/approve
  // inventory + view/add/edit/delete warehouse (WarehouseManagement lives as a
  // submenu page under 'Inventory', not its own top-level section) and VEXP
  // reports — APPROVER_TIER in [20260721000002_granular_role_approvals_
  // notifications_grants.js], so also Approvals VAEP/Notifications VAE.
  // procurement_exec is VAE procurement + view-only inventory/warehouse, no
  // reports — EXEC_TIER (Approvals VA/Notifications V).
  // 'Asset Register · More' (both): AssetRegister.jsx has no curated NAV_ITEMS
  // entry, so it only exists as an autoRouter.js orphan group under this exact
  // synthetic name (module: 'assets' carried through from FOLDER_CONFIG).
  // 20260719000001_seed_role_permission_gaps.js seeded real 'assets'
  // permissions for procurement_manager/procurement_exec/store_keeper two days
  // later than that migration's own dating suggests, but none of the three
  // could ever see it: Sidebar.jsx's isMenuVisible returns false for any
  // allowlisted role before it reaches the hasPermission(item.module,'view')
  // fallback, if the item's name isn't in the role's array. Listed by exact
  // orphan name rather than folded into 'Inventory' via ORPHAN_PARENT_ALIAS,
  // since that group is also allowlisted for department_head/production_*/
  // qc_* roles that hold no 'assets' permission and would get a 403 link.
  procurement_manager: [
    'Home', 'Approvals', 'Procurement', 'Inventory', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes', 'Asset Register · More',
  ],
  procurement_exec: [
    'Home', 'Approvals', 'Procurement', 'Inventory',
    'Notifications', 'Org Chart', 'QR Codes', 'Asset Register · More',
  ],
  // store_keeper (20260529000001_...): view/add/edit/export inventory,
  // view/add/edit warehouse, view-only procurement (GRN receipt), and —
  // unlike procurement_exec — VONLY reports. EXEC_TIER (Approvals VA/
  // Notifications V). 'Asset Register · More' — see procurement_manager above.
  store_keeper: [
    'Home', 'Approvals', 'Inventory', 'Procurement', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes', 'Asset Register · More',
  ],
  // Phase-42 granular production seats. production_manager holds FULL
  // production+bom (bom has no top-level section), view/add/edit/approve/
  // export engineering, view/add/edit/delete/approve quality, view-only
  // inventory/warehouse, VEXP reports, view-only timesheets — APPROVER_TIER.
  // production_engineer is VAE production, view-only engineering/quality/
  // inventory, VAE timesheets, no reports — EXEC_TIER.
  // 'IoT Fleet · More'/'R&D · More'/'Compliance · More'/'Asset Register ·
  // More': same 20260719000001_seed_role_permission_gaps.js migration as
  // procurement_manager's Asset Register grant above — production_manager
  // holds FULL iot, VAEPX rd, VAEDP compliance and view-only assets;
  // production_engineer holds VAE iot/rd/compliance and view-only assets.
  // These four modules have no curated NAV_ITEMS entry (FleetMonitor.jsx/
  // RDHub.jsx/ComplianceRegister.jsx/AssetRegister.jsx are autoRouter.js
  // orphans), so they're unreachable via the module-permission fallback for
  // any allowlisted role unless listed here by exact orphan name.
  production_manager: [
    'Home', 'Approvals', 'Production', 'Engineering', 'Quality', 'Inventory',
    'Reports', 'Timesheets', 'Notifications', 'Org Chart', 'QR Codes',
    'IoT Fleet · More', 'R&D · More', 'Compliance · More', 'Asset Register · More',
  ],
  production_engineer: [
    'Home', 'Approvals', 'Production', 'Engineering', 'Quality', 'Inventory',
    'Timesheets', 'Notifications', 'Org Chart', 'QR Codes',
    'IoT Fleet · More', 'R&D · More', 'Compliance · More', 'Asset Register · More',
  ],
  // Phase-42 granular QC seats. qc_manager holds FULL quality + view-only
  // engineering/production/inventory + VEXP reports — APPROVER_TIER.
  // qc_engineer is VAE quality + view-only production/inventory, no reports —
  // EXEC_TIER. qc_manager also holds view-only iot/rd/assets and FULL
  // compliance (20260719000001_seed_role_permission_gaps.js); qc_engineer
  // holds only VAE compliance — see production_manager comment above for why
  // these are listed by exact orphan name.
  qc_manager: [
    'Home', 'Approvals', 'Quality', 'Engineering', 'Production', 'Inventory',
    'Reports', 'Notifications', 'Org Chart', 'QR Codes',
    'IoT Fleet · More', 'R&D · More', 'Compliance · More', 'Asset Register · More',
  ],
  qc_engineer: [
    'Home', 'Approvals', 'Quality', 'Production', 'Inventory',
    'Notifications', 'Org Chart', 'QR Codes', 'Compliance · More',
  ],
  // design_engineer (20260529000001_...): view/add/edit/delete engineering +
  // VAE bom (no top-level section) + view-only quality/production, no
  // reports — EXEC_TIER. Also holds view-only iot and VAED rd
  // (20260719000001_seed_role_permission_gaps.js) — see production_manager
  // comment above.
  design_engineer: [
    'Home', 'Approvals', 'Engineering', 'Quality', 'Production',
    'Notifications', 'Org Chart', 'QR Codes', 'IoT Fleet · More', 'R&D · More',
  ],
  // Phase-42 granular service seats. service_manager holds FULL servicedesk +
  // VEXP reports. service_engineer is VAE servicedesk only, no reports —
  // EXEC_TIER. Both also hold iot (VAEPX/VAE respectively — "device alerts
  // raise service tickets", 20260719000001_seed_role_permission_gaps.js) —
  // see production_manager comment above for why it's listed by exact orphan
  // name. 'Approvals' REMOVED from service_manager (F16 role-reconciliation
  // pass, 2026-07-22) — dropped from approvals.authz.js's APPROVER_ROLES, see
  // the project_manager comment above for why.
  // 'Complaints' (F17 pass): CustomerComplaintsIPCS is gated on the
  // `servicedesk` permission, not a dedicated module (complaints.routes.js —
  // "servicedesk, not a new complaints module, because IPCS is one half of
  // the Service module's complaint->ticket loop"). Both roles already hold
  // servicedesk FULL/VAE respectively; this was a missing sidebar-name entry
  // only, same shape as the F16 pass.
  service_manager: [
    'Home', 'Service Desk', 'Complaints', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes', 'IoT Fleet · More',
  ],
  service_engineer: [
    'Home', 'Approvals', 'Service Desk', 'Complaints',
    'Notifications', 'Org Chart', 'QR Codes', 'IoT Fleet · More',
  ],
  // l2_approver (20260721000003_seed_l2_approver_role.js): dedicated
  // second-level leave-approval seat — LeaveApprovals.jsx's L2 tab already
  // treats it as an alternative to department_head for the same queue. No
  // 'Approvals' section: this role's authority is leaves-only, not the
  // generic Approval Center (not in APPROVER_ROLES), and its actions live on
  // the 'Leaves' page's L2 tab instead.
  l2_approver: [
    'Home', 'Leaves', 'Attendance', 'Notifications', 'Org Chart', 'QR Codes',
  ],
};

// True if `role` is one governed by an explicit section allowlist.
export function roleHasSectionAllowlist(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_SECTION_ALLOWLIST, role);
}

// True if `role` may see the given top-level NAV section name.
export function canRoleSeeSection(role, sectionName) {
  const allow = ROLE_SECTION_ALLOWLIST[role];
  if (!allow) return true; // no allowlist for this role → not governed here
  return allow.includes(sectionName);
}

// Personal pages every authenticated user may always reach (own profile /
// preferences / notifications), even when their section is otherwise gated.
// 'MyRequests' is the read-only "status of what I submitted" view — it carries
// no approval authority (unlike ApprovalCenter, which is shaped for approvers
// and would show empty/broken bulk-action controls to a plain requester), so
// it is safe to leave reachable regardless of the caller's section allowlist.
export const PERSONAL_PAGES = new Set([
  'ProfileSettings', 'UserPreferences', 'NotificationCenter', 'MyRequests',
]);

// Route-level guard for allowlisted roles: a page whose section is NOT in the
// role's allowlist is blocked even via direct URL. Pages that belong to no NAV
// section (null) are left to the module / self-service gates.
export function canRoleAccessPageBySection(role, page) {
  const allow = ROLE_SECTION_ALLOWLIST[role];
  if (!allow) return true;
  if (PERSONAL_PAGES.has(page)) return true;
  const section = getSectionForPage(page);
  if (!section) return true;        // not part of any section → defer to other gates
  if (ALWAYS_VISIBLE.has(section)) return true;
  return allow.includes(section);
}

// ── Single source of truth for "could this role ever open this page?" ──────
// Composes every page-name-level gate above (Page-Access override, the
// employee/hr/finance/hr_exec/manager self-service scopings, admin-only,
// super-admin-only, section allowlist) into one predicate. Built for surfaces
// that list pages BY NAME ahead of a click — the global command palette and
// the topbar inline search — so they stop advertising pages (by exact title)
// that the viewer's own role could never open, without each surface
// re-implementing (and drifting from) a subset of the same rules Layout.jsx
// enforces at the route level. `menuAccess` is the admin Page-Access override
// lookup from useAuth() — pass it so an explicit grant/revoke on a section is
// honored here exactly as it is in the sidebar and at the route.
export function canRoleOpenPage(role, page, { menuAccess } = {}) {
  const section = getSectionForPage(page);
  const override = section && menuAccess ? menuAccess(section) : null;
  if (override === 'hidden') return false;
  if (override === 'view' || override === 'edit') return true;

  if (role === 'employee' && !canEmployeeAccessPage(page)) return false;
  if (role === 'hr' && !canHrAccessPage(page)) return false;
  if (role === 'finance' && !canFinanceAccessPage(page)) return false;
  if (role === 'hr_exec' && !canHrExecAccessPage(page)) return false;
  if (role === 'manager' && !canManagerAccessPage(page)) return false;
  if (!canRoleAccessAdminOnlyPage(role, page)) return false;
  if (!canRoleAccessSuperAdminPage(role, page)) return false;
  if (!canRoleAccessPageBySection(role, page)) return false;

  return true;
}
