// PATH: frontend/src/context/FYContext.jsx
/**
 * FYContext — Global Indian Financial Year context.
 *
 * Indian FY: April 1 to March 31.
 * FY2025-26 means Apr 1 2025 – Mar 31 2026.
 *
 * Usage:
 *   const { selectedFY, fyStart, fyEnd, setSelectedFY, getFYLabel } = useFY();
 */
import { createContext, useContext, useState, useMemo, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Given a calendar year, return the FY that starts in April of that year.
 *  e.g. calYear=2025 → { fy:'FY2025-26', start:'2025-04-01', end:'2026-03-31' }
 */
function buildFY(calYear) {
  const fy      = `FY${calYear}-${String(calYear + 1).slice(2)}`;
  const start   = new Date(calYear, 3, 1);   // April 1
  const end     = new Date(calYear + 1, 2, 31); // March 31 next year
  return {
    fy,
    label:   `FY ${calYear}–${String(calYear + 1).slice(2)}`,
    start,
    end,
    startStr: `${calYear}-04-01`,
    endStr:   `${calYear + 1}-03-31`,
  };
}

/** Return the FY object for today's date. */
function currentFYFromToday() {
  const today = new Date();
  // If month is Jan-Mar (0-2), FY started previous calendar year
  const calYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  return buildFY(calYear);
}

/** Build a list of available FYs from the given start year to 2 years in future. */
function buildAvailableFYs(from = 2020) {
  const today    = new Date();
  const maxYear  = today.getMonth() >= 3 ? today.getFullYear() + 1 : today.getFullYear();
  const fys      = [];
  for (let y = from; y <= maxYear; y++) {
    fys.push(buildFY(y));
  }
  return fys.reverse(); // most recent first
}

/** Parse a fy string like 'FY2025-26' back to start calendar year (2025). */
function fyStringToCalYear(fyStr) {
  const match = fyStr.match(/FY(\d{4})/);
  return match ? parseInt(match[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
const FYContext = createContext(null);

export function FYProvider({ children, startYear = 2020 }) {
  const availableFYs = useMemo(() => buildAvailableFYs(startYear), [startYear]);
  const nowFY        = useMemo(() => currentFYFromToday(), []);

  const [selectedFY, _setSelectedFY] = useState(nowFY.fy);

  /** Set FY by string key like 'FY2025-26' */
  const setSelectedFY = useCallback((fyStr) => {
    if (availableFYs.some(f => f.fy === fyStr)) _setSelectedFY(fyStr);
  }, [availableFYs]);

  const activeFY = useMemo(() => {
    return availableFYs.find(f => f.fy === selectedFY) || nowFY;
  }, [selectedFY, availableFYs, nowFY]);

  /** Human-readable label for any fy string */
  const getFYLabel = useCallback((fyStr) => {
    const f = availableFYs.find(x => x.fy === fyStr);
    return f ? f.label : fyStr;
  }, [availableFYs]);

  /**
   * Returns array of { month: 'Apr 2025', startStr, endStr } objects for the selected FY.
   * Months in Indian FY order: Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec, Jan, Feb, Mar
   */
  const getMonthsInFY = useCallback(() => {
    const calYear = fyStringToCalYear(activeFY.fy);
    if (!calYear) return [];
    const months = [];
    for (let i = 0; i < 12; i++) {
      const m   = (3 + i) % 12; // 3=Apr, 4=May,... 11=Dec, 0=Jan, 1=Feb, 2=Mar
      const y   = m >= 3 ? calYear : calYear + 1;
      const d   = new Date(y, m, 1);
      const end = new Date(y, m + 1, 0); // last day of month
      months.push({
        month:    d.toLocaleString('en-IN', { month: 'short', year: 'numeric' }),
        startStr: d.toISOString().slice(0, 10),
        endStr:   end.toISOString().slice(0, 10),
        index:    i,
      });
    }
    return months;
  }, [activeFY]);

  /** Returns true if the given ISO date string falls within the selected FY */
  const isInCurrentFY = useCallback((dateStr) => {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    return d >= activeFY.start && d <= activeFY.end;
  }, [activeFY]);

  /**
   * Progress through the selected FY as 0–100.
   * For a past FY returns 100; for a future FY returns 0.
   */
  const fyProgress = useMemo(() => {
    const today = new Date();
    if (today > activeFY.end) return 100;
    if (today < activeFY.start) return 0;
    const elapsed = today - activeFY.start;
    const total   = activeFY.end - activeFY.start;
    return Math.round((elapsed / total) * 100);
  }, [activeFY]);

  const isCurrentFY = activeFY.fy === nowFY.fy;

  const value = {
    // Selected FY info
    selectedFY,
    setSelectedFY,
    fyStart:    activeFY.startStr,
    fyEnd:      activeFY.endStr,
    fyLabel:    activeFY.label,
    fyProgress,
    isCurrentFY,

    // Current real FY
    currentFY:      nowFY.fy,
    currentFYLabel: nowFY.label,
    currentFYStart: nowFY.startStr,
    currentFYEnd:   nowFY.endStr,

    // Helpers
    availableFYs,
    getFYLabel,
    getMonthsInFY,
    isInCurrentFY,

    // Query-string helper: append to API calls
    fyParams: { fy: activeFY.fy, fyStart: activeFY.startStr, fyEnd: activeFY.endStr },
  };

  return <FYContext.Provider value={value}>{children}</FYContext.Provider>;
}

/** Hook to consume FY context */
// eslint-disable-next-line react-refresh/only-export-components
export function useFY() {
  const ctx = useContext(FYContext);
  if (!ctx) throw new Error('useFY must be used within <FYProvider>');
  return ctx;
}

export default FYContext;
