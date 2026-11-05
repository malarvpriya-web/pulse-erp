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
// 'Approvals' is everyone's: the Approval Center's My Requests tab is where
// any user tracks what they submitted, and the approver tabs appear only for
// people who approve something (decided server-side). Being ALWAYS_VISIBLE also
// keeps it out of the per-role section allowlists and Page Access config.
export const ALWAYS_VISIBLE = new Set(['Home', 'Approvals']);

// Sections that hold the screens used to undo a bad access change — protected
// so an admin cannot accidentally lock themselves out of the very screens
// needed to fix it. 'Settings' holds Access Control, which is now the ONLY
// section carrying Users / Roles / Approver — so it is the only one to lock.
export const SELF_SERVICE_LOCK = new Set(['Settings']);

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
    // `divider` rows are the sidebar's visual domain bands (Insights, Revenue,
    // …) — they carry no pages and are not configurable sections.
    .filter(g => g && !g.divider && g.name && !ALWAYS_VISIBLE.has(g.name))
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
    if (!g || g.divider || !g.name) continue;
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
  // 'EmployeeDashboard' — the personal dashboard (punch, payslip, leave
  // balance, tasks). It is the most self-service page in the HR menu; it only
  // ever showed the caller's own record.
  'EmployeeDashboard',
  // EmployeeDocuments is NOT here (§207): it is HR's register, gated on
  // employee_documents; an employee's own documents are the Self Service vault.
  'EmployeeAssets', 'SkillMatrix',
  // The hub that now carries Documents / Assets / Policies / HR Documents
  // (2026-09-16 IA pass). The four pages stay listed above: TabHub filters its
  // own tabs through canRoleOpenPage, which reads this very set, so listing the
  // hub alone would render it with no tabs at all for an employee.
  'EmployeeRecords',
  // (EmployeeDirectory used to be listed here because it sat inside the HR menu.
  // It is now its own section, granted through ROLE_SECTION_ALLOWLIST below, so
  // this self-service list no longer governs it.)
  // Service Desk ('KnowledgeBase' intentionally excluded — admin-only page)
  'MyTickets',
  // Travel Desk ('TravelPayment'/'TravelAudit' intentionally excluded — finance-only)
  'TravelRequests', 'ExpenseClaims', 'VisitReports', 'TravelCalendar',
  'TravelAdvances', 'TravelBookings', 'TravelEntry',
  // The three hubs those pages moved into (2026-09-16 IA pass). Each hub drops
  // the tabs an employee may not open — TravelExpenseCenter shows Claims and
  // Trip Expenses but never Expense Review or Payment, and TravelVisits shows
  // Visit Reports but not Customer Visits — because TabHub filters every tab
  // through canRoleOpenPage, which resolves against this set.
  'MyTravel', 'TravelExpenseCenter', 'TravelVisits',
  // Trip expense register, self-service alongside ExpenseClaims.
  'TravelExpenses',
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

// ── Finance scoping within the shared 'Leaves'/'Attendance'/'Timesheets' menus ──
// Finance gets its own domain in full (the entire 'Finance' section), but
// when its allowlist below also grants it the shared Leaves/Attendance/
// Timesheets sections, it may reach only the self-service pages inside them —
// never leave approvals, team views, attendance admin/config, or timesheet
// approval/utilization/settings screens. Mirrors the employee self-service
// pattern above. Also governs the granular finance_manager/accounts_exec
// roles now that their allowlists below carry 'Leaves'/'Attendance' too —
// same restriction, same self-service page set, no separate constant needed.
export const FINANCE_RESTRICTED_SECTIONS = new Set(['Leaves', 'Attendance', 'Timesheets']);

export const FINANCE_SELF_SERVICE_PAGES = new Set([
  // Leaves ('Leave Approvals'/'Team Leaves'/'All Leaves'/'Leave Reports'/
  // 'Encashment'/'Leave Settings' intentionally excluded)
  'MyLeaves', 'ApplyLeave', 'LeaveCalendar', 'HolidayCalendar', 'CompOff',
  // Attendance ('Live Workforce'/'Team Attendance'/'Shift Calendar'/
  // 'Regularization'/'Overtime'/etc. intentionally excluded)
  'AttendanceDashboard', 'QRAttendance',
  // Timesheets ('All Timesheets'/'Approvals'/'Utilization Report'/
  // 'Weekly Report'/'Settings' intentionally excluded)
  'MyTimesheet', 'MyAnalytics',
]);

