import './pulse-ui.css';

/**
 * ContentCard — generic white card shell (extends `.pulse-card`). Replaces
 * the `{background:'#fff', borderRadius:12, border:'1px solid #f0f0f4'}`
 * literal repeated across most pages.
 *
 * @param {object} props
 * @param {React.ReactNode} props.children
 * @param {string} [props.title]
 * @param {React.ReactNode} [props.headerActions]
 * @param {boolean} [props.noPadding] for content (a table, a list) that
 *   should touch the card edges.
 * @param {string} [props.className]
 */
export default function ContentCard({ children, title, headerActions, noPadding = false, className = '' }) {
  return (
    <div className={`pl-card${className ? ` ${className}` : ''}`}>
      {(title || headerActions) && (
        <div className="pl-card-header">
          {title && <h3 className="pl-card-title">{title}</h3>}
          {headerActions && <div className="pl-actions">{headerActions}</div>}
        </div>
      )}
      <div className={noPadding ? 'pl-card-body pl-card-body--flush' : 'pl-card-body'}>
        {children}
      </div>
    </div>
  );
}
