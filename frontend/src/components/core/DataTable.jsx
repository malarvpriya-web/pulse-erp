// PATH: frontend/src/components/core/DataTable.jsx
/**
 * DataTable — Feature-rich table with:
 *  - Column resizing (drag handle)
 *  - Column visibility toggle
 *  - Sticky header + optional sticky first column
 *  - Shift-click range selection + checkbox select-all
 *  - Inline edit (double-click cell → Enter/Esc)
 *  - Virtual scrolling for >500 rows (renders a 40px-row window)
 *  - Row grouping with collapsible groups
 *  - Sort indicators (integrates with useTableData toggleSort)
 *  - Pagination controls
 *  - Export selected rows (CSV)
 *
 * @example
 * <DataTable
 *   columns={[
 *     { key: 'name',   label: 'Name',   sortable: true, editable: true, sticky: true },
 *     { key: 'amount', label: 'Amount', sortable: true, render: (v) => `₹${v}` },
 *   ]}
 *   rows={rows}
 *   sort={{ key: 'name', dir: 'asc' }}
 *   onSort={toggleSort}
 *   page={page}
 *   pageSize={20}
 *   totalCount={totalCount}
 *   onPageChange={setPage}
 *   onCellEdit={(rowIndex, key, value) => handleEdit(rowIndex, key, value)}
 *   groupBy="department"
 *   loading={loading}
 * />
 */
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { ChevronUp, ChevronDown, Eye, Download, ChevronRight } from 'lucide-react';

