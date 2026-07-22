import { useReducer, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Zap, FolderOpen } from 'lucide-react';
import './Sidebar.css';
import { useAuth } from '@/context/AuthContext';
import { NAV_ITEMS } from '@/config/routes';
import { ORPHAN_NAV_ITEMS } from '@/config/autoRouter';
import {
  EMPLOYEE_SELF_SERVICE_PAGES, ADMIN_ONLY_PAGES, SUPER_ADMIN_ONLY_PAGES,
  ROLE_SECTION_ALLOWLIST, roleHasSectionAllowlist, HR_SCOPED_PAGES,
  FINANCE_RESTRICTED_SECTIONS, FINANCE_SELF_SERVICE_PAGES,
  FINANCE_ANALYTICS_SCOPED_PAGES, MANAGER_ANALYTICS_SCOPED_PAGES,
  HR_EXEC_EXCLUDED_PAGES,
} from '@/config/menuCatalog';

// Orphan groups are named "<Label> · More". Where the label doesn't match a
// curated top-level name verbatim, map it to the right parent here.
const ORPHAN_PARENT_ALIAS = {
  Analytics:     'Analytics & AI',
  Audit:         'Audit Logs',
  Documents:     'e-Signatures',
  Admin:         'Settings',
  Warehouse:     'Inventory',
  Logistics:     'Inventory',
  Maintenance:   'Operations',
  'HR Analytics':'HR',
};

// Fold the auto-discovered "<Module> · More" orphan groups INTO their curated
// parent menu (deduped, under a "More" divider) instead of rendering them as
// separate folder-icon top-level items. This removes the duplicate module rows
// and the placeholder folder icons while keeping every page reachable.
function buildNavItems(curated, orphans) {
  const byName = new Map();
  const merged = curated.map(item => {
    const copy = { ...item, submenu: item.submenu ? [...item.submenu] : undefined };
    byName.set(copy.name, copy);
    return copy;
  });

  const leftover = [];
  for (const orphan of orphans) {
    const base = orphan.name.replace(/\s*·\s*More$/, '').trim();
    const target = byName.get(ORPHAN_PARENT_ALIAS[base] || base);
    if (!target) { leftover.push(orphan); continue; }

    // A plain page-link parent (no submenu) becomes expandable, seeded with itself.
    if (!target.submenu) {
      target.submenu = target.page ? [{ name: target.name, page: target.page }] : [];
    }
    const seenPages = new Set(target.submenu.filter(s => s.page).map(s => s.page));
    const seenNames = new Set(target.submenu.filter(s => !s.separator).map(s => s.name));
    const additions = [];
    for (const s of (orphan.submenu || [])) {
      if (!s.page || seenPages.has(s.page) || seenNames.has(s.name)) continue;
      seenPages.add(s.page);
      seenNames.add(s.name);
      additions.push(s);
    }
    if (additions.length) {
      if (target.submenu.some(s => !s.separator)) {
        target.submenu.push({ name: 'More', separator: true });
      }
      target.submenu.push(...additions);
    }
  }

  return [...merged, ...leftover];
}

const ALL_NAV_ITEMS = buildNavItems(NAV_ITEMS, ORPHAN_NAV_ITEMS);

function sidebarReducer(state, action) {
  switch (action.type) {
    case 'EXPAND':
      return { ...state, expanded: true };
    case 'COLLAPSE':
      return { expanded: false, openMenu: null };
    case 'OPEN_MENU':
      return { expanded: true, openMenu: action.name };
    default:
      return state;
  }
}

