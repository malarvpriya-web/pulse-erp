import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Settings2, PlayCircle, IndianRupee, FileText, Eye, Wallet } from 'lucide-react';
import PayrollSettings from './PayrollSettings';
import Payroll from './Payroll';
import SalaryStructure from './SalaryStructure';
import PayslipGenerator from './PayslipGenerator';
import PayslipViewer from './PayslipViewer';
import { PageHero, PageShell } from '@/components/pulse-ui';

const TABS = [
  { id: 'settings',   label: 'Settings',        icon: Settings2    },
  { id: 'payroll',    label: 'Run Payroll',      icon: PlayCircle   },
  { id: 'structure',  label: 'Salary Structure', icon: IndianRupee  },
  { id: 'generate',   label: 'Payslip Generator',icon: FileText     },
  { id: 'view',       label: 'Payslip Viewer',   icon: Eye          },
];
const IDS = TABS.map(t => t.id);

const S = {
  wrap: { minHeight: '100vh', background: '#f9fafb', fontFamily: 'Inter, sans-serif' },
  nav: {
    background: '#fff',
    borderBottom: '1px solid #e5e7eb',
    padding: '0 28px',
    display: 'flex',
    alignItems: 'stretch',
    gap: 0,
    overflowX: 'auto',
  },
  tab: (on) => ({
    padding: '14px 18px',
    border: 'none',
    background: 'none',
    borderBottom: on ? '2px solid #6B3FDB' : '2px solid transparent',
    color: on ? '#6B3FDB' : '#6b7280',
    fontWeight: on ? 600 : 400,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    fontSize: 13,
    transition: 'color 0.15s, border-color 0.15s',
    whiteSpace: 'nowrap',
    fontFamily: 'Inter, sans-serif',
    letterSpacing: on ? '-0.01em' : 0,
  }),
  badge: (on) => ({
    width: 6, height: 6, borderRadius: '50%',
    background: on ? '#6B3FDB' : 'transparent',
    flexShrink: 0,
  }),
};

export default function PayrollCenter({ setPage }) {
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
        icon={Wallet}
        eyebrow="Human Resources"
        title="Payroll Center"
        subtitle="Configure, run payroll, manage salary structures and payslips — all in one place"
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
      {/* Module banner */}


      {/* Content */}
      <div style={{ position: 'relative' }}>
        {active === 'settings'  && <PayrollSettings setPage={setPage} />}
        {active === 'payroll'   && <Payroll setPage={setPage} />}
        {active === 'structure' && <SalaryStructure />}
        {active === 'generate'  && <PayslipGenerator />}
        {active === 'view'      && <PayslipViewer />}
      </div>
    </PageShell>
  );
}
