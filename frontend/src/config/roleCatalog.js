// ──────────────────────────────────────────────────────────────────────────────
// roleCatalog — THE role list. Every role dropdown in the app reads from here.
//
// Why this file exists: five screens used to carry their own hardcoded role
// arrays and every one of them had drifted apart —
//
//   UserSetup          7 codes
//   ApproverSetup      7 codes, incl. 'ceo' and 'cfo'
//   SetupNotifications 8 codes
//   WorkflowBuilder    6 Title-Case LABELS used as if they were codes
//   SuccessionSettings 7 codes, incl. 'chro' and 'hr_admin'
//
// 'ceo', 'cfo' and 'chro' are seeded by no migration and accepted by no
// allowRoles() call anywhere in the backend. Choosing one produced a row the
// authorization layer could never match — an approval chain that never fires, a
// notification rule that reaches nobody. That class of bug is invisible until
// someone waits on an approval that will never arrive, which is exactly why the
// list must come from the registry rather than from memory.
//
// The registry (`roles` table) is served by GET /admin/roles-catalog. FALLBACK
// below mirrors what the migrations seed, and is used only until that request
// resolves — so a dropdown is never empty on first paint, and never wrong after.
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react';
import api from '@/services/api/client';

// Mirrors the seeded registry: 20260428000001_platform_foundation (5),
// 20260529000001_phase42_security_roles (21), 20260708000001_finance_role_and_
// access_alignment (finance), 20260716000009_user_roles_junction
// (department_head), 20260721000003_seed_l2_approver_role (l2_approver).
export const ROLE_CATALOG_FALLBACK = [
  { code: 'super_admin',         label: 'Super Administrator'  },
  { code: 'admin',               label: 'Administrator'        },
  { code: 'manager',             label: 'Manager'              },
  { code: 'department_head',     label: 'Department Head'      },
  { code: 'l2_approver',         label: 'L2 Leave Approver'    },
  { code: 'hr',                  label: 'HR Manager'           },
  { code: 'hr_manager',          label: 'HR Manager'           },
  { code: 'hr_exec',             label: 'HR Executive'         },
  { code: 'finance',             label: 'Finance'              },
  { code: 'finance_manager',     label: 'Finance Manager'      },
  { code: 'accounts_exec',       label: 'Accounts Executive'   },
  { code: 'payroll_admin',       label: 'Payroll Administrator'},
  { code: 'procurement_manager', label: 'Procurement Manager'  },
  { code: 'procurement_exec',    label: 'Procurement Executive'},
  { code: 'store_keeper',        label: 'Store Keeper'         },
  { code: 'production_manager',  label: 'Production Manager'   },
  { code: 'production_engineer', label: 'Production Engineer'  },
  { code: 'qc_manager',          label: 'QC Manager'           },
  { code: 'qc_engineer',         label: 'QC Engineer'          },
  { code: 'design_engineer',     label: 'Design Engineer'      },
  { code: 'project_manager',     label: 'Project Manager'      },
  { code: 'sales_manager',       label: 'Sales Manager'        },
  { code: 'sales_exec',          label: 'Sales Executive'      },
  { code: 'service_manager',     label: 'Service Manager'      },
  { code: 'service_engineer',    label: 'Service Engineer'     },
  { code: 'employee',            label: 'Employee'             },
];

// ── Badge colours — were duplicated verbatim in RolesSetup and UserSetup ──────
const ROLE_COLORS = {
  super_admin:     { color: '#dc2626', bg: '#fee2e2' },
  admin:           { color: '#6B3FDB', bg: '#ede9fe' },
  hr:              { color: '#0369a1', bg: '#e0f2fe' },
  hr_manager:      { color: '#0369a1', bg: '#e0f2fe' },
  hr_exec:         { color: '#0369a1', bg: '#e0f2fe' },
  finance:         { color: '#16a34a', bg: '#dcfce7' },
  finance_manager: { color: '#16a34a', bg: '#dcfce7' },
  accounts_exec:   { color: '#16a34a', bg: '#dcfce7' },
  payroll_admin:   { color: '#16a34a', bg: '#dcfce7' },
  manager:         { color: '#6d28d9', bg: '#ede9fe' },
  department_head: { color: '#6d28d9', bg: '#ede9fe' },
  l2_approver:     { color: '#6d28d9', bg: '#ede9fe' },
  employee:        { color: '#6b7280', bg: '#f3f4f6' },
};
const DEFAULT_ROLE_COLOR = { color: '#4b5563', bg: '#eef2f7' };

export const roleColor = (code) => ROLE_COLORS[code] ?? DEFAULT_ROLE_COLOR;

// 'sales_exec' → 'Sales Exec' when the registry has no label for it.
const titleize = (code) =>
  String(code || '')
    .split('_')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

// ── Module-level cache ───────────────────────────────────────────────────────
// One fetch per session, shared by every mounted picker. `inflight` collapses
// the burst that happens when a page mounts three role dropdowns at once.
let cached = null;
let inflight = null;

export function loadRoleCatalog() {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = api.get('/admin/roles-catalog')
    .then(({ data }) => {
      const rows = Array.isArray(data) ? data : [];
      cached = rows.length
        ? rows.map(r => ({ code: r.code, label: r.label || titleize(r.code) }))
        : ROLE_CATALOG_FALLBACK;
      return cached;
    })
    .catch(() => ROLE_CATALOG_FALLBACK)   // offline / 403 — never break the form
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * useRoleCatalog() → [{ code, label }]
 * Returns the seeded fallback on first paint, then the live registry.
 */
export function useRoleCatalog() {
  const [roles, setRoles] = useState(cached ?? ROLE_CATALOG_FALLBACK);

  useEffect(() => {
    let alive = true;
    loadRoleCatalog().then(rows => { if (alive) setRoles(rows); });
    return () => { alive = false; };
  }, []);

  return roles;
}

/** Human label for a role code, safe for codes the registry has since dropped. */
export function roleLabel(code) {
  const hit = (cached ?? ROLE_CATALOG_FALLBACK).find(r => r.code === code);
  return hit?.label ?? titleize(code);
}