export default function Sidebar() {
  const [state, dispatch] = useReducer(sidebarReducer, { expanded: false, openMenu: null });
  const [panelVisible, setPanelVisible] = useState(false);
  const [panelTop, setPanelTop] = useState(0);
  const panelRef = useRef(null);
  const menuRefs = useRef({});
  const collapseTimerRef = useRef(null);

  const navigate = useNavigate();
  const setPage = (pg) => navigate(pg === 'Home' ? '/' : `/${pg}`);

  // Roles are many-to-many — gate on the whole set, never on the primary role
  // alone, or a member's extra roles grant them nothing in the menu.
  const { roles, hasAnyRole, isEmployeeOnly, hasPermission, menuAccess } = useAuth();

  const isMenuVisible = (item) => {
    if (hasAnyRole('super_admin')) return true;
    if (item.name === 'Home') return true;

    // Admin-configured Page Access override wins for both grant and revoke.
    const override = menuAccess(item.name);
    if (override === 'hidden') return false;
    if (override === 'view' || override === 'edit') return true;

    if (hasAnyRole('admin')) return true;

    // Roles governed by an explicit section allowlist (manager/hr/finance/
    // employee). With several roles the allowlists UNION — the most permissive
    // role wins, matching requirePermission's BOOL_OR on the server.
    const allowlistRoles = roles.filter(roleHasSectionAllowlist);
    if (allowlistRoles.some(r => ROLE_SECTION_ALLOWLIST[r].includes(item.name))) return true;
    // Allowlists are authoritative only when EVERY role held has one; otherwise
    // the remaining roles still get their permission-driven check below.
    if (allowlistRoles.length === roles.length && roles.length > 0) return false;

    // Any other role → permission-driven, hidden by default when there is no
    // module grant (never fall through to "show everything").
    if (item.module) return hasPermission(item.module, 'view');
    return false;
  };

  const isAdminRole = hasAnyRole('super_admin', 'admin');

  const visibleItems = ALL_NAV_ITEMS.reduce((acc, rawItem) => {
    if (!isMenuVisible(rawItem)) return acc;

    let item = rawItem;

    // Super-admin-only pages (roles/users/security/system tooling) are hidden
    // from EVERY role except super_admin — admin included.
    if (!hasAnyRole('super_admin')) {
      if (SUPER_ADMIN_ONLY_PAGES.has(item.page)) return acc;
      if (Array.isArray(item.submenu)) {
        const submenu = item.submenu.filter(
          sub => sub.separator || !SUPER_ADMIN_ONLY_PAGES.has(sub.page)
        );
        if (submenu.length !== item.submenu.length) {
          const remaining = submenu.filter(sub => !sub.separator);
          // A submenu stripped down to one surviving page reads as a broken
          // folder (opens a flyout just to reveal a single row) — collapse it
          // into a flat, directly-clickable item named for what's left.
          item = remaining.length === 1
            ? { name: remaining[0].name, icon: item.icon, page: remaining[0].page }
            : { ...item, submenu };
        }
      }
    }

    // Admin-only pages (e.g. Knowledge Base) are hidden from every non-admin role.
    if (!isAdminRole && Array.isArray(item.submenu)) {
      const submenu = item.submenu.filter(
        sub => sub.separator || !ADMIN_ONLY_PAGES.has(sub.page)
      );
      if (submenu.length !== item.submenu.length) item = { ...item, submenu };
    }

    // 'Analytics & AI' is a shared menu where hr/finance/manager can each
    // reach only their own purpose-built dashboard — HR Dashboard + HR
    // Benchmarking for hr, CFO Dashboard for finance, Executive Dashboard for
    // manager — never the CEO/Ops/ERP-Intelligence/System-Health pages that
    // live alongside them, and never each other's dashboard. Built as a union
    // across every restricting role the member holds (not sequential
    // filters), so a dual-role member (e.g. hr + finance) sees both
    // dashboards, not their intersection. Skipped when an explicit admin
    // override has granted the section outright (that unlocks it in full).
    if (
      item.name === 'Analytics & AI' && !isAdminRole &&
      menuAccess(item.name) !== 'view' && menuAccess(item.name) !== 'edit' &&
      Array.isArray(item.submenu) &&
      (hasAnyRole('hr') || hasAnyRole('finance') || hasAnyRole('manager'))
    ) {
      const allowedPages = new Set();
      if (hasAnyRole('hr'))      for (const p of HR_SCOPED_PAGES) allowedPages.add(p);
      if (hasAnyRole('finance')) for (const p of FINANCE_ANALYTICS_SCOPED_PAGES) allowedPages.add(p);
      if (hasAnyRole('manager')) for (const p of MANAGER_ANALYTICS_SCOPED_PAGES) allowedPages.add(p);
      const submenu = item.submenu.filter(
        sub => sub.separator || allowedPages.has(sub.page)
      );
      if (submenu.length !== item.submenu.length) item = { ...item, submenu };
    }

    // Finance sees only self-service items inside the shared Leaves/Attendance
    // menus — never leave approvals, team views, or attendance admin/config
    // screens. Its own 'Finance' section (not in FINANCE_RESTRICTED_SECTIONS)
    // stays untouched. Mirrors the Analytics & AI scoping above.
    if (
      FINANCE_RESTRICTED_SECTIONS.has(item.name) && hasAnyRole('finance') && !isAdminRole &&
      menuAccess(item.name) !== 'view' && menuAccess(item.name) !== 'edit' &&
      Array.isArray(item.submenu)
    ) {
      const submenu = item.submenu.filter(
        sub => sub.separator || FINANCE_SELF_SERVICE_PAGES.has(sub.page)
      );
      if (submenu.length !== item.submenu.length) item = { ...item, submenu };
    }

    // hr_exec sees the full 'HR' menu except Payroll Center — role_permissions
    // grants it no payroll access (unlike hr_manager/payroll_admin, who hold
    // it in full or view-only respectively).
    if (
      item.name === 'HR' && hasAnyRole('hr_exec') && !isAdminRole &&
      menuAccess(item.name) !== 'view' && menuAccess(item.name) !== 'edit' &&
      Array.isArray(item.submenu)
    ) {
      const submenu = item.submenu.filter(
        sub => sub.separator || !HR_EXEC_EXCLUDED_PAGES.has(sub.page)
      );
      if (submenu.length !== item.submenu.length) item = { ...item, submenu };
    }

    // Employees see only self-service items inside each menu group. Applies
    // only when `employee` is the ONLY role held — a member who is also a
    // manager keeps the full submenu.
    if (isEmployeeOnly && Array.isArray(item.submenu)) {
      const submenu = item.submenu.filter(
        sub => !sub.separator && EMPLOYEE_SELF_SERVICE_PAGES.has(sub.page)
      );
      if (submenu.length === 0) return acc; // nothing self-service left → hide menu
      acc.push({ ...item, submenu });
      return acc;
    }

    acc.push(item);
    return acc;
  }, []);

  useEffect(() => {
    if (state.openMenu) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPanelVisible(true);
      const el = menuRefs.current[state.openMenu];
      if (el) setPanelTop(el.getBoundingClientRect().top);
    } else {
      const t = setTimeout(() => setPanelVisible(false), 250);
      return () => clearTimeout(t);
    }
  }, [state.openMenu]);

  // After panelTop is applied to DOM, clamp if panel overflows viewport bottom
  useEffect(() => {
    if (!panelRef.current || !state.openMenu) return;
    const rect = panelRef.current.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 10) {
      setPanelTop(prev => Math.max(10, prev - (rect.bottom - window.innerHeight + 10)));
    }
  }, [panelTop]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function handleClickOutside(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        cancelCollapse();
        dispatch({ type: 'COLLAPSE' });
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    };
  }, []);

  const scheduleCollapse = () => {
    collapseTimerRef.current = setTimeout(() => dispatch({ type: 'COLLAPSE' }), 200);
  };

  const cancelCollapse = () => {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  };

  const handleSidebarLeave = (e) => {
    if (e.relatedTarget instanceof Node && panelRef.current?.contains(e.relatedTarget)) {
      cancelCollapse();
      return;
    }
    scheduleCollapse();
  };

  const handlePanelLeave = (e) => {
    const sidebarEl = document.querySelector('.sidebar');
    if (sidebarEl?.contains(e.relatedTarget)) {
      cancelCollapse();
      return;
    }
    scheduleCollapse();
  };

  const sideWidth = state.expanded ? 260 : 70;

  const activeSubmenu = visibleItems.find(m => m.name === state.openMenu);

  const submenuPanel = panelVisible && (
    <div
      ref={panelRef}
      className={`submenu-panel ${state.openMenu ? 'panel--visible' : ''}`}
      style={{ left: `${sideWidth}px`, top: `${panelTop}px` }}
      onMouseEnter={cancelCollapse}
      onMouseLeave={handlePanelLeave}
    >
      {activeSubmenu && (
        <div className="submenu-header">
          <span className="submenu-header-icon">{activeSubmenu.icon || <FolderOpen size={16} />}</span>
          <span className="submenu-header-name">{activeSubmenu.name}</span>
        </div>
      )}
      {activeSubmenu?.submenu?.map(sub =>
        sub.separator ? (
          <div key={sub.name} className="nav-section-label">{sub.name}</div>
        ) : (
          <button
            key={sub.name}
            className="nav-item"
            onClick={() => { sub.tab ? navigate(`/${sub.page}?tab=${sub.tab}`) : setPage(sub.page); dispatch({ type: 'COLLAPSE' }); }}
          >
            {sub.name}
          </button>
        )
      )}
    </div>
  );

  return (
    <>
      <div
        className={`sidebar ${state.expanded ? 'expanded' : ''}`}
        onMouseEnter={() => { cancelCollapse(); dispatch({ type: 'EXPAND' }); }}
        onMouseLeave={handleSidebarLeave}
      >
        <div className="sidebar-brand">
          <div className="sidebar-brand-btn">
            <Zap size={13} fill="#fff" color="#fff" />
            <span className="sidebar-brand-name">Pulse</span>
          </div>
        </div>
        <ul>
          {visibleItems.map(item => (
            <li
              key={item.name}
              ref={el => { if (el) menuRefs.current[item.name] = el; }}
              onMouseEnter={() => { item.submenu ? dispatch({ type: 'OPEN_MENU', name: item.name }) : dispatch({ type: 'COLLAPSE' }); }}
            >
              <button
                className="nav-item"
                onClick={() => {
                  if (item.page) { setPage(item.page); dispatch({ type: 'COLLAPSE' }); }
                }}
              >
                <span className="icon">{item.icon || <FolderOpen size={16} />}</span>
                <span className="label">{item.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {createPortal(submenuPanel, document.body)}
    </>
  );
}
