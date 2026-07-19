// PATH: frontend/src/components/core/FilterBar.jsx
/**
 * FilterBar — reusable, fully-controlled filter bar for tables and charts.
 *
 * All state is managed by the parent via `values` + `onChange`.
 * This component is purely presentational — it never holds its own filter state.
 *
 * @example
 * const [values, setValues] = useState({ department: 'All', status: 'active', dateFrom: '', dateTo: '' });
 *
 * <FilterBar
 *   filters={[
 *     { key: 'department', label: 'Department', type: 'select',
 *       options: [{value:'All',label:'All'},{value:'Engineering',label:'Engineering'}] },
 *     { key: 'status',     label: 'Status',     type: 'select',
 *       options: [{value:'active',label:'Active'},{value:'inactive',label:'Inactive'}] },
 *     { key: 'dateFrom',   label: 'From',       type: 'date' },
 *     { key: 'dateTo',     label: 'To',         type: 'date' },
 *     { key: 'q',          label: 'Search',     type: 'search', placeholder: 'Search...' },
 *   ]}
 *   values={values}
 *   onChange={(key, val) => setValues(p => ({ ...p, [key]: val }))}
 *   onReset={() => setValues(defaults)}
 *   onExport={(format) => handleExport(format)}
 * />
 */
import { useState, useRef, useEffect } from 'react';
import { Search, X, Download, ChevronDown, SlidersHorizontal } from 'lucide-react';

const INPUT_BASE = {
  padding: '6px 10px',
  border: '1px solid #e9e4ff',
  borderRadius: 7,
  fontSize: 13,
  color: '#111827',
  background: '#fff',
  outline: 'none',
  transition: 'border-color 0.15s',
};

// ---------------------------------------------------------------------------
// Individual filter controls
// ---------------------------------------------------------------------------

