import { createContext, useContext, useState, useCallback, useMemo } from 'react';

const FilterContext = createContext(null);

const FY_START_MONTH = 3; // April (0-indexed)

export function FilterProvider({ children }) {
  const [fiscalYear,         setFiscalYear]         = useState('FY2026');
  const [selectedDepartment, setSelectedDepartment] = useState('All');
  const [dateRange,          setDateRange]          = useState({ start: null, end: null });
  const [period,             setPeriod]             = useState('This Month');

  // FY2026 = Apr 2025 – Mar 2026
  const getFYStart = useCallback((fy) => {
    const year = parseInt(fy.replace('FY', '')) - 1;
    return new Date(year, FY_START_MONTH, 1);
  }, []);

  const getFYEnd = useCallback((fy) => {
    const year = parseInt(fy.replace('FY', ''));
    return new Date(year, FY_START_MONTH, 0); // last day of March
  }, []);

  const getFYOptions = useCallback(() => ['FY2024', 'FY2025', 'FY2026', 'FY2027'], []);

  const filterByFY = useCallback((data, dateField) => {
    const start = getFYStart(fiscalYear);
    const end   = getFYEnd(fiscalYear);
    return data.filter(item => {
      const d = new Date(item[dateField]);
      return d >= start && d <= end;
    });
  }, [fiscalYear, getFYStart, getFYEnd]);

  const contextValue = useMemo(() => ({
    fiscalYear, setFiscalYear,
    selectedDepartment, setSelectedDepartment,
    dateRange, setDateRange,
    period, setPeriod,
    getFYStart, getFYEnd, getFYOptions, filterByFY,
  }), [fiscalYear, selectedDepartment, dateRange, period, getFYStart, getFYEnd, getFYOptions, filterByFY]);

  return (
    <FilterContext.Provider value={contextValue}>
      {children}
    </FilterContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useFilters() {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error('useFilters must be used inside <FilterProvider>');
  return ctx;
}

export default FilterContext;
