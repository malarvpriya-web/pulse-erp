import { Suspense, useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { canRoleOpenPage } from '@/config/menuCatalog';
import { ROUTES } from '@/config/routes';
import PageHero, { PageShell } from './PageHero';

/**
 * TabHub — the shared implementation of the Pulse "hub page": one destination
 * that hosts several related pages as tabs, so the sidebar carries one row
 * instead of six.
 *
 * The pattern already existed by hand in PayrollCenter, ProjectFinancialsHub,
 * VendorCenter, ServiceReviews and a dozen others. This is the same shape,
 * factored out, so the 2026-09-16 IA consolidation could add ~20 more hubs
 * without copying the tab strip, the ?tab= sync and the Suspense boundary that
 * many times. Existing hand-rolled hubs are deliberately left alone.
 *
 *   <TabHub
 *     icon={Boxes} eyebrow="Inventory" title="Stock Control"
 *     subtitle="Balances, movements, reservations and alerts"
 *     tabs={TABS} setPage={setPage} />
 *
 * Each tab: { id, label, icon, page, Component }
 *   `page`      the page key it renders — the permission unit, see below
 *   `Component` a lazy() component; it is rendered with `embedded` plus the
 *               hub's own props, matching how the hand-rolled hubs call theirs.
 *
 * PERMISSIONS — the reason `page` is required.
 * Consolidating a sidebar row into a tab must not widen who can see it. Each
 * tab is filtered through canRoleOpenPage(), the same predicate Layout.jsx
 * enforces at the route and the command palette uses to decide what to list.
 * So a tab whose page the viewer could not have opened from its own menu row
 * is not rendered here either — e.g. an employee opening Travel Desk › Expenses
 * gets the Expense Claims tab but never Expense Review or Payment, exactly as
 * the sidebar filter gave them before the consolidation.
 *
 * This works because the consolidated pages KEEP their NAV_ITEMS entry, marked
 * `inHub: '<HubKey>'` — the row is not drawn in the sidebar, but
 * getSectionForPage() still resolves it, so every section-based gate behaves as
 * it did. Drop the entry instead and the page silently becomes section-less,
 * which makes canRoleAccessPageBySection wave it through for everyone.
 */
export default function TabHub({
  icon,
  eyebrow,
  title,
  subtitle,
  tone,
  tabs,
  setPage,
  ...rest
}) {
  const { role, menuAccess, hasPermission } = useAuth();

  // Two gates, mirroring exactly what Layout.jsx applies at the route:
  //   1. canRoleOpenPage — Page-Access override, the employee/hr/finance/
  //      manager self-service scopings, admin-only, super-admin-only, and the
  //      section allowlist.
  //   2. the page's own `module` permission.
  // (2) matters because a tab renders its component DIRECTLY, not through
  // MERGED_ROUTES, so Layout's module gate never runs for it. Without this a
  // hub would quietly hand someone a page their module grant excludes — the
  // mirror of the bug where the HUB carried a module its children did not and
  // locked out an employee who could open all four pages individually.
  const visible = useMemo(() => tabs.filter(t => {
    if (!t.page) return true;
    if (!canRoleOpenPage(role, t.page, { menuAccess })) return false;
    const mod = ROUTES[t.page]?.module;
    if (!mod || role === 'super_admin' || role === 'admin') return true;
    return hasPermission(mod, 'view');
  }), [tabs, role, menuAccess, hasPermission]);

  const [sp, setSp] = useSearchParams();
  const urlTab = sp.get('tab');
  const ids = visible.map(t => t.id);
  const [active, setActive] = useState(() => (ids.includes(urlTab) ? urlTab : ids[0]));

  useEffect(() => {
    if (ids.includes(urlTab) && urlTab !== active) setActive(urlTab);
  }, [urlTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // The role filter can remove the tab that is currently selected (a dual-role
  // member losing a role mid-session, or an admin revoking a section). Fall
  // back to the first tab the viewer can still open rather than rendering an
  // empty shell.
  useEffect(() => {
    if (ids.length && !ids.includes(active)) setActive(ids[0]);
  }, [ids.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (id) => { setActive(id); setSp({ tab: id }, { replace: true }); };

  if (!visible.length) return null;

  const current = visible.find(t => t.id === active) || visible[0];
  const Body = current.Component;

  return (
    <PageShell dock={
      <PageHero
        icon={icon}
        eyebrow={eyebrow}
        title={title}
        subtitle={subtitle}
        tone={tone}
        actions={visible.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active === id}
            className={`plh-cta${active === id ? '' : ' plh-cta--ghost'}`}
            onClick={() => go(id)}
          >
            {Icon && <Icon size={14} />}{label}
          </button>
        ))}
      />
    }>
      {/* `.plh-tabpanel` neutralises a nested PageShell's geometry from the
          host side — see pulse-hero.css. `embedded` is still passed for the
          few children that honour it, but the class is what actually keeps the
          host's tab strip clickable. */}
      <div className="plh-tabpanel">
        <Suspense fallback={<div className="page-loading" style={{ padding: 48, textAlign: 'center' }}>Loading…</div>}>
          <Body embedded setPage={setPage} {...rest} />
        </Suspense>
      </div>
    </PageShell>
  );
}
