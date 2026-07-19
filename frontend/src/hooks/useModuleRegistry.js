import { useMemo, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { MODULE_REGISTRY } from '@/config/moduleRegistry';

/**
 * Maps each granular Phase-42 role to the module IDs it can access.
 * When a role is listed here its access is determined by this whitelist;
 * the legacy permissions[] array on each registry entry is also checked
 * (so super_admin/admin/manager/employee keep working unchanged).
 *
 * Module IDs must match the `id` field in MODULE_REGISTRY entries.
 */
const ROLE_MODULE_ACCESS = {
  hr_manager: new Set([
    'home', 'announcements', 'employee_dashboard', 'erp_dashboard', 'approvals',
    'employees', 'hr', 'recruitment', 'talent', 'attendance', 'leaves',
    'timesheets', 'performance', 'notifications', 'orgchart', 'reports',
    'ai_insights',
  ]),
  hr_exec: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'employees', 'hr', 'attendance', 'leaves', 'timesheets',
    'notifications', 'orgchart', 'ai_insights',
  ]),
  payroll_admin: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'employees', 'hr', 'leaves', 'attendance', 'notifications', 'reports',
  ]),
  finance_manager: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'finance', 'analytics', 'reports', 'notifications', 'ai_insights',
  ]),
  accounts_exec: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'finance', 'reports', 'notifications',
  ]),
  procurement_manager: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'procurement', 'inventory', 'reports', 'notifications', 'ai_insights',
  ]),
  procurement_exec: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'procurement', 'inventory', 'notifications',
  ]),
  store_keeper: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'inventory', 'procurement', 'notifications',
  ]),
  production_manager: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'production', 'inventory', 'timesheets', 'reports', 'analytics',
    'notifications', 'ai_insights',
  ]),
  production_engineer: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'production', 'inventory', 'timesheets', 'notifications',
  ]),
  qc_manager: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'production', 'inventory', 'reports', 'notifications',
  ]),
  qc_engineer: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'production', 'inventory', 'notifications',
  ]),
  design_engineer: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'production', 'inventory', 'notifications',
  ]),
  project_manager: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'projects', 'timesheets', 'reports', 'notifications', 'ai_insights',
  ]),
  sales_manager: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'crm', 'sales', 'marketing', 'reports', 'analytics', 'notifications', 'ai_insights',
  ]),
  sales_exec: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'crm', 'sales', 'notifications',
  ]),
  service_manager: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'servicedesk', 'reports', 'notifications', 'ai_insights',
  ]),
  service_engineer: new Set([
    'home', 'announcements', 'employee_dashboard', 'approvals',
    'servicedesk', 'notifications',
  ]),
};

function itemAllowed(item, role) {
  if (!item.permissions || item.permissions.length === 0) return true;

  // Direct match in the legacy permissions array (covers super_admin/admin/manager/employee)
  if (item.permissions.includes(role)) return true;

  // New granular role: check module-level whitelist
  const allowed = ROLE_MODULE_ACCESS[role];
  if (!allowed) return false;
  return allowed.has(item.id);
}

/**
 * useModuleRegistry — reads MODULE_REGISTRY and filters by current user role.
 *
 * Returns:
 *   allowedModules  — registry entries (+ filtered children) visible to the current role
 *   hasAccess(id)   — true if moduleId is accessible to the current role
 *   getModuleByPath(page) — find registry entry whose .page === page key
 *   canViewPage(page)     — true if the page is accessible (or not in registry)
 */
export function useModuleRegistry() {
  const { role } = useAuth();

  const allowedModules = useMemo(() => {
    if (!role) return [];
    return MODULE_REGISTRY
      .filter(item => itemAllowed(item, role))
      .map(item => {
        if (!item.children) return item;
        // For granular roles, filter children to only those explicitly allowed or matching legacy permissions
        return { ...item, children: item.children.filter(c => {
          if (!c.permissions || c.permissions.length === 0) return true;
          if (c.permissions.includes(role)) return true;
          // Inherit parent access for granular roles — all children of an allowed parent are shown
          const allowed = ROLE_MODULE_ACCESS[role];
          if (allowed && allowed.has(item.id)) return true;
          return false;
        }) };
      });
  }, [role]);

  const hasAccess = useCallback((moduleId) => {
    if (!role) return false;
    for (const item of MODULE_REGISTRY) {
      if (item.id === moduleId) return itemAllowed(item, role);
      if (item.children) {
        for (const child of item.children) {
          if (child.id === moduleId) {
            // Child access: check child directly, or inherit if parent is allowed
            if (!child.permissions || child.permissions.length === 0) return true;
            if (child.permissions.includes(role)) return true;
            const allowed = ROLE_MODULE_ACCESS[role];
            if (allowed && allowed.has(item.id)) return true;
            return false;
          }
        }
      }
    }
    return false;
  }, [role]);

  const getModuleByPath = useCallback((page) => {
    for (const item of MODULE_REGISTRY) {
      if (item.page === page) return item;
      if (item.children) {
        for (const child of item.children) {
          if (child.page === page) return child;
        }
      }
    }
    return null;
  }, []);

  const canViewPage = useCallback((page) => {
    if (!role) return false;
    const mod = getModuleByPath(page);
    if (!mod) return true; // page not in registry — always allow
    return itemAllowed(mod, role);
  }, [role, getModuleByPath]);

  return { allowedModules, hasAccess, getModuleByPath, canViewPage };
}
