import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ClipboardCheck, CheckSquare, Wrench, Shield } from 'lucide-react';
import FATTracker from './FATTracker';
import SATTracker from './SATTracker';
import AMCManagement from './AMCManagement';
import WarrantyManagement from './WarrantyManagement';

const TABS = [
  { id: 'fat',      label: 'FAT Tracker',     icon: ClipboardCheck },
  { id: 'sat',      label: 'SAT Tracker',     icon: CheckSquare    },
  { id: 'amc',      label: 'AMC Management',  icon: Wrench         },
  { id: 'warranty', label: 'Warranty',         icon: Shield         },
];
const IDS = TABS.map(t => t.id);

export default function ProjectLifecycleHub({ setPage, urlParams }) {
  const [sp, setSp] = useSearchParams();
  const urlTab = sp.get('tab');
  const [active, setActive] = useState(IDS.includes(urlTab) ? urlTab : IDS[0]);

  useEffect(() => {
    if (IDS.includes(urlTab) && urlTab !== active) setActive(urlTab);
  }, [urlTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = id => { setActive(id); setSp({ tab: id }, { replace: true }); };

  return (
    <div style={{ minHeight: '100vh', background: '#f8f9fc', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: 'linear-gradient(135deg, #0891b2 0%, #164e63 100%)', padding: '18px 28px 0' }}>
        <div style={{ color: '#fff', fontSize: 11, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.75, marginBottom: 4 }}>
          Projects
        </div>
        <h1 style={{ margin: '0 0 2px', fontSize: 22, fontWeight: 700, color: '#fff' }}>Project Lifecycle</h1>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
          Factory acceptance, site acceptance, AMC contracts and warranty management
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
        {active === 'fat'      && <FATTracker setPage={setPage} urlParams={urlParams} />}
        {active === 'sat'      && <SATTracker setPage={setPage} urlParams={urlParams} />}
        {active === 'amc'      && <AMCManagement setPage={setPage} />}
        {active === 'warranty' && <WarrantyManagement setPage={setPage} />}
      </div>
    </div>
  );
}
