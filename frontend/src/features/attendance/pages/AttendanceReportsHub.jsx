import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart3, Calendar, Clock, MapPin, FileText, LayoutDashboard } from 'lucide-react';
import AttendanceAnalytics from './AttendanceAnalytics';
import MonthlyAttendanceReport from './MonthlyAttendanceReport';
import LateArrivals from './LateArrivals';
import GeoViolationsReport from './GeoViolationsReport';
import AttendanceReports from './AttendanceReports';
import { PageHero, PageShell } from '@/components/pulse-ui';

const TABS = [
  { id: 'analytics', label: 'Analytics',       icon: BarChart3 },
  { id: 'monthly',   label: 'Monthly Report',  icon: Calendar  },
  { id: 'late',      label: 'Late Arrivals',   icon: Clock     },
  { id: 'geo',       label: 'Geo Violations',  icon: MapPin    },
  { id: 'all',       label: 'All Reports',     icon: FileText  },
];
const IDS = TABS.map(t => t.id);

export default function AttendanceReportsHub() {
  const [sp, setSp] = useSearchParams();
  const urlTab = sp.get('tab');
  const [active, setActive] = useState(IDS.includes(urlTab) ? urlTab : IDS[0]);

  useEffect(() => {
    if (IDS.includes(urlTab) && urlTab !== active) setActive(urlTab);
  }, [urlTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = id => { setActive(id); setSp({ tab: id }, { replace: true }); };

  return (
    <PageShell dock={
      <PageHero
        icon={LayoutDashboard}
        eyebrow="Attendance"
        title="Attendance Reports"
        subtitle="Analytics, monthly summaries, late arrivals, geo violations and comprehensive attendance reports"
        actions={TABS.map(({ id, label, icon: Icon }) => {
            const on = active === id;
            return (
              <button className="plh-cta" key={id} onClick={() => go(id)}>
                <Icon size={14} />{label}
              </button>
            );
          })}
      />
    }>

      <div>
        {active === 'analytics' && <AttendanceAnalytics />}
        {active === 'monthly'   && <MonthlyAttendanceReport />}
        {active === 'late'      && <LateArrivals />}
        {active === 'geo'       && <GeoViolationsReport />}
        {active === 'all'       && <AttendanceReports />}
      </div>
    </PageShell>
  );
}
