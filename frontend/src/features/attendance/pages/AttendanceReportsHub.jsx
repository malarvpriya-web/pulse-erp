import { lazy } from 'react';
import { BarChart3, Calendar, Clock, MapPin, FileText, LayoutDashboard } from 'lucide-react';
import { TabHub } from '@/components/pulse-ui';

/**
 * Attendance → Reports.
 *
 * §278: a TabHub like the other attendance hubs. It was a PageShell wrapping
 * five PageShell pages directly, so each child's sticky header sat over the
 * hub's tab buttons (the nested-shell click trap). "All Reports" repeated
 * five of its seven reports from the tabs beside it; it keeps only the two
 * nothing else has. Each tab's page keeps an `inHub: 'AttendanceReportsHub'`
 * NAV_ITEMS row so TabHub can gate it.
 */
const AttendanceAnalytics = lazy(() => import('./AttendanceAnalytics'));
const MonthlyAttendanceReport = lazy(() => import('./MonthlyAttendanceReport'));
const LateArrivals = lazy(() => import('./LateArrivals'));
const GeoViolationsReport = lazy(() => import('./GeoViolationsReport'));
const AttendanceReports = lazy(() => import('./AttendanceReports'));

export const TABS = [
  { id: 'analytics', label: 'Analytics & Trends', icon: BarChart3, page: 'AttendanceAnalytics', Component: AttendanceAnalytics },
  { id: 'monthly', label: 'Monthly Report', icon: Calendar, page: 'MonthlyAttendanceReport', Component: MonthlyAttendanceReport },
  { id: 'late', label: 'Late Arrivals', icon: Clock, page: 'LateArrivals', Component: LateArrivals },
  { id: 'geo', label: 'Geo Violations', icon: MapPin, page: 'GeoViolationsReport', Component: GeoViolationsReport },
  { id: 'all', label: 'Leave & Early Exit', icon: FileText, page: 'AttendanceReports', Component: AttendanceReports },
];

export default function AttendanceReportsHub({ setPage }) {
  return (
    <TabHub
      icon={LayoutDashboard}
      eyebrow="Attendance"
      title="Attendance Reports"
      subtitle="Trends over 1–2 years, the monthly summary, late arrivals, field geo violations, leave reconciliation and early exits"
      tabs={TABS}
      setPage={setPage}
    />
  );
}