const PURPLE = '#7c3aed';
const BORDER = '#e9e4ff';
const LIGHT  = '#f5f3ff';
const ROW_H  = 40;
const VIRTUAL_THRESHOLD = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function exportCSV(columns, rows, visibleKeys) {
  const cols   = columns.filter(c => visibleKeys.has(c.key));
  const header = cols.map(c => `"${c.label}"`).join(',');
  const body   = rows.map(row =>
    cols.map(c => {
      const v       = row[c.key];
      const display = c.render ? c.render(v, row) : (v ?? '');
      return `"${String(display).replace(/"/g, '""')}"`;
    }).join(',')
  ).join('\n');
  const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'export.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Column visibility toggle
// ---------------------------------------------------------------------------
function ColumnToggle({ columns, visible, setVisible }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(p => !p)} title="Show/hide columns" style={{
        padding: '5px 10px', background: open ? LIGHT : '#fff',
        border: `1px solid ${BORDER}`, borderRadius: 6, cursor: 'pointer', fontSize: 12,
        display: 'flex', alignItems: 'center', gap: 4, color: PURPLE,
      }}>
        <Eye size={13} /> Columns
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: '100%', zIndex: 300, marginTop: 4,
          background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 8,
          boxShadow: '0 8px 24px rgba(124,58,237,0.12)', padding: '6px 0', minWidth: 180,
        }}>
          {columns.map(c => (
            <label key={c.key} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px',
              cursor: 'pointer', fontSize: 13, color: '#374151',
            }}>
              <input type="checkbox" checked={visible.has(c.key)}
                onChange={() => setVisible(prev => {
                  const next = new Set(prev);
                  next.has(c.key) ? next.delete(c.key) : next.add(c.key);
                  return next;
                })}
                style={{ accentColor: PURPLE }} />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline edit cell
// ---------------------------------------------------------------------------
function EditCell({ value, onCommit }) {
  const [val, setVal] = useState(String(value ?? ''));
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  return (
    <input
      ref={inputRef}
      value={val}
      onChange={e => setVal(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter')  onCommit(val);
        if (e.key === 'Escape') onCommit(null);
      }}
      onBlur={() => onCommit(val)}
      style={{
        border: `1.5px solid ${PURPLE}`, borderRadius: 4,
        padding: '2px 6px', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Main DataTable
// ---------------------------------------------------------------------------
export default function DataTable({
  columns            = [],
  rows               = [],
  sort               = { key: '', dir: 'asc' },
  onSort,
  page               = 1,
  pageSize           = 20,
  totalCount,
  onPageChange,
  loading            = false,
  onCellEdit,
  groupBy,
  stickyFirstColumn  = false,
  selectable         = true,
  onSelectionChange,
  emptyText          = 'No data found',
}) {
  const [visibleCols,      setVisibleCols]      = useState(() => new Set(columns.map(c => c.key)));
  const [selected,         setSelected]         = useState(new Set());
  const [lastSelected,     setLastSelected]     = useState(null);
  const [editCell,         setEditCell]         = useState(null);
  const [colWidths,        setColWidths]        = useState({});
  const [collapsedGroups,  setCollapsedGroups]  = useState(new Set());
  const [scrollTop,        setScrollTop]        = useState(0);
  const scrollRef = useRef(null);

  const totalPages = totalCount ? Math.ceil(totalCount / pageSize) : 1;
  const useVirtual = rows.length > VIRTUAL_THRESHOLD && !groupBy;

  const visibleColumns = useMemo(() =>
    columns.filter(c => visibleCols.has(c.key)),
    [columns, visibleCols]
  );

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------
  const toggleSelect = useCallback((index, shiftHeld) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (shiftHeld && lastSelected !== null) {
        const from = Math.min(lastSelected, index);
        const to   = Math.max(lastSelected, index);
        for (let i = from; i <= to; i++) next.add(i);
      } else {
        next.has(index) ? next.delete(index) : next.add(index);
      }
      onSelectionChange?.(Array.from(next).map(i => rows[i]));
      return next;
    });
    setLastSelected(index);
  }, [lastSelected, rows, onSelectionChange]);

  const toggleSelectAll = useCallback(() => {
    if (selected.size === rows.length) {
      setSelected(new Set());
      onSelectionChange?.([]);
    } else {
      const all = new Set(rows.map((_, i) => i));
      setSelected(all);
      onSelectionChange?.(rows);
    }
  }, [rows, selected.size, onSelectionChange]);

  // ---------------------------------------------------------------------------
  // Column resize
  // ---------------------------------------------------------------------------
  const startResize = useCallback((colKey, e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[colKey] || 140;
    const onMove = (ev) => {
      setColWidths(prev => ({ ...prev, [colKey]: Math.max(60, startW + ev.clientX - startX) }));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  }, [colWidths]);

  // ---------------------------------------------------------------------------
  // Grouping
  // ---------------------------------------------------------------------------
  const groupedData = useMemo(() => {
    if (!groupBy) return null;
    const map = new Map();
    rows.forEach((row, i) => {
      const key = row[groupBy] ?? '(Blank)';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ row, originalIndex: i });
    });
    return Array.from(map.entries());
  }, [rows, groupBy]);

  // ---------------------------------------------------------------------------
  // Virtual scroll
  // ---------------------------------------------------------------------------
  const handleScroll = useCallback((e) => setScrollTop(e.currentTarget.scrollTop), []);

  const virtualWindow = useMemo(() => {
    if (!useVirtual) return null;
    const containerH = 500;
    const startIdx   = Math.max(0, Math.floor(scrollTop / ROW_H) - 3);
    const endIdx     = Math.min(rows.length, startIdx + Math.ceil(containerH / ROW_H) + 6);
    return { startIdx, endIdx, totalH: rows.length * ROW_H };
  }, [useVirtual, scrollTop, rows.length]);

  // ---------------------------------------------------------------------------
  // Render row
  // ---------------------------------------------------------------------------
  const renderRow = useCallback((row, rowIndex) => {
    const isSel = selected.has(rowIndex);
    return (
      <tr
        key={rowIndex}
        onClick={(e) => selectable && toggleSelect(rowIndex, e.shiftKey)}
        style={{
          background:   isSel ? LIGHT : '#fff',
          cursor:       selectable ? 'pointer' : 'default',
          borderBottom: `1px solid ${BORDER}`,
          height:       ROW_H,
        }}>
        {selectable && (
          <td style={{
            width: 36, padding: '0 10px', textAlign: 'center',
            ...(stickyFirstColumn ? { position: 'sticky', left: 0, background: isSel ? LIGHT : '#fff', zIndex: 1 } : {}),
          }}>
            <input type="checkbox" checked={isSel} onChange={() => toggleSelect(rowIndex, false)}
              onClick={e => e.stopPropagation()} style={{ accentColor: PURPLE }} />
          </td>
        )}
        {visibleColumns.map((col, ci) => {
          const isEditing = editCell?.rowIndex === rowIndex && editCell?.colKey === col.key;
          const val       = row[col.key];
          const isSticky  = ci === 0 && stickyFirstColumn;
          return (
            <td
              key={col.key}
              onDoubleClick={() => col.editable && onCellEdit && setEditCell({ rowIndex, colKey: col.key })}
              style={{
                padding:       '0 12px',
                fontSize:      13,
                color:         '#374151',
                width:         colWidths[col.key] || col.width || 140,
                maxWidth:      colWidths[col.key] || col.width || 200,
                overflow:      'hidden',
                textOverflow:  'ellipsis',
                whiteSpace:    'nowrap',
                textAlign:     col.align || 'left',
                ...(isSticky ? { position: 'sticky', left: selectable ? 36 : 0, background: isSel ? LIGHT : '#fff', zIndex: 1 } : {}),
              }}>
              {isEditing ? (
                <EditCell value={val} onCommit={(newVal) => {
                  setEditCell(null);
                  if (newVal !== null && newVal !== String(val ?? '')) onCellEdit(rowIndex, col.key, newVal);
                }} />
              ) : (
                col.render ? col.render(val, row, rowIndex) : (val ?? '—')
              )}
            </td>
          );
        })}
      </tr>
    );
  }, [selected, selectable, stickyFirstColumn, visibleColumns, editCell, colWidths, toggleSelect, onCellEdit]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const selectedRows = Array.from(selected).map(i => rows[i]).filter(Boolean);

  const colSpan = visibleColumns.length + (selectable ? 1 : 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          {(totalCount ?? rows.length).toLocaleString('en-IN')} rows
          {selected.size > 0 && ` · ${selected.size} selected`}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          {selected.size > 0 && (
            <button onClick={() => exportCSV(columns, selectedRows, visibleCols)} style={{
              padding: '5px 12px', border: `1px solid ${BORDER}`, borderRadius: 6,
              background: '#fff', color: PURPLE, cursor: 'pointer', fontSize: 12,
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <Download size={13} /> Export {selected.size} rows
            </button>
          )}
          <ColumnToggle columns={columns} visible={visibleCols} setVisible={setVisibleCols} />
        </div>
      </div>

      {/* Table */}
      <div
        ref={scrollRef}
        onScroll={useVirtual ? handleScroll : undefined}
        style={{
          overflowX:    'auto',
          overflowY:    useVirtual ? 'auto' : 'visible',
          maxHeight:    useVirtual ? 500 : undefined,
          border:       `1px solid ${BORDER}`,
          borderRadius: 10,
        }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <thead>
            <tr style={{ background: LIGHT, borderBottom: `2px solid ${BORDER}` }}>
              {selectable && (
                <th style={{
                  width: 36, padding: '0 10px',
                  position: 'sticky', top: 0, background: LIGHT, zIndex: 3,
                  ...(stickyFirstColumn ? { left: 0, zIndex: 4 } : {}),
                }}>
                  <input type="checkbox"
                    checked={rows.length > 0 && selected.size === rows.length}
                    onChange={toggleSelectAll}
                    style={{ accentColor: PURPLE }} />
                </th>
              )}
              {visibleColumns.map((col, ci) => {
                const isSticky = ci === 0 && stickyFirstColumn;
                return (
                  <th
                    key={col.key}
                    onClick={() => col.sortable && onSort?.(col.key)}
                    style={{
                      padding:    '10px 12px',
                      fontSize:   12,
                      fontWeight: 600,
                      color:      sort.key === col.key ? PURPLE : '#6b7280',
                      cursor:     col.sortable ? 'pointer' : 'default',
                      userSelect: 'none',
                      whiteSpace: 'nowrap',
                      textAlign:  col.align || 'left',
                      width:      colWidths[col.key] || col.width || 140,
                      position:   'sticky',
                      top:        0,
                      background: LIGHT,
                      zIndex:     isSticky ? 4 : 2,
                      ...(isSticky ? { left: selectable ? 36 : 0 } : {}),
                    }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, position: 'relative' }}>
                      {col.label}
                      {col.sortable && sort.key === col.key
                        ? (sort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
                        : col.sortable && <ChevronDown size={12} style={{ opacity: 0.25 }} />}
                      {/* Resize handle */}
                      <div
                        onMouseDown={(e) => startResize(col.key, e)}
                        onClick={e => e.stopPropagation()}
                        style={{
                          position: 'absolute', right: -6, top: 0, bottom: 0,
                          width: 8, cursor: 'col-resize',
                        }}
                      />
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={colSpan} style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading…</td></tr>
            )}

            {!loading && rows.length === 0 && (
              <tr><td colSpan={colSpan} style={{ padding: 48, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>{emptyText}</td></tr>
            )}

            {/* Grouped rows */}
            {!loading && groupedData && groupedData.map(([groupKey, groupRows]) => {
              const isCollapsed = collapsedGroups.has(groupKey);
              return [
                <tr key={`grp-${groupKey}`} style={{ background: '#f9f7ff', borderBottom: `1px solid ${BORDER}` }}>
                  <td colSpan={colSpan} style={{ padding: '8px 14px' }}>
                    <button onClick={() => setCollapsedGroups(prev => {
                      const next = new Set(prev);
                      next.has(groupKey) ? next.delete(groupKey) : next.add(groupKey);
                      return next;
                    })} style={{
                      border: 'none', background: 'transparent', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600,
                      fontSize: 12, color: PURPLE,
                    }}>
                      <ChevronRight size={13} style={{ transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 0.2s' }} />
                      {groupKey} <span style={{ color: '#9ca3af', fontWeight: 400 }}>({groupRows.length})</span>
                    </button>
                  </td>
                </tr>,
                ...(!isCollapsed ? groupRows.map(({ row, originalIndex }) => renderRow(row, originalIndex)) : []),
              ];
            })}

            {/* Virtual scroll */}
            {!loading && useVirtual && virtualWindow && (
              <>
                {virtualWindow.startIdx > 0 && (
                  <tr style={{ height: virtualWindow.startIdx * ROW_H }}><td /></tr>
                )}
                {rows.slice(virtualWindow.startIdx, virtualWindow.endIdx).map((row, i) =>
                  renderRow(row, virtualWindow.startIdx + i)
                )}
                {virtualWindow.endIdx < rows.length && (
                  <tr style={{ height: (rows.length - virtualWindow.endIdx) * ROW_H }}><td /></tr>
                )}
              </>
            )}

            {/* Normal rows */}
            {!loading && !groupedData && !useVirtual && rows.map((row, i) => renderRow(row, i))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {onPageChange && totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            Page {page} of {totalPages}
            {totalCount != null && ` · ${totalCount.toLocaleString('en-IN')} total`}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            {[
              { label: '«', target: 1,          disabled: page <= 1 },
              { label: '‹', target: page - 1,   disabled: page <= 1 },
              { label: '›', target: page + 1,   disabled: page >= totalPages },
              { label: '»', target: totalPages,  disabled: page >= totalPages },
            ].map(btn => (
              <button key={btn.label} onClick={() => !btn.disabled && onPageChange(btn.target)}
                disabled={btn.disabled}
                style={{
                  padding:    '5px 10px',
                  border:     `1px solid ${BORDER}`,
                  borderRadius: 6,
                  background: '#fff',
                  cursor:     btn.disabled ? 'default' : 'pointer',
                  color:      btn.disabled ? '#d1d5db' : PURPLE,
                  fontSize:   13,
                  fontWeight: 500,
                }}>
                {btn.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
