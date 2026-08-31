import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Settings2, FileText, Shield, LayoutDashboard } from 'lucide-react';
import CommissioningReports from './CommissioningReports';
import AMCManagement from './AMCManagement';
import WarrantyManagement from './WarrantyManagement';
import { PageHero, PageShell } from '@/components/pulse-ui';

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
    <PageShell dock={
      <PageHero
        icon={LayoutDashboard}
        eyebrow="Operations"
        title="Post-Delivery Lifecycle"
        subtitle="Track commissioning progress, manage AMC contracts and handle warranty obligations"
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
        {active === 'commissioning' && <CommissioningReports />}
        {active === 'amc'           && <AMCManagement />}
        {active === 'warranty'      && <WarrantyManagement />}
      </div>
    </PageShell>
  );
}
