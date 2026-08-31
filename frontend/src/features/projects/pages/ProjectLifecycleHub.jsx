import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ClipboardCheck, CheckSquare, Wrench, Shield, LayoutDashboard } from 'lucide-react';
import FATTracker from './FATTracker';
import SATTracker from './SATTracker';
import AMCManagement from './AMCManagement';
import WarrantyManagement from './WarrantyManagement';
import { PageHero, PageShell } from '@/components/pulse-ui';

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
    <PageShell dock={
      <PageHero
        icon={LayoutDashboard}
        eyebrow="Projects"
        title="Project Lifecycle"
        subtitle="Factory acceptance, site acceptance, AMC contracts and warranty management"
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
        {active === 'fat'      && <FATTracker setPage={setPage} urlParams={urlParams} />}
        {active === 'sat'      && <SATTracker setPage={setPage} urlParams={urlParams} />}
        {active === 'amc'      && <AMCManagement setPage={setPage} />}
        {active === 'warranty' && <WarrantyManagement setPage={setPage} />}
      </div>
    </PageShell>
  );
}
