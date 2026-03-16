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

// ─── Standalone helper (reads from localStorage, no hook needed) ──────────────
export const hasPermission = (module, action) => {
  const role = localStorage.getItem('role');
  if (ADMIN_ROLES.includes(role)) return true;

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
  const role = localStorage.getItem('role');
  if (ADMIN_ROLES.includes(role)) return null; // null = all modules

  const permissions = JSON.parse(localStorage.getItem('permissions') || '[]');
  return permissions.filter(p => p.can_view).map(p => p.module);
};

// ─── Check if user has a given role ──────────────────────────────────────────
export const hasRole = (requiredRole) => {
  const role = localStorage.getItem('role');
  return role === requiredRole;
};

export const isAdminOrAbove = () => {
  const role = localStorage.getItem('role');
  return ADMIN_ROLES.includes(role);
};

// ─── Approval workflow statuses ──────────────────────────────────────────────
export const APPROVAL_STATUS = {
  DRAFT:           'draft',
  HR_PENDING:      'hr_pending',
  FINANCE_PENDING: 'finance_pending',
  APPROVED:        'approved',
  REJECTED:        'rejected',
};
