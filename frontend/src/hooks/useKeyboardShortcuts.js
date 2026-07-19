import { useEffect, useCallback } from 'react';

/**
 * useKeyboardShortcuts — registers Alt+key navigation shortcuts
 * and a '?' key to show the shortcuts modal.
 *
 * @param {Function} setPage   - page navigation function
 * @param {Function} onHelp    - called when '?' is pressed (show modal)
 * @param {Boolean}  enabled   - set false to pause (e.g. when a modal is open)
 */
export default function useKeyboardShortcuts(setPage, onHelp, enabled = true) {
  const handler = useCallback((e) => {
    if (!enabled) return;
    // Skip when typing in an input
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    // '?' — show shortcuts modal
    if (e.key === '?' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      onHelp?.();
      return;
    }

    if (!e.altKey) return;

    const map = {
      h: 'Home',
      d: 'EmployeeDashboard',
      e: 'EmployeeList',
      f: 'FinanceDashboard',
      a: 'AttendanceDashboard',
      t: 'TimesheetList',
      l: 'LeaveRequests',
      p: 'PayrollRun',
      c: 'ComplaintsDashboard',
      s: 'ApprovalCenter',
    };

    const target = map[e.key.toLowerCase()];
    if (target) {
      e.preventDefault();
      setPage?.(target);
    }
  }, [setPage, onHelp, enabled]);

  useEffect(() => {
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handler]);
}

export const SHORTCUT_LIST = [
  { keys: ['Alt', 'H'], description: 'Go to Home' },
  { keys: ['Alt', 'D'], description: 'My Dashboard' },
  { keys: ['Alt', 'E'], description: 'Employee List' },
  { keys: ['Alt', 'F'], description: 'Finance Dashboard' },
  { keys: ['Alt', 'A'], description: 'Attendance' },
  { keys: ['Alt', 'T'], description: 'Timesheets' },
  { keys: ['Alt', 'L'], description: 'Leave Requests' },
  { keys: ['Alt', 'P'], description: 'Payroll' },
  { keys: ['Alt', 'C'], description: 'Complaints' },
  { keys: ['Alt', 'S'], description: 'Approval Center' },
  { keys: ['Ctrl', 'K'], description: 'Open Global Search' },
  { keys: ['?'],         description: 'Show this help' },
  { keys: ['Esc'],       description: 'Close modals / Search' },
];
