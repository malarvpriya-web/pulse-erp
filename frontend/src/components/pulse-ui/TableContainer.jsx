import { useState, useRef, useEffect } from 'react';
import { Search, Download, Columns3, ChevronDown } from 'lucide-react';
import Pagination from '@/features/_shared/Pagination';
import LoadingState from './LoadingState';
import './pulse-ui.css';

/**
 * TableContainer — chrome around a CALLER-OWNED `<table>` (toolbar with
 * search/filter slot/column-picker/export/bulk-action bar, card shell,
 * pagination footer, sticky header when `maxHeight` is set) — not a fully
 * controlled grid. The caller keeps its own `<thead>`/`<tbody>` JSX, sort
 * state, and cell rendering; TableContainer only supplies the surrounding
 * chrome and (when `columns` is supplied) the column-visibility picker UI.
 * Column filtering itself stays the caller's job (its render already checks
 * `hiddenColumns.has(key)`) — this is what makes adoption a wrap, not a
 * rewrite, of each page's existing table body.
 *
 * Pagination is not reimplemented: pass `usePagination()`'s return value
 * straight through as `pagination` — TableContainer adapts its field names
 * to `features/_shared/Pagination`.
 *
 * @param {object} props
 * @param {React.ReactNode} props.children the `<table>` markup (or a scrollable list)
 * @param {boolean} [props.loading]
 * @param {boolean} [props.isEmpty]
 * @param {React.ReactNode} [props.emptyState] rendered instead of children when `!loading && isEmpty`
 * @param {{value:string,onChange:Function,placeholder?:string}} [props.search]
 * @param {React.ReactNode} [props.filters]
 * @param {Array<{key:string,label:string,required?:boolean}>} [props.columns] drives the column-picker menu
 * @param {Set<string>} [props.hiddenColumns]
 * @param {Function} [props.onToggleColumn] `(key) => void`
 * @param {Function} [props.onExport] shown as a toolbar button when supplied
 * @param {{page:number,totalPages:number,total:number,pageSize:number,next:Function,prev:Function,goTo:Function,setPageSize:Function}} [props.pagination]
 *   pass `usePagination()`'s return value directly
 * @param {Array} [props.selectedRows] bulk-action bar shows when non-empty
 * @param {React.ReactNode} [props.bulkActions]
 * @param {number} [props.rowCount] "{rowCount} records" shown when no `pagination` is supplied
 * @param {string} [props.maxHeight] caps the table body with its own internal
 *   scroll + sticky `<thead>` (a separate, smaller scrolling context from
 *   PageHeader's page-level sticky — no z-index conflict between the two)
 * @param {React.ReactNode} [props.toolbarRight] escape hatch for a page that
 *   needs custom toolbar-right controls the built-in `pagination` prop can't
 *   express (e.g. a non-standard page-size list) — rendered after the
 *   export/column-picker buttons.
 */
export default function TableContainer({
  children, loading, isEmpty, emptyState,
  search, filters, columns, hiddenColumns, onToggleColumn, onExport,
  pagination, selectedRows, bulkActions, rowCount, maxHeight, toolbarRight,
}) {
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const colMenuRef = useRef(null);

  useEffect(() => {
    if (!colMenuOpen) return;
    const onDocClick = (e) => {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target)) setColMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [colMenuOpen]);

  const hasToolbar = Boolean(search || filters || (columns && columns.length > 0) || onExport || toolbarRight);
  const hasSelection = Boolean(selectedRows && selectedRows.length > 0);
  const showFooter = !loading && !isEmpty && (pagination || rowCount != null);

  return (
    <div className="pl-card">
      {hasToolbar && (
        <div className="pl-table-toolbar">
          <div className="pl-table-toolbar-left">
            {search && (
              <div className="pl-toolbar-search" style={{ width: 220 }}>
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
            {filters}
          </div>
          <div className="pl-table-toolbar-right">
            {onExport && (
              <button type="button" className="pl-icon-btn" onClick={onExport}>
                <Download size={13} aria-hidden="true" /> Export
              </button>
            )}
            {columns && columns.length > 0 && (
              <div className="pl-col-picker" ref={colMenuRef}>
                <button
                  type="button"
                  className={`pl-icon-btn${colMenuOpen ? ' pl-active' : ''}`}
                  onClick={() => setColMenuOpen((v) => !v)}
                >
                  <Columns3 size={13} aria-hidden="true" /> Columns <ChevronDown size={12} aria-hidden="true" />
                </button>
                {colMenuOpen && (
                  <div className="pl-col-menu">
                    {columns.map((col) => (
                      <label key={col.key}>
                        <input
                          type="checkbox"
                          checked={!hiddenColumns?.has(col.key)}
                          disabled={col.required}
                          onChange={() => onToggleColumn?.(col.key)}
                        />
                        {col.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
            {toolbarRight}
          </div>
        </div>
      )}

      {hasSelection && (
        <div className="pl-bulk-bar">
          <span>{selectedRows.length} selected</span>
          <div className="pl-bulk-actions">{bulkActions}</div>
        </div>
      )}

      {loading ? (
        <div style={{ padding: 16 }}>
          <LoadingState shape="table" rows={6} />
        </div>
      ) : isEmpty ? (
        emptyState
      ) : (
        <div
          className={`pl-table-scroll${maxHeight ? ' pl-scroll-y' : ''}`}
          style={maxHeight ? { maxHeight } : undefined}
        >
          {children}
        </div>
      )}

      {showFooter && (
        pagination ? (
          <div style={{ padding: '0 16px' }}>
            <Pagination
              page={pagination.page}
              totalPages={pagination.totalPages}
              total={pagination.total}
              pageSize={pagination.pageSize}
              onNext={pagination.next}
              onPrev={pagination.prev}
              onGoTo={pagination.goTo}
              onPageSizeChange={pagination.setPageSize}
            />
          </div>
        ) : (
          <div className="pl-table-footer">
            <span>{rowCount} {rowCount === 1 ? 'record' : 'records'}</span>
          </div>
        )
      )}
    </div>
  );
}
