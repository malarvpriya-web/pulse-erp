// Small UI pieces shared by the Biometric & Access Control tabs.
import { S } from './biometricShared';

/** A labelled control in a filter bar. */
export function Field({ label, children, width = 160 }) {
  return (
    <div style={{ minWidth: width, flex: `0 1 ${width}px` }}>
      <label style={S.label}>{label}</label>
      {children}
    </div>
  );
}

/** Page x of y, with the total — shared by the three paged tables. */
export function Pager({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 10, fontSize: 12, color: '#6b7280' }}>
      <span>Page {page} of {pages} · {total} records</span>
      <button type="button" style={S.small('#e9e4ff', '#6B3FDB')} disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Prev</button>
      <button type="button" style={S.small('#e9e4ff', '#6B3FDB')} disabled={page >= pages} onClick={() => onPage(page + 1)}>Next ›</button>
    </div>
  );
}

/** One empty-state row: says whether filters are hiding rows or there are none. */
export function EmptyRow({ cols, filtered, onClear, what }) {
  return (
    <tr>
      <td colSpan={cols} style={{ padding: '28px 12px', textAlign: 'center', color: '#6b7280', fontSize: 13 }}>
        {filtered ? (
          <>No {what} match these filters. <button type="button" onClick={onClear} style={{ ...S.small('#e9e4ff', '#6B3FDB'), marginLeft: 6 }}>Clear filters</button></>
        ) : `No ${what} yet.`}
      </td>
    </tr>
  );
}

/** Employee <select> over GET /biometric/employees/options — opens on click. */
export function EmployeeSelect({ employees, value, onChange, placeholder = 'Select employee', id, style }) {
  return (
    <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} style={{ ...S.input, ...style }}>
      <option value="">{placeholder}</option>
      {employees.map((e) => (
        <option key={e.id} value={String(e.id)}>{e.name}{e.emp_code ? ` · ${e.emp_code}` : ''}</option>
      ))}
    </select>
  );
}
