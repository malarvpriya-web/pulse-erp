import { useParams, useNavigate } from 'react-router-dom';
import { Search, ChevronRight } from 'lucide-react';
import { getSectionForPage } from '@/config/menuCatalog';
import { getPageTitle } from '@/config/autoRouter';
import './pulse-ui.css';

/**
 * Breadcrumb — renders a trail of `{ label, onClick? }` crumbs. The last
 * item is always rendered as the current (non-clickable) crumb regardless
 * of whether it carries an onClick.
 */
export function Breadcrumb({ trail }) {
  if (!trail || trail.length === 0) return null;
  return (
    <div className="pl-breadcrumb">
      {trail.map((crumb, i) => {
        const isLast = i === trail.length - 1;
        return (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {i > 0 && <ChevronRight size={11} className="pl-breadcrumb-sep" aria-hidden="true" />}
            {crumb.onClick && !isLast ? (
              <button type="button" className="pl-breadcrumb-link" onClick={crumb.onClick}>
                {crumb.label}
              </button>
            ) : (
              <span className={isLast ? 'pl-breadcrumb-current' : ''}>{crumb.label}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/**
 * PageHeader — sticky title row: breadcrumb + title + description + primary
 * actions + optional inline search + optional filter slot.
 *
 * Breadcrumb is auto-derived as "Home / {module} / {title}" from
 * `getSectionForPage`/`getPageTitle` (config/menuCatalog.js,
 * config/autoRouter.js) using the route's `page` param — most callers pass
 * nothing and get a correct trail for free. Pass `breadcrumb` to fully
 * override (e.g. a detail page wanting a 4th crumb with the record name).
 *
 * @param {object} props
 * @param {string} [props.pageKey] route key (e.g. 'ItemMaster'). Defaults to
 *   the current route's `:page` param (same source Layout.jsx resolves).
 * @param {Array<{label:string,onClick?:Function}>} [props.breadcrumb]
 *   explicit override — replaces the derived trail entirely.
 * @param {string} [props.title] overrides the derived getPageTitle(pageKey).
 * @param {string} [props.description] optional subtitle line.
 * @param {React.ReactNode} [props.actions] right-aligned buttons — caller
 *   renders its own `.pulse-btn-primary`/`.pulse-btn-secondary` etc.
 * @param {{value:string,onChange:Function,placeholder?:string}} [props.search]
 * @param {React.ReactNode} [props.filters] slot under the title row.
 * @param {boolean} [props.sticky=true] set false to render as a normal
 *   (non-pinned) block, e.g. reused inside a modal.
 */
export default function PageHeader({
  pageKey, breadcrumb, title, description, actions, search, filters, sticky = true,
}) {
  const params = useParams();
  const navigate = useNavigate();
  const resolvedKey = pageKey || params.page || '';
  const resolvedTitle = title || getPageTitle(resolvedKey);
  const section = getSectionForPage(resolvedKey);

  const trail = breadcrumb || [
    { label: 'Home', onClick: () => navigate('/') },
    ...(section ? [{ label: section }] : []),
    { label: resolvedTitle },
  ];

  return (
    <div className={`pl-header${sticky ? '' : ' pl-header--static'}`}>
      <Breadcrumb trail={trail} />
      <div className="pl-header-top">
        <div className="pl-title-wrap">
          <h1 className="pl-title">{resolvedTitle}</h1>
          {description && <p className="pl-description">{description}</p>}
        </div>
        {actions && <div className="pl-actions">{actions}</div>}
      </div>
      {(search || filters) && (
        <div className="pl-toolbar">
          {search && (
            <div className="pl-toolbar-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="text"
                value={search.value}
                onChange={(e) => search.onChange(e.target.value)}
                placeholder={search.placeholder || 'Search...'}
                aria-label={search.placeholder || 'Search'}
              />
            </div>
          )}
          {filters && <div className="pl-toolbar-filters">{filters}</div>}
        </div>
      )}
    </div>
  );
}
