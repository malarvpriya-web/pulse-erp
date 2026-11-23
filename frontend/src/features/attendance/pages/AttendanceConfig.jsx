import { lazy } from 'react';
import { CalendarDays as IcCalendar, Fingerprint as IcFingerprint, Factory as IcFactory, MapPin as IcMapPin, RefreshCw as IcRefreshCw, Settings2 as IcSettings2 } from 'lucide-react';
import { TabHub } from '@/components/pulse-ui';

/**
 * Attendance Configuration — hub page for the Attendance menu.
 *
 * §278 (owner, 2026-11-18): one tab per thing to configure, no hub inside a
 * hub. The old "Settings" tab was itself a second tab bar (General · Policies ·
 * Shifts · Geo Fencing · Devices · Face): its Shifts tab repeated Shift
 * Rotations on the same tables, Policies repeated the grace / OT fields of
 * General, Devices moved to Attendance → Punch Machines, and Face (browser face
 * recognition) had no caller after office staff moved to the punch machine.
 * Payroll Sync is its own menu row now — it is a monthly
 * step, not configuration.
 *
 * Each page keeps its NAV_ITEMS entry marked `inHub: 'AttendanceConfig'`, so
 * getSectionForPage() still resolves it and TabHub re-checks each tab with
 * canRoleOpenPage() before drawing it.
 */
const Shifts = lazy(() => import('../../hr/pages/Shifts'));
const ShiftCalendar = lazy(() => import('./ShiftCalendar'));
const PunchImport = lazy(() => import('./PunchImport'));
const WorkCentres = lazy(() => import('./WorkCentres'));
// Contract Labour is its own Attendance menu row now (owner, 2026-11-19): marking
// it is a daily task, not configuration.
const GeoFencing = lazy(() => import('./GeoFencing'));
const GeneralSettings = lazy(() => import('./settings/GeneralSettings'));

export const TABS = [
  { id: 'shifts', label: 'Shifts & Rotations', icon: IcRefreshCw, page: 'Shifts', Component: Shifts },
  // Shift Calendar and Punch Machines were menu rows of their own (owner, 2026-11-19).
  { id: 'shiftcalendar', label: 'Shift Calendar', icon: IcCalendar, page: 'ShiftCalendar', Component: ShiftCalendar },
  { id: 'punch', label: 'Punch Machines', icon: IcFingerprint, page: 'PunchImport', Component: PunchImport },
  { id: 'workcentres', label: 'Work Centres', icon: IcFactory, page: 'WorkCentres', Component: WorkCentres },
  { id: 'geo', label: 'Geo Fencing (field staff)', icon: IcMapPin, page: 'GeoFencing', Component: GeoFencing },
  { id: 'settings', label: 'Settings', icon: IcSettings2, page: 'GeneralSettings', Component: GeneralSettings },
];

export default function AttendanceConfig({ setPage }) {
  return (
    <TabHub
      icon={IcSettings2}
      eyebrow="Attendance"
      title="Attendance Configuration"
      subtitle="Shifts, shift calendar, punch machines, work centres, field-staff geo fences and attendance rules"
      tabs={TABS}
      setPage={setPage}
    />
  );
}
