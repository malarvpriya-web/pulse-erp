import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Settings2, PlayCircle, IndianRupee, FileText, Eye } from 'lucide-react';
import PayrollSettings from './PayrollSettings';
import Payroll from './Payroll';
import SalaryStructure from './SalaryStructure';
import PayslipGenerator from './PayslipGenerator';
import PayslipViewer from './PayslipViewer';

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
    <div style={S.wrap}>
      {/* Module banner */}
      <div style={{ background: 'linear-gradient(135deg, #6B3FDB 0%, #5b21b6 100%)', padding: '18px 28px 0' }}>
        <div style={{ color: '#fff', fontSize: 11, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.75, marginBottom: 4 }}>
          Human Resources
        </div>
        <h1 style={{ margin: '0 0 2px', fontSize: 22, fontWeight: 700, color: '#fff' }}>Payroll Center</h1>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
          Configure, run payroll, manage salary structures and payslips — all in one place
        </p>
        {/* Tabs on gradient */}
        <div style={{ display: 'flex', gap: 0, overflowX: 'auto' }}>
          {TABS.map(({ id, label, icon: Icon }) => {
            const on = active === id;
            return (
              <button key={id} onClick={() => go(id)} style={{
                padding: '10px 18px',
                border: 'none',
                background: on ? 'rgba(255,255,255,0.15)' : 'transparent',
                borderBottom: on ? '2px solid #fff' : '2px solid transparent',
                borderRadius: on ? '6px 6px 0 0' : 0,
                color: on ? '#fff' : 'rgba(255,255,255,0.65)',
                fontWeight: on ? 600 : 400,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 13,
                transition: 'all 0.15s',
                whiteSpace: 'nowrap',
                fontFamily: 'Inter, sans-serif',
              }}>
                <Icon size={14} />{label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div style={{ position: 'relative' }}>
        {active === 'settings'  && <PayrollSettings setPage={setPage} />}
        {active === 'payroll'   && <Payroll setPage={setPage} />}
        {active === 'structure' && <SalaryStructure />}
        {active === 'generate'  && <PayslipGenerator />}
        {active === 'view'      && <PayslipViewer />}
      </div>
    </div>
  );
}
