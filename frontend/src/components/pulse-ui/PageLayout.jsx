import './pulse-ui.css';

/**
 * PageLayout — canonical page-shell root. Renders as the first child inside
 * `.page-content` (the app's one scroll container, see Layout.css).
 *
 * @param {object} props
 * @param {React.ReactNode} props.children
 * @param {'default'|'hero'} [props.variant='default']
 *   'default' — className="pulse-page" (Layout.css's existing, documented
 *               page-root contract: padding 24px, bg var(--color-bg-page),
 *               min-height calc(100vh - 64px)). This is the variant nearly
 *               every page should use.
 *   'hero'    — edge-to-edge band (`margin:-20px` cancelling .page-content's
 *               own 20px padding — the same convention already used by
 *               GoodsReceipt/ApplyLeave/EmployeesDashboard). Only use when a
 *               page genuinely needs to bleed to the viewport edges.
 * @param {string} [props.maxWidth] optional cap in px/rem/etc. CLAUDE.md
 *   rule: never set this except for intentionally narrow (<1000px) centered
 *   forms/wizards — full-width is the default for a reason.
 * @param {string} [props.className] extra class(es) appended to the root.
 */
export default function PageLayout({ children, variant = 'default', maxWidth, className = '' }) {
  const rootClass = variant === 'hero' ? 'pl-root--hero' : 'pulse-page';
  const style = maxWidth ? { maxWidth, marginLeft: 'auto', marginRight: 'auto' } : undefined;

  return (
    <div className={`${rootClass}${className ? ` ${className}` : ''}`} style={style}>
      {children}
    </div>
  );
}
