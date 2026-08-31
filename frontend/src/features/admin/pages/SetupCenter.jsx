import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  LayoutDashboard, PlayCircle, CalendarCheck, Package, Wrench,
  IndianRupee, SlidersHorizontal,
} from 'lucide-react';
import SetupDashboard from '@/features/settings/pages/SetupDashboard';
import SetupWizard from '@/features/settings/pages/SetupWizard';
import AttendanceSetupWizard from './AttendanceSetupWizard';
import InventorySetupWizard from './InventorySetupWizard';
import EngineeringSetupWizard from './EngineeringSetupWizard';
import PayrollSetupWizard from './PayrollSetupWizard';
import { PageHero, PageShell } from '@/components/pulse-ui';

const TABS = [
  { id: 'overview',     label: 'Overview',         icon: LayoutDashboard },
  { id: 'first-time',   label: 'First-Time Setup',  icon: PlayCircle      },
  { id: 'attendance',   label: 'Attendance Setup',  icon: CalendarCheck   },
  { id: 'inventory',    label: 'Inventory Setup',   icon: Package         },
  { id: 'engineering',  label: 'Engineering Setup', icon: Wrench          },
  { id: 'payroll',      label: 'Payroll Setup',     icon: IndianRupee     },
];
const IDS = TABS.map(t => t.id);

export default function SetupCenter({ setPage }) {
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
        icon={SlidersHorizontal}
        eyebrow="Administration"
        title="Setup Center"
        subtitle="First-time setup and module configuration wizards — guided onboarding for every department"
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
        {active === 'overview'    && <SetupDashboard setPage={setPage} />}
        {active === 'first-time'  && <SetupWizard setPage={setPage} />}
        {active === 'attendance'  && <AttendanceSetupWizard setPage={setPage} />}
        {active === 'inventory'   && <InventorySetupWizard setPage={setPage} />}
        {active === 'engineering' && <EngineeringSetupWizard setPage={setPage} />}
        {active === 'payroll'     && <PayrollSetupWizard setPage={setPage} />}
      </div>
    </PageShell>
  );
}
