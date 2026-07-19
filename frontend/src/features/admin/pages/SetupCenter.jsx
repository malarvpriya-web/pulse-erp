import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LayoutDashboard, PlayCircle, CalendarCheck, Package, Wrench, IndianRupee } from 'lucide-react';
import SetupDashboard from '@/features/settings/pages/SetupDashboard';
import SetupWizard from '@/features/settings/pages/SetupWizard';
import AttendanceSetupWizard from './AttendanceSetupWizard';
import InventorySetupWizard from './InventorySetupWizard';
import EngineeringSetupWizard from './EngineeringSetupWizard';
import PayrollSetupWizard from './PayrollSetupWizard';

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
    <div style={{ minHeight: '100vh', background: '#f8f9fc', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: 'linear-gradient(135deg, #6d28d9 0%, #4c1d95 100%)', padding: '18px 28px 0' }}>
        <div style={{ color: '#fff', fontSize: 11, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.75, marginBottom: 4 }}>
          Settings
        </div>
        <h1 style={{ margin: '0 0 2px', fontSize: 22, fontWeight: 700, color: '#fff' }}>Setup Center</h1>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
          First-time setup and module configuration wizards — guided onboarding for every department
        </p>
        <div style={{ display: 'flex', gap: 0, overflowX: 'auto' }}>
          {TABS.map(({ id, label, icon: Icon }) => {
            const on = active === id;
            return (
              <button key={id} onClick={() => go(id)} style={{
                padding: '10px 16px', border: 'none',
                background: on ? 'rgba(255,255,255,0.15)' : 'transparent',
                borderBottom: on ? '2px solid #fff' : '2px solid transparent',
                borderRadius: on ? '6px 6px 0 0' : 0,
                color: on ? '#fff' : 'rgba(255,255,255,0.65)',
                fontWeight: on ? 600 : 400, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 7, fontSize: 13,
                transition: 'all 0.15s', whiteSpace: 'nowrap', fontFamily: 'Inter, sans-serif',
              }}>
                <Icon size={14} />{label}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        {active === 'overview'    && <SetupDashboard setPage={setPage} />}
        {active === 'first-time'  && <SetupWizard setPage={setPage} />}
        {active === 'attendance'  && <AttendanceSetupWizard setPage={setPage} />}
        {active === 'inventory'   && <InventorySetupWizard setPage={setPage} />}
        {active === 'engineering' && <EngineeringSetupWizard setPage={setPage} />}
        {active === 'payroll'     && <PayrollSetupWizard setPage={setPage} />}
      </div>
    </div>
  );
}
