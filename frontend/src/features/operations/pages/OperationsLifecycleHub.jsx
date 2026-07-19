import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Settings2, FileText, Shield } from 'lucide-react';
import CommissioningReports from './CommissioningReports';
import AMCManagement from './AMCManagement';
import WarrantyManagement from './WarrantyManagement';

const TABS = [
  { id: 'commissioning', label: 'Commissioning', icon: Settings2 },
  { id: 'amc',           label: 'AMC Contracts', icon: FileText  },
  { id: 'warranty',      label: 'Warranty',      icon: Shield    },
];
const IDS = TABS.map(t => t.id);

export default function OperationsLifecycleHub() {
  const [sp, setSp] = useSearchParams();
  const urlTab = sp.get('tab');
  const [active, setActive] = useState(IDS.includes(urlTab) ? urlTab : IDS[0]);

  useEffect(() => {
    if (IDS.includes(urlTab) && urlTab !== active) setActive(urlTab);
  }, [urlTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = id => { setActive(id); setSp({ tab: id }, { replace: true }); };

  return (
    <div style={{ minHeight: '100vh', background: '#f8f9fc', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: 'linear-gradient(135deg, #475569 0%, #1e293b 100%)', padding: '18px 28px 0' }}>
        <div style={{ color: '#fff', fontSize: 11, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.75, marginBottom: 4 }}>
          Operations
        </div>
        <h1 style={{ margin: '0 0 2px', fontSize: 22, fontWeight: 700, color: '#fff' }}>Post-Delivery Lifecycle</h1>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
          Track commissioning progress, manage AMC contracts and handle warranty obligations
        </p>
        <div style={{ display: 'flex', gap: 0, overflowX: 'auto' }}>
          {TABS.map(({ id, label, icon: Icon }) => {
            const on = active === id;
            return (
              <button key={id} onClick={() => go(id)} style={{
                padding: '10px 18px', border: 'none',
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
        {active === 'commissioning' && <CommissioningReports />}
        {active === 'amc'           && <AMCManagement />}
        {active === 'warranty'      && <WarrantyManagement />}
      </div>
    </div>
  );
}