// True if the finance role (or a granular finance_manager/accounts_exec
// holder) may render `page`. Pages inside a shared (restricted) menu are
// allowed only when they are self-service; pages outside those menus
// (including the whole 'Finance' section) are governed by the normal
// section allowlist / module gates.
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

// True only for the specific Leaves/Attendance/Timesheets self-service pages
// the finance-family carve-out above grants. Layout.jsx's generic
// `route.module` + `hasPermission(module,'view')` gate runs AFTER
// canFinanceAccessPage and would otherwise re-block these same pages: finance/
// finance_manager/accounts_exec deliberately hold no real 'attendance'/
// 'leaves'/'timesheets' role_permissions grant (that's the whole point of
// self-service instead of full module access), so hasPermission always
// returns false for them here. Layout.jsx uses this to bypass that specific
// gate for exactly these pages, without loosening it for anything else —
// e.g. the 'Finance' module itself still goes through the normal
// hasPermission check.
export function isFinanceSelfServicePage(page) {
  const section = getSectionForPage(page);
  return !!section && FINANCE_RESTRICTED_SECTIONS.has(section) && FINANCE_SELF_SERVICE_PAGES.has(page);
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
// 'EmployeeDashboard' is the manager's own personal dashboard, not an HR
// admin screen — without it here, canManagerAccessPage would 403 a manager
// on their own punch clock and payslips the moment the page got an HR row.
// (EmployeeDirectory was the other entry; it left the HR menu on 2026-10-20 and
// is now its own section, so this scoping no longer needs to name it.)
// 'EmployeeSelfService' for the same reason (2026-10-29): it is the manager's
// own IT declarations, documents, claims and profile — a manager is an
// employee too, and was refused the only screen that files them. The backend
// resolves every call there to the caller's own record.
export const MANAGER_HR_SCOPED_PAGES = new Set(['EmployeeDashboard', 'EmployeeSelfService']);

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
//
// 'Employee Directory' (2026-10-20) is granted to exactly the six roles that
// held 'HR' when the phonebook was a row inside it — manager, hr, employee,
// hr_manager, hr_exec, payroll_admin — so moving it out of HR neither revoked
// nor widened anyone's access. department_head never had it and still does not.
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
    'Operations', 'e-Signatures', 'Employee Directory',
  ],
  // department_head = manager-tier lead of an operational team (warehouse,
  // production or service), not an office function — manager's baseline plus
  // the domain sections their team actually works in. Backend role_permissions
  // already grants department_head view/add/edit/approve/export on inventory,
  // production and servicedesk (see 20260721000001_department_head_operational_grants.js),
  // so these sections are live, not more dead links.
  // 'Operations' — see manager comment above (F17 pass); permission-less,
  // added for parity as the other broad cross-departmental allowlist.
  // 'Complaints' (2026-07-29): CustomerComplaintsIPCS is registered under BOTH
  // the 'Complaints' and 'Service Desk' NAV_ITEMS groups (routes.jsx), and
  // getSectionForPage() resolves a shared page key to whichever group appears
  // first in the array — 'Complaints', not 'Service Desk'. department_head
  // held 'Service Desk' but not 'Complaints', so the "Customer Complaints" row
  // rendered as a clickable link inside their visible Service Desk submenu but
  // route-guarded to Unauthorized on click. Granted here, same shape as
  // service_manager/service_engineer holding both sections already.
  department_head: [
    'Home', 'Approvals', 'Employees', 'Attendance', 'Leaves', 'Timesheets',
    'Performance', 'Projects', 'Recruitment', 'Reports', 'QR Codes',
    'Notifications', 'Org Chart', 'Inventory', 'Production', 'Service Desk',
    'Operations', 'Complaints',
  ],
  // 'Travel Desk' granted in full: backend trusts hr with TRAVEL_APPROVE_ROLES
  // (approve/reject requests) and ADVANCE_MANAGER_ROLES (advance
  // manager-review) — see travel.routes.js. Not in AUDIT_ROLES, so TravelAudit
  // stays a 403 for hr at the API even though the section is now reachable;
  // that's the same shape as every other shared-section grant in this file.
  // 'Compliance'/'Asset Register':
  // 20260719000001_seed_role_permission_gaps.js granted hr view-only
  // compliance ("HR owns some certification evidence") and view-only assets
  // ("employee asset allocation") — see the procurement_manager comment below
  // Both are curated NAV_ITEMS sections as of 2026-09-16 (they were
  // autoRouter.js orphan groups named 'Compliance · More' / 'Asset Register
  // · More' until then); this list was renamed in lockstep.
  hr: [
    'Home', 'Approvals', 'Employees', 'HR', 'Learning Center', 'Attendance',
    'Leaves', 'Timesheets', 'Performance', 'Recruitment', 'Reports',
    'QR Codes', 'Notifications', 'Org Chart', 'Analytics & AI', 'Travel Desk',
    'Compliance', 'Asset Register', 'Employee Directory',
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
    'Home', 'Approvals', 'Finance', 'Leaves', 'Attendance', 'Timesheets',
    'Reports', 'QR Codes', 'Notifications', 'Org Chart', 'Analytics & AI',
    'Travel Desk',
  ],
  // 'Notifications'/'Org Chart' — same permission-less shape as QR Codes (see
  // manager comment above): neither backend route requires more than
  // verifyToken for reads, and OrgChart.jsx now hides its HR-only "Assign
  // Reporting Manager" panel from non-HR roles, so both are safe self-service
  // reads for employee too (2026-07-28, closing the gap a stale pasted
  // UX-audit note flagged — see project_nav_module_gating_audit memory).
  employee: [
    'Home', 'Attendance', 'Leaves', 'Travel Desk', 'Service Desk', 'HR',
    'Timesheets', 'QR Codes', 'Performance', 'Notifications', 'Org Chart',
    'Employee Directory',
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
    'Home', 'Approvals', 'HR', 'Learning Center', 'Recruitment',
    'Attendance', 'Leaves', 'Timesheets', 'Performance', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes', 'e-Signatures', 'Employee Directory',
  ],
  // 'Approvals' REMOVED (2026-07-30, same F16 reasoning as project_manager/
  // sales_manager/service_manager below): hr_exec is not in approvals.authz.js's
  // APPROVER_ROLES, and every source category the Approval Center's read path
  // ever shows as "unassigned" (leave/OT/PR/expense/ECN/payment) requires
  // APPROVER_ROLES membership to act on — never true for this role. The section
  // was a populated-but-broken queue: real items listed, every Approve/Reject
  // click 403s via canActOnApproval, surfaced to the user as a generic "Failed
  // to approve — try again" toast that can never succeed. Regularization/
  // probation items assigned directly by identity (not role) still reach
  // hr_exec via notifications regardless of this allowlist entry.
  hr_exec: [
    'Home', 'HR', 'Learning Center', 'Recruitment',
    'Attendance', 'Leaves', 'Timesheets', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes', 'Employee Directory',
  ],
  payroll_admin: [
    'Home', 'Approvals', 'HR', 'Attendance', 'Leaves', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes', 'Employee Directory',
  ],
  // Phase-42 granular finance seats (20260529000001_phase42_security_roles.js).
  // Both hold 'Finance'/'Reports' via the module-permission fallback
  // (role_permissions grants finance_manager full finance+accounting+gst+tds,
  // accounts_exec view/add/edit finance with no GL/TDS). 'Notifications' is
  // ALSO covered by that same fallback — its NAV_ITEMS entry carries
  // `module: 'notifications'` and
  // [20260721000002_granular_role_approvals_notifications_grants.js] grants
  // both roles a role_permissions row on the 'notifications' module. Listed
  // here too — redundant with the fallback but harmless — so the grant stays
  // visible without cross-referencing role_permissions.
  // 'Leaves'/'Attendance' (2026-07-28) and 'Timesheets' (2026-08-10): mirrors
  // the self-service carve-out the coarse `finance` role already had — these
  // two granular roles never got it, so a finance_manager/accounts_exec had
  // no menu path to apply for their own leave / log their own timesheet.
  // Scoped to self-service only via FINANCE_RESTRICTED_SECTIONS /
  // FINANCE_SELF_SERVICE_PAGES, same as `finance` (canFinanceAccessPage /
  // isFinanceSelfServicePage already cover finance_manager/accounts_exec by
  // name, so no code change beyond this allowlist entry was needed).
  // finance_manager keeps 'Approvals' — it IS in approvals.authz.js's
  // APPROVER_ROLES (unscoped, VAEP). accounts_exec's role_permissions
  // 'approvals' module grant (VA, "executor") is a generic CRUD flag on a
  // different permission dimension — it does NOT make accounts_exec an
  // APPROVER_ROLES member, so 'Approvals' was REMOVED from accounts_exec here
  // (2026-07-30, same F16 reasoning as project_manager/sales_manager/
  // service_manager below, and hr_exec above): every category the Approval
  // Center's read path shows as "unassigned" 403s on click for a non-approver
  // role, surfaced to the user as a misleading generic "Failed to approve —
  // try again" toast. See hr_exec's comment above for the full mechanism.
  finance_manager: [
    'Home', 'Approvals', 'Finance', 'Reports', 'Leaves', 'Attendance',
    'Timesheets', 'Notifications', 'Org Chart', 'QR Codes',
  ],
  accounts_exec: [
    'Home', 'Finance', 'Reports', 'Leaves', 'Attendance', 'Timesheets',
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
  // 'R&D': 20260719000001_seed_role_permission_gaps.js granted
  // project_manager view-only rd — see the procurement_manager comment below
  // 'R&D' became a curated NAV_ITEMS section 2026-09-16 (it was the orphan
  // group 'R&D · More'). Kept standalone rather than folded into
  // Engineering precisely because project_manager holds no 'Engineering'.
  // 'Approvals' REMOVED (F16 role-reconciliation pass, 2026-07-22):
  // project_manager was dropped from approvals.authz.js's APPROVER_ROLES —
  // none of the shared Approval Center pool's categories (leave/
  // regularization/OT/purchase request/expense/ECN/payment) are this role's
  // domain, so the section only ever dead-ended every action button on
  // Unauthorized. Same shape as l2_approver having no Approvals section.
  project_manager: [
    'Home', 'Projects', 'Timesheets', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes', 'R&D',
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
  // 'Tenders · More' REMOVED 2026-09-16: TenderWorkspace is now a row inside
  // the curated 'CRM' submenu (tenders.routes.js is gated on the same `crm`
  // permission — "a tender IS an opportunity"), and both roles already hold
  // 'CRM', so the fold cost neither of them access.
  sales_manager: [
    'Home', 'CRM', 'Sales', 'Marketing', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes', 'e-Signatures',
  ],
  // 'Approvals' REMOVED (2026-07-30, same F16/hr_exec reasoning — see hr_exec's
  // comment above): sales_exec is not in approvals.authz.js's APPROVER_ROLES.
  sales_exec: [
    'Home', 'CRM', 'Sales',
    'Notifications', 'Org Chart', 'QR Codes',
  ],
  // Phase-42 granular procurement seats (20260529000001_phase42_security_roles.js).
  // procurement_manager holds FULL procurement, view/add/edit/delete/approve
  // inventory + view/add/edit/delete warehouse (WarehouseManagement lives as a
  // submenu page under 'Inventory', not its own top-level section) and VEXP
  // reports — APPROVER_TIER in [20260721000002_granular_role_approvals_
  // notifications_grants.js], so also Approvals VAEP/Notifications VAE.
  // procurement_exec is VAE procurement + view-only inventory/warehouse, no
  // reports — EXEC_TIER (Approvals VA/Notifications V).
  // 'Asset Register' (both): a curated NAV_ITEMS section as of 2026-09-16
  // (previously the autoRouter.js orphan group 'Asset Register · More').
  // Left standalone: hr holds it too but holds no 'Inventory'.
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
    'Notifications', 'Org Chart', 'QR Codes', 'Asset Register',
  ],
  // 'Approvals' REMOVED from procurement_exec (2026-07-30, same F16/hr_exec
  // reasoning — see hr_exec's comment above): unlike procurement_manager
  // (category-scoped APPROVER_ROLES member, pr/purchase_request/purchase),
  // procurement_exec holds no APPROVER_ROLES membership at all.
  procurement_exec: [
    'Home', 'Procurement', 'Inventory',
    'Notifications', 'Org Chart', 'QR Codes', 'Asset Register',
  ],
  // store_keeper (20260529000001_...): view/add/edit/export inventory,
  // view/add/edit warehouse, view-only procurement (GRN receipt), and —
  // unlike procurement_exec — VONLY reports. EXEC_TIER (Approvals VA/
  // Notifications V). 'Asset Register' — see procurement_manager above.
  // 'Approvals' REMOVED (2026-07-30, same F16/hr_exec reasoning — see
  // hr_exec's comment above): store_keeper is not in approvals.authz.js's
  // APPROVER_ROLES.
  store_keeper: [
    'Home', 'Inventory', 'Procurement', 'Reports',
    'Notifications', 'Org Chart', 'QR Codes', 'Asset Register',
  ],
  // Phase-42 granular production seats. production_manager holds FULL
  // production+bom (bom has no top-level section), view/add/edit/approve/
  // export engineering, view/add/edit/delete/approve quality, view-only
  // inventory/warehouse, VEXP reports, view-only timesheets — APPROVER_TIER.
  // production_engineer is VAE production, view-only engineering/quality/
  // inventory, VAE timesheets, no reports — EXEC_TIER.
  // 'IoT Fleet'/'R&D'/'Compliance'/'Asset Register':
  // same 20260719000001_seed_role_permission_gaps.js migration as
  // procurement_manager's Asset Register grant above — production_manager
  // holds FULL iot, VAEPX rd, VAEDP compliance and view-only assets;
  // production_engineer holds VAE iot/rd/compliance and view-only assets.
  // These four had no curated NAV_ITEMS entry until 2026-09-16 (FleetMonitor.jsx/
  // RDHub.jsx/ComplianceRegister.jsx/AssetRegister.jsx were autoRouter.js
  // orphans), so they're unreachable via the module-permission fallback for
  // any allowlisted role unless listed here by exact orphan name.
  production_manager: [
    'Home', 'Approvals', 'Production', 'Engineering', 'Quality', 'Inventory',
    'Reports', 'Timesheets', 'Notifications', 'Org Chart', 'QR Codes',
    'IoT Fleet', 'R&D', 'Compliance', 'Asset Register',
  ],
  // 'Approvals' REMOVED from production_engineer (2026-07-30, same F16/
  // hr_exec reasoning — see hr_exec's comment above): unlike
  // production_manager (category-scoped APPROVER_ROLES member, ecn),
  // production_engineer holds no APPROVER_ROLES membership at all.
  production_engineer: [
    'Home', 'Production', 'Engineering', 'Quality', 'Inventory',
    'Timesheets', 'Notifications', 'Org Chart', 'QR Codes',
    'IoT Fleet', 'R&D', 'Compliance', 'Asset Register',
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
    'IoT Fleet', 'R&D', 'Compliance', 'Asset Register',
  ],
  // 'Approvals' REMOVED from qc_engineer (2026-07-30, same F16/hr_exec
  // reasoning — see hr_exec's comment above): unlike qc_manager
  // (category-scoped APPROVER_ROLES member, ecn), qc_engineer holds no
  // APPROVER_ROLES membership at all.
  qc_engineer: [
    'Home', 'Quality', 'Production', 'Inventory',
    'Notifications', 'Org Chart', 'QR Codes', 'Compliance',
  ],
  // design_engineer (20260529000001_...): view/add/edit/delete engineering +
  // VAE bom (no top-level section) + view-only quality/production, no
  // reports — EXEC_TIER. Also holds view-only iot and VAED rd
  // (20260719000001_seed_role_permission_gaps.js) — see production_manager
  // comment above. 'Approvals' REMOVED (2026-07-30, same F16/hr_exec
  // reasoning — see hr_exec's comment above): not in APPROVER_ROLES.
  design_engineer: [
    'Home', 'Engineering', 'Quality', 'Production',
    'Notifications', 'Org Chart', 'QR Codes', 'IoT Fleet', 'R&D',
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
    'Notifications', 'Org Chart', 'QR Codes', 'IoT Fleet',
  ],
  // 'Approvals' REMOVED (2026-07-30, same F16/hr_exec reasoning — see
  // hr_exec's comment above): service_engineer is not in approvals.authz.js's
  // APPROVER_ROLES.
  service_engineer: [
    'Home', 'Service Desk', 'Complaints',
    'Notifications', 'Org Chart', 'QR Codes', 'IoT Fleet',
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
// 'EmployeeDashboard' is the caller's own dashboard — it reads
// /attendance/today/<self>, /leaves/balance, /payroll/employee/<self> and
// nothing else. It now sits in the 'HR' submenu for discoverability, but most
// allowlisted roles (sales_exec, store_keeper, qc_engineer, l2_approver, …)
// hold no 'HR' section; listing it here keeps the route open to all of them,
// exactly as it was when the page belonged to no section at all.
export const PERSONAL_PAGES = new Set([
  'ProfileSettings', 'UserPreferences', 'NotificationCenter', 'MyRequests', 'ApprovalCenter',
  'EmployeeDashboard',
  // NOT 'EmployeeSelfService' (management decision, 2026-10-29, §202): the
  // portal is for the roles that hold the HR menu, by menu AND by URL, so it is
  // governed by the section allowlist like any HR row. The server enforces the
  // same boundary with the self_service grant, seeded for exactly those roles.
  // A mentor can sit in any department and any role. The route is open to every
  // role; the API admits only the intern's current mentor, and the page tells
  // anyone else it is for assigned mentors. The menu entry is drawn only for a
  // current mentor (NAV_ITEMS `mentorOnly`, decided in Sidebar.jsx).
  'MyInternEvaluations',
  // Same arrangement for department heads: open to every role by URL, the API
  // admits only the review's assigned head, and the page shows anyone else a
  // notice. The menu entry is `probationReviewerOnly` (Sidebar.jsx).
  'MyProbationReviews',
  // The reader's side of HR Announcements — where the bell sends every role.
  // GET /announcements/active returns only the caller's company and audience, so
  // opening the page grants nothing; it is NOT the HR administration page
  // (Announcements), which employees still cannot open. No menu row: Home's
  // Announcements card is where people see them; this page is where the bell
  // opens one in full and records the read.
  'MyAnnouncements',
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
  // ALWAYS_VISIBLE sections cannot be restricted (see its definition) — the same
  // rule Sidebar.jsx applies, so a drawn row never resolves to nowhere.
  const override = section && menuAccess && !ALWAYS_VISIBLE.has(section) ? menuAccess(section) : null;
  if (override === 'hidden') return false;
  if (override === 'view' || override === 'edit') return true;

  if (role === 'employee' && !canEmployeeAccessPage(page)) return false;
  if (role === 'hr' && !canHrAccessPage(page)) return false;
  if ((role === 'finance' || role === 'finance_manager' || role === 'accounts_exec') && !canFinanceAccessPage(page)) return false;
  if (role === 'hr_exec' && !canHrExecAccessPage(page)) return false;
  if (role === 'manager' && !canManagerAccessPage(page)) return false;
  if (!canRoleAccessAdminOnlyPage(role, page)) return false;
  if (!canRoleAccessSuperAdminPage(role, page)) return false;
  if (!canRoleAccessPageBySection(role, page)) return false;

  return true;
}

// ── "Would Layout.jsx render this page, or its Access Denied screen?" ───────
// canRoleOpenPage() above answers a looser question: it is built for search
// surfaces and lets a Page-Access grant short-circuit everything, while
// Layout.jsx still applies the employee scoping, the section allowlist and the
// route's module permission after such a grant. Code that SENDS someone to a
// page (a redirect, a menu row that stands in for another) needs the stricter
// answer, or it can land them on Access Denied. This is Layout.jsx's gate, in
// Layout.jsx's order, and Layout.jsx calls it — so the two cannot drift.
//
// `route` is the page's ROUTES entry (its `module` is the permission gate);
// `hasPermission` and `menuAccess` come from useAuth().
/**
 * Does the caller hold the grant a page or menu row asks for? `actions` is the
 * row's optional `moduleActions` — any ONE of them opens it; default view only.
 * Used where a page also serves a narrower grant, e.g. Bank Detail Approvals,
 * which a propose-only `employee_bank:add` holder opens to see just its own
 * requests (§206).
 */
/**
 * The grant itself, from the /auth/permissions list — NO admin shortcut.
 * hasPermission() answers true for admin / super_admin on every module, which
 * is wrong for the few grants the server gives admin no bypass on: payroll
 * payment is finance_manager only (PC-01 Q1). The list is already the server's
 * resolution (user override, else the union across roles).
 */
export function heldGrant(permissions, module, action) {
  const row = Array.isArray(permissions) ? permissions.find(p => p?.module === module) : null;
  return row?.[`can_${action}`] === true;
}

export function holdsModuleGrant(hasPermission, module, actions) {
  if (typeof hasPermission !== 'function') return false;
  const list = Array.isArray(actions) && actions.length ? actions : ['view'];
  return list.some(a => hasPermission(module, a));
}

export function canRenderPage(role, page, { route, menuAccess, hasPermission } = {}) {
  const section = getSectionForPage(page);
  // ALWAYS_VISIBLE sections (Home, Approvals) cannot be
  // restricted by Page Access. Sidebar.jsx already draws them regardless; without
  // this, a stray 'hidden' override would make the drawn row open Access Denied.
  const sectionAccess = section && menuAccess && !ALWAYS_VISIBLE.has(section) ? menuAccess(section) : null;
  const granted = sectionAccess === 'view' || sectionAccess === 'edit';
  const financeRole = role === 'finance' || role === 'finance_manager' || role === 'accounts_exec';

  if (sectionAccess === 'hidden') return false;
  if (role === 'employee' && !canEmployeeAccessPage(page)) return false;
  if (role === 'hr' && !granted && !canHrAccessPage(page)) return false;
  if (financeRole && !granted && !canFinanceAccessPage(page)) return false;
  if (role === 'hr_exec' && !granted && !canHrExecAccessPage(page)) return false;
  if (role === 'manager' && !granted && !canManagerAccessPage(page)) return false;
  if (!canRoleAccessAdminOnlyPage(role, page)) return false;
  if (!canRoleAccessSuperAdminPage(role, page)) return false;
  if (!canRoleAccessPageBySection(role, page)) return false;
  if (route?.module) {
    const financeSelfService = financeRole && isFinanceSelfServicePage(page);
    const allowed = role === 'super_admin' || role === 'admin' || financeSelfService ||
      (typeof hasPermission === 'function' && holdsModuleGrant(hasPermission, route.module, route.moduleActions));
    if (!allowed) return false;
  }
  return true;
}

// ── One employee list per person ────────────────────────────────────────────
// All Employees (EmployeesData) is the employee master. The Employee Directory
// is a read-only phonebook kept for the people who CANNOT open the master —
// ordinary employees, and the hr_manager / hr_exec / payroll_admin seats, which
// hold no employees:view. Anyone who can render the master is sent there
// instead: Sidebar.jsx drops the directory row for them and Layout.jsx
// redirects /EmployeeDirectory to /EmployeesData. Both ask THIS function, which
// asks canRenderPage() — so nobody is redirected to a page that would refuse
// them, and nobody who keeps the phonebook loses it.
export const EMPLOYEE_MASTER_PAGE = 'EmployeesData';
export const EMPLOYEE_DIRECTORY_PAGE = 'EmployeeDirectory';

export function canOpenEmployeeMaster(role, { route, menuAccess, hasPermission } = {}) {
  if (!route) return false;   // no route entry → never redirect into nothing
  return canRenderPage(role, EMPLOYEE_MASTER_PAGE, { route, menuAccess, hasPermission });
}

// ── One Payroll destination (2026-10-28) ────────────────────────────────────
// The payroll pages below are also sections of Payroll Center, which renders
// the same components. Their own page keys stay routed because other screens
// and bookmarks open them (Setup Wizard, Settings Center, HR Dashboard,
// Attendance → Payroll Sync, search). Whoever can render Payroll Center is
// sent to the matching section instead, so they always land inside the hub.
// Everyone else is gated on the standalone page exactly as before — this
// neither grants nor removes access. PayslipViewer is deliberately NOT here:
// it is My Payslip for every employee, who cannot open Payroll Center.
export const PAYROLL_HUB_PAGE = 'PayrollCenter';
export const PAYROLL_HUB_PAGES = {
  Payroll:          { tab: 'processing' },
  SalaryStructure:  { tab: 'structures' },
  PayslipGenerator: { tab: 'payslips', view: 'generator' },
  PayrollSettings:  { tab: 'settings' },
  PayrollForm16:    { tab: 'statutory', view: 'form16' },
  PayrollForm24Q:   { tab: 'statutory', view: 'form138' },
};

/** The hub URL for a consolidated payroll page, or null when the viewer stays on the page. */
export function payrollHubRedirect(role, page, { route, menuAccess, hasPermission } = {}) {
  const target = PAYROLL_HUB_PAGES[page];
  if (!target || !route) return null;
  if (!canRenderPage(role, PAYROLL_HUB_PAGE, { route, menuAccess, hasPermission })) return null;
  return `/${PAYROLL_HUB_PAGE}?${new URLSearchParams(target).toString()}`;
}
