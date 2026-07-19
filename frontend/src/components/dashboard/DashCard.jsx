// PATH: frontend/src/components/dashboard/DashCard.jsx
// Reusable compact dashboard card — the shared building block for the redesigned
// dashboards. Provides: staggered entrance animation, an optional "View all"
// link to a detail page, and an optional Expand button that opens the card's
// contents full-size in a modal (so dashboards can stay compact / fit-to-window
// while every graph & list is still one click away from full detail).
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X, ArrowUpRight } from 'lucide-react';
import './DashCard.css';

/* ChartExpandButton — drop-in expand control for existing/bespoke card headers.
 * Renders just the icon button; on click it shows `children` (typically a
 * larger copy of the chart) in a centered modal. Lets any legacy dashboard get
 * the "expand the graph" behaviour without being rebuilt around DashCard. */
export function ChartExpandButton({ title, subtitle, children, onViewAll, viewAllLabel = 'View all' }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open]);
  return (
    <>
      <button className="dc-iconbtn" title="Expand" aria-label="Expand" onClick={() => setOpen(true)}>
        <Maximize2 size={13} />
      </button>
      {open && createPortal(
        <div className="dc-overlay" onClick={() => setOpen(false)}>
          <div className="dc-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="dc-hd">
              <div className="dc-hd-l">
                <div className="dc-titles">
                  <div className="dc-modal-title">{title}</div>
                  {subtitle && <div className="dc-sub">{subtitle}</div>}
                </div>
              </div>
              <div className="dc-hd-r">
                {onViewAll && <button className="dc-link" onClick={onViewAll}>{viewAllLabel} <ArrowUpRight size={12} /></button>}
                <button className="dc-iconbtn" title="Close" aria-label="Close" onClick={() => setOpen(false)}><X size={16} /></button>
              </div>
            </div>
            <div className="dc-modal-body">{children}</div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

export default function DashCard({
  title,
  subtitle,
  icon,                 // lucide element, e.g. <Users size={14} />
  iconColor,            // tints the icon chip; falls back to brand purple
  onViewAll,            // () => setPage('SomePage') — renders a "View all" link
  viewAllLabel = 'View all',
  expandable = false,   // renders the Expand button + enables the modal
  expandedChildren,     // optional richer/taller render for the modal (defaults to children)
  headerRight,          // custom node rendered before the view-all / expand controls
  index = 0,            // stagger position for the entrance animation
  className = '',
  bodyClassName = '',
  style,
  children,
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  const controls = (inModal) => (
    <div className="dc-hd-r">
      {!inModal && headerRight}
      {onViewAll && (
        <button className="dc-link" onClick={onViewAll}>
          {viewAllLabel} <ArrowUpRight size={12} />
        </button>
      )}
      {inModal ? (
        <button className="dc-iconbtn" title="Close" aria-label="Close" onClick={() => setOpen(false)}>
          <X size={16} />
        </button>
      ) : expandable ? (
        <button className="dc-iconbtn" title="Expand" aria-label="Expand" onClick={() => setOpen(true)}>
          <Maximize2 size={13} />
        </button>
      ) : null}
    </div>
  );

  const header = (inModal) => (
    <div className="dc-hd">
      <div className="dc-hd-l">
        {icon && (
          <span
            className="dc-icon"
            style={{ color: iconColor || '#6B3FDB', background: `${iconColor || '#6B3FDB'}14` }}
          >
            {icon}
          </span>
        )}
        <div className="dc-titles">
          <div className={inModal ? 'dc-modal-title' : 'dc-title'}>{title}</div>
          {subtitle && <div className="dc-sub">{subtitle}</div>}
        </div>
      </div>
      {controls(inModal)}
    </div>
  );

  return (
    <>
      <div
        className={`dc-card ${className}`}
        style={{ ...style, '--dc-i': index }}
      >
        {header(false)}
        <div className={`dc-body ${bodyClassName}`}>{children}</div>
      </div>

      {open && createPortal(
        <div className="dc-overlay" onClick={() => setOpen(false)}>
          <div className="dc-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            {header(true)}
            <div className="dc-modal-body">{expandedChildren || children}</div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
