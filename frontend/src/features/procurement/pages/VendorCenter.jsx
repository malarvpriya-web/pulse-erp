import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LayoutDashboard, Building2, CheckCircle2, AlertTriangle, Eye, Globe, Star, Tag, BarChart2 } from 'lucide-react';
import VendorDashboard from './VendorDashboard';
import VendorManagement from './VendorManagement';
import VendorApprovalQueue from './VendorApprovalQueue';
import VendorRiskDashboard from './VendorRiskDashboard';
import Vendor360 from './Vendor360';
import VendorPortal from './VendorPortal';
import VendorScorecard from './VendorScorecard';
import PriceHistory from './PriceHistory';
import VendorComparison from './VendorComparison';

const TABS = [
  { id: 'overview',    label: 'Overview',    icon: LayoutDashboard },
  { id: 'master',      label: 'Master',      icon: Building2       },
  { id: 'approvals',   label: 'Approvals',   icon: CheckCircle2    },
  { id: 'risk',        label: 'Risk Engine', icon: AlertTriangle   },
  { id: '360',         label: 'Vendor 360°', icon: Eye             },
  { id: 'portal',      label: 'Portal',      icon: Globe           },
  { id: 'scorecard',   label: 'Scorecard',   icon: Star            },
  { id: 'pricing',     label: 'Price History', icon: Tag           },
  { id: 'compare',     label: 'Compare',     icon: BarChart2       },
];
const IDS = TABS.map(t => t.id);

export default function VendorCenter({ setPage }) {
  const [sp, setSp] = useSearchParams();
  const urlTab = sp.get('tab');
  const [active, setActive] = useState(IDS.includes(urlTab) ? urlTab : IDS[0]);

  useEffect(() => {
    if (IDS.includes(urlTab) && urlTab !== active) setActive(urlTab);
  }, [urlTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = id => { setActive(id); setSp({ tab: id }, { replace: true }); };

  return (
    <div style={{ minHeight: '100vh', background: '#f8f9fc', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: 'linear-gradient(135deg, #1d4ed8 0%, #1e3a8a 100%)', padding: '18px 28px 0' }}>
        <div style={{ color: '#fff', fontSize: 11, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.75, marginBottom: 4 }}>
          Procurement
        </div>
        <h1 style={{ margin: '0 0 2px', fontSize: 22, fontWeight: 700, color: '#fff' }}>Vendor Intelligence Center</h1>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
          Manage vendor lifecycle — onboarding, approvals, risk, 360° insights, scorecard and pricing
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
        {active === 'overview'  && <VendorDashboard setPage={setPage} />}
        {active === 'master'    && <VendorManagement />}
        {active === 'approvals' && <VendorApprovalQueue />}
        {active === 'risk'      && <VendorRiskDashboard />}
        {active === '360'       && <Vendor360 />}
        {active === 'portal'    && <VendorPortal />}
        {active === 'scorecard' && <VendorScorecard />}
        {active === 'pricing'   && <PriceHistory />}
        {active === 'compare'   && <VendorComparison />}
      </div>
    </div>
  );
}
