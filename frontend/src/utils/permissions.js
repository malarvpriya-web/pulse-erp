// Unified permissions utility
// Primary source of truth: AuthContext (useAuth().hasPermission)
// This file provides standalone helpers for components that can't use hooks

// ─── Role constants ───────────────────────────────────────────────────────────
export const ROLES = {
  SUPER_ADMIN:     'super_admin',
  ADMIN:           'admin',
  MANAGER:         'manager',
  DEPARTMENT_HEAD: 'department_head',
  EMPLOYEE:        'employee',
};

// ─── Roles that bypass all permission checks ─────────────────────────────────
export const ADMIN_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN];

// ─── Default module access per role ──────────────────────────────────────────
export const ROLE_MODULE_ACCESS = {
  super_admin:     null,   // null = unrestricted
  admin:           null,
  manager:         ['employees', 'projects', 'leave', 'attendance', 'reports', 'approvals'],
  department_head: ['employees', 'projects', 'leave', 'attendance', 'approvals'],
  employee:        ['leave', 'attendance'],
};

// ─── Current roles (many-to-many) ────────────────────────────────────────────
// localStorage 'role' is only the PRIMARY role. 'roles' holds the full set —
// read that, or a member's non-primary roles are silently ignored here.
// Falls back to [role] for sessions that predate the roles array.
const currentRoles = () => {
  try {
    const raw = JSON.parse(localStorage.getItem('roles') || '[]');
    if (Array.isArray(raw) && raw.length) return raw.map(r => String(r).toLowerCase());
  } catch { /* fall through */ }
  const single = String(localStorage.getItem('role') || '').toLowerCase();
  return single ? [single] : [];
};

// ─── Standalone helper (reads from localStorage, no hook needed) ──────────────
export const hasPermission = (module, action) => {
  if (currentRoles().some(r => ADMIN_ROLES.includes(r))) return true;

  const permissions = JSON.parse(localStorage.getItem('permissions') || '[]');
  const modulePermission = permissions.find(p => p.module === module);
  if (!modulePermission) return false;

  const actionMap = {
    view:    'can_view',
    add:     'can_add',
    edit:    'can_edit',
    delete:  'can_delete',
    approve: 'can_approve',
    export:  'can_export',
  };
  return modulePermission[actionMap[action]] === true;
};

// ─── Get list of modules the current user can view ───────────────────────────
export const getVisibleModules = () => {
  if (currentRoles().some(r => ADMIN_ROLES.includes(r))) return null; // null = all modules

  const permissions = JSON.parse(localStorage.getItem('permissions') || '[]');
  return permissions.filter(p => p.can_view).map(p => p.module);
};

// ─── Check if user holds a given role (any of the roles they hold) ───────────
export const hasRole = (...requiredRoles) => {
  const want = requiredRoles.flat().map(r => String(r).toLowerCase());
  return currentRoles().some(r => want.includes(r));
};

// True only when `employee` is the ONLY role held — mirrors the backend's
// isEmployee fork. Use this for "is this an employee-only view" decisions.
export const isEmployeeOnly = () => {
  const roles = currentRoles();
  return roles.length > 0 && roles.every(r => r === ROLES.EMPLOYEE);
};

export const isAdminOrAbove = () => currentRoles().some(r => ADMIN_ROLES.includes(r));

// ─── Approval workflow statuses ──────────────────────────────────────────────
export const APPROVAL_STATUS = {
  DRAFT:           'draft',
  HR_PENDING:      'hr_pending',
  FINANCE_PENDING: 'finance_pending',
  APPROVED:        'approved',
  REJECTED:        'rejected',
};
