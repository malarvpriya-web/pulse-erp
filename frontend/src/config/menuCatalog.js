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
]);

export const EMPLOYEE_SELF_SERVICE_PAGES = new Set([
  // HR ('Announcements' intentionally excluded — disabled for employee self-service)
  'Policies', 'Downloads', 'EmployeeSelfService',
  'EmployeeDocuments', 'EmployeeAssets', 'SkillMatrix',
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
  manager: [
    'Home', 'Approvals', 'Employees', 'Attendance', 'Leaves', 'Timesheets',
    'Performance', 'Projects', 'Recruitment', 'Reports', 'QR Codes',
    'Notifications', 'Org Chart',
  ],
  hr: [
    'Home', 'Approvals', 'Employees', 'HR', 'Learning Center', 'Attendance',
    'Leaves', 'Timesheets', 'Performance', 'Recruitment', 'Talent', 'Reports',
    'QR Codes', 'Notifications', 'Org Chart',
  ],
  finance: [
    'Home', 'Approvals', 'Finance', 'Reports', 'QR Codes', 'Notifications',
    'Org Chart',
  ],
  employee: [
    'Home', 'Attendance', 'Leaves', 'Travel Desk', 'Service Desk', 'HR',
    'Timesheets', 'QR Codes',
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
export const PERSONAL_PAGES = new Set([
  'ProfileSettings', 'UserPreferences', 'NotificationCenter',
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
