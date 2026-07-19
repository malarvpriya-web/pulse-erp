import { useFilters } from '@/context/FilterContext';
import { Filter } from 'lucide-react';

const DEPARTMENTS = ['All', 'Engineering', 'HR', 'Finance', 'Sales', 'Operations', 'Marketing', 'Product', 'Legal', 'Support'];
const PERIODS     = ['This Month', 'Last Month', 'Last 3 Months', 'Last 6 Months', 'This Year'];

/**
 * GlobalFilterBar — drop into any dashboard page that needs FY / dept / period selectors.
 *
 * Usage:
 *   import GlobalFilterBar from '@/components/GlobalFilterBar';
 *   <GlobalFilterBar />
 */
export default function GlobalFilterBar({ showDept = true, showPeriod = true }) {
  const { fiscalYear, setFiscalYear, getFYOptions, selectedDepartment, setSelectedDepartment, period, setPeriod } = useFilters();

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '10px 16px', background: '#ffffff', borderRadius: '10px', border: '1px solid #e5e7eb', marginBottom: '16px' }}>
      <Filter size={13} color="#9ca3af" style={{ flexShrink: 0 }} />

      {/* Fiscal Year */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <label style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' }}>FY:</label>
        <select
          value={fiscalYear}
          onChange={e => setFiscalYear(e.target.value)}
          style={{ fontSize: '12px', padding: '5px 10px', borderRadius: '6px', border: '1px solid #e5e7eb', background: '#f9fafb', color: '#111827', fontWeight: 600 }}
        >
          {getFYOptions().map(fy => <option key={fy}>{fy}</option>)}
        </select>
      </div>

      {showDept && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <label style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' }}>Dept:</label>
          <select
            value={selectedDepartment}
            onChange={e => setSelectedDepartment(e.target.value)}
            style={{ fontSize: '12px', padding: '5px 10px', borderRadius: '6px', border: '1px solid #e5e7eb', background: '#f9fafb', color: '#111827' }}
          >
            {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
          </select>
        </div>
      )}

      {showPeriod && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <label style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' }}>Period:</label>
          <select
            value={period}
            onChange={e => setPeriod(e.target.value)}
            style={{ fontSize: '12px', padding: '5px 10px', borderRadius: '6px', border: '1px solid #e5e7eb', background: '#f9fafb', color: '#111827' }}
          >
            {PERIODS.map(p => <option key={p}>{p}</option>)}
          </select>
        </div>
      )}

      {/* Active filter indicators */}
      <div style={{ display: 'flex', gap: '6px', marginLeft: '4px' }}>
        {fiscalYear !== 'FY2026' && (
          <span style={{ fontSize: '11px', background: '#e0e7ff', color: '#4338ca', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>{fiscalYear}</span>
        )}
        {selectedDepartment !== 'All' && (
          <span style={{ fontSize: '11px', background: '#dcfce7', color: '#15803d', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>{selectedDepartment}</span>
        )}
      </div>
    </div>
  );
}
