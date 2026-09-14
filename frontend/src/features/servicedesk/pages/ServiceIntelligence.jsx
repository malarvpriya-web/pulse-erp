import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart3, AlertCircle, MessageCircle, LifeBuoy } from 'lucide-react';
import ServiceAnalytics from './ServiceAnalytics';
import FailureAnalytics from './FailureAnalytics';
import VoiceOfCustomer from './VoiceOfCustomer';
import { PageHero, PageShell } from '@/components/pulse-ui';

const TABS = [
  { id: 'analytics', label: 'Service Analytics',  icon: BarChart3     },
  { id: 'failures',  label: 'Failure Analytics',  icon: AlertCircle   },
  { id: 'voc',       label: 'Voice of Customer',  icon: MessageCircle },
];
const IDS = TABS.map(t => t.id);

export default function ServiceIntelligence() {
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
        icon={LifeBuoy}
        eyebrow="Service Desk"
        title="Service Intelligence"
        subtitle="Service analytics, failure patterns and voice of customer insights"
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
        {active === 'analytics' && <ServiceAnalytics />}
        {active === 'failures'  && <FailureAnalytics />}
        {active === 'voc'       && <VoiceOfCustomer />}
      </div>
    </PageShell>
  );
}
