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
import { PageHero, PageShell } from '@/components/pulse-ui';

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
    <PageShell dock={
      <PageHero
        icon={Building2}
        eyebrow="Procurement"
        title="Vendor Intelligence Center"
        subtitle="Manage vendor lifecycle — onboarding, approvals, risk, 360° insights, scorecard and pricing"
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
    </PageShell>
  );
}