function SelectFilter({ cfg, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <label style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>{cfg.label}</label>
      <select
        value={value || ''}
        onChange={e => onChange(cfg.key, e.target.value)}
        style={{ ...INPUT_BASE, width: cfg.width || 160, cursor: 'pointer' }}>
        {cfg.placeholder && <option value="">{cfg.placeholder}</option>}
        {(cfg.options || []).map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function DateFilter({ cfg, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <label style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>{cfg.label}</label>
      <input
        type="date"
        value={value || ''}
        onChange={e => onChange(cfg.key, e.target.value)}
        style={{ ...INPUT_BASE, width: cfg.width || 140 }} />
    </div>
  );
}

function DateRangeFilter({ cfg, value = {}, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <label style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>{cfg.label}</label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="date"
          value={value.from || ''}
          onChange={e => onChange(cfg.key, { ...value, from: e.target.value })}
          style={{ ...INPUT_BASE, width: 130 }} />
        <span style={{ fontSize: 11, color: '#9ca3af' }}>to</span>
        <input
          type="date"
          value={value.to || ''}
          onChange={e => onChange(cfg.key, { ...value, to: e.target.value })}
          style={{ ...INPUT_BASE, width: 130 }} />
      </div>
    </div>
  );
}

function SearchFilter({ cfg, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <label style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>{cfg.label}</label>
      <div style={{ position: 'relative' }}>
        <Search size={13} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
        <input
          type="text"
          value={value || ''}
          placeholder={cfg.placeholder || 'Search...'}
          onChange={e => onChange(cfg.key, e.target.value)}
          style={{ ...INPUT_BASE, paddingLeft: 28, width: cfg.width || 180 }} />
        {value && (
          <button onClick={() => onChange(cfg.key, '')} style={{
            position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
            border: 'none', background: 'transparent', cursor: 'pointer', padding: 2, color: '#9ca3af',
          }}>
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function MultiSelectFilter({ cfg, value = [], onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (val) => {
    const current = Array.isArray(value) ? value : [];
    const next = current.includes(val) ? current.filter(v => v !== val) : [...current, val];
    onChange(cfg.key, next);
  };

  const selected = Array.isArray(value) ? value : [];
  const labels = (cfg.options || []).filter(o => selected.includes(o.value));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }} ref={ref}>
      <label style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>{cfg.label}</label>
      <div
        onClick={() => setOpen(p => !p)}
        style={{
          ...INPUT_BASE, width: cfg.width || 180, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', minHeight: 32,
        }}>
        {labels.length === 0 && (
          <span style={{ color: '#9ca3af', fontSize: 12 }}>{cfg.placeholder || `Select ${cfg.label}`}</span>
        )}
        {labels.map(l => (
          <span key={l.value} style={{
            padding: '1px 6px', background: '#f0ebff', color: '#7c3aed',
            borderRadius: 4, fontSize: 11, display: 'flex', alignItems: 'center', gap: 3,
          }}>
            {l.label}
            <button
              onClick={(e) => { e.stopPropagation(); toggle(l.value); }}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, color: '#7c3aed', lineHeight: 1 }}>
              ×
            </button>
          </span>
        ))}
        <ChevronDown size={12} style={{ marginLeft: 'auto', color: '#9ca3af' }} />
      </div>
      {open && (
        <div style={{
          position: 'absolute', zIndex: 200, background: '#fff',
          border: '1px solid #e9e4ff', borderRadius: 8, boxShadow: '0 8px 24px rgba(124,58,237,0.1)',
          padding: '4px 0', minWidth: cfg.width || 180, maxHeight: 220, overflowY: 'auto',
          marginTop: 36,
        }}>
          {(cfg.options || []).map(o => (
            <label key={o.value} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 12px', cursor: 'pointer', fontSize: 13,
              background: selected.includes(o.value) ? '#f5f3ff' : 'transparent',
            }}>
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={() => toggle(o.value)}
                style={{ accentColor: '#7c3aed' }} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function RadioFilter({ cfg, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <label style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>{cfg.label}</label>
      <div style={{ display: 'flex', gap: 4 }}>
        {(cfg.options || []).map(o => (
          <button
            key={o.value}
            onClick={() => onChange(cfg.key, o.value)}
            style={{
              padding: '5px 12px', borderRadius: 6, border: '1px solid',
              fontSize: 12, cursor: 'pointer', fontWeight: value === o.value ? 600 : 400,
              background: value === o.value ? '#7c3aed' : '#fff',
              color: value === o.value ? '#fff' : '#6b7280',
              borderColor: value === o.value ? '#7c3aed' : '#e9e4ff',
            }}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilterBar
// ---------------------------------------------------------------------------
export default function FilterBar({
  filters    = [],
  values     = {},
  onChange,
  onReset,
  onExport,
  compact    = false,
}) {
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef(null);

  useEffect(() => {
    if (!exportOpen) return;
    const h = (e) => { if (exportRef.current && !exportRef.current.contains(e.target)) setExportOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [exportOpen]);

  // Count active filters (non-default / non-empty)
  const activeCount = filters.filter(f => {
    const v = values[f.key];
    if (v === undefined || v === null || v === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    if (f.defaultValue !== undefined && v === f.defaultValue) return false;
    return true;
  }).length;

  const renderControl = (cfg) => {
    const val = values[cfg.key];
    switch (cfg.type) {
      case 'select':      return <SelectFilter      key={cfg.key} cfg={cfg} value={val} onChange={onChange} />;
      case 'date':        return <DateFilter        key={cfg.key} cfg={cfg} value={val} onChange={onChange} />;
      case 'daterange':   return <DateRangeFilter   key={cfg.key} cfg={cfg} value={val} onChange={onChange} />;
      case 'search':      return <SearchFilter      key={cfg.key} cfg={cfg} value={val} onChange={onChange} />;
      case 'multiselect': return <MultiSelectFilter key={cfg.key} cfg={cfg} value={val} onChange={onChange} />;
      case 'radio':       return <RadioFilter       key={cfg.key} cfg={cfg} value={val} onChange={onChange} />;
      default:            return null;
    }
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-end',
      gap: compact ? 8 : 12,
      flexWrap: 'wrap',
      padding: compact ? '8px 0' : '12px 0',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#7c3aed', paddingBottom: 2 }}>
        <SlidersHorizontal size={14} />
        {activeCount > 0 && (
          <span style={{
            background: '#7c3aed', color: '#fff', borderRadius: 10,
            padding: '0 6px', fontSize: 11, fontWeight: 600, lineHeight: '18px',
          }}>
            {activeCount}
          </span>
        )}
      </div>

      {filters.map(renderControl)}

      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', paddingBottom: 0 }}>
        {onReset && activeCount > 0 && (
          <button
            onClick={onReset}
            style={{
              padding: '6px 14px', background: '#fff', color: '#6b7280',
              border: '1px solid #e9e4ff', borderRadius: 7, cursor: 'pointer',
              fontSize: 12, display: 'flex', alignItems: 'center', gap: 5,
            }}>
            <X size={12} /> Reset
          </button>
        )}

        {onExport && (
          <div ref={exportRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setExportOpen(p => !p)}
              style={{
                padding: '6px 14px', background: '#7c3aed', color: '#fff',
                border: 'none', borderRadius: 7, cursor: 'pointer',
                fontSize: 12, display: 'flex', alignItems: 'center', gap: 5,
              }}>
              <Download size={12} /> Export <ChevronDown size={12} />
            </button>
            {exportOpen && (
              <div style={{
                position: 'absolute', right: 0, top: '100%', zIndex: 200,
                background: '#fff', border: '1px solid #e9e4ff', borderRadius: 8,
                boxShadow: '0 8px 24px rgba(124,58,237,0.12)',
                minWidth: 130, padding: '4px 0', marginTop: 4,
              }}>
                {[['CSV', 'csv'], ['Excel', 'excel'], ['PDF', 'pdf']].map(([label, fmt]) => (
                  <button key={fmt} onClick={() => { setExportOpen(false); onExport(fmt); }} style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '8px 14px', border: 'none', background: 'transparent',
                    cursor: 'pointer', fontSize: 13, color: '#374151',
                  }}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
