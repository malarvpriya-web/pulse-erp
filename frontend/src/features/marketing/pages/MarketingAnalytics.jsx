import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart3, TrendingUp, Star } from 'lucide-react';
import CampaignAnalytics from './CampaignAnalytics';
import OrdersWonLost from './OrdersWonLost';
import UserPerformance from './UserPerformance';
import { PageHero, PageShell } from '@/components/pulse-ui';

const TABS = [
  { id: 'campaigns',   label: 'Campaign Analytics', icon: BarChart3  },
  { id: 'won-lost',    label: 'Orders Won / Lost',  icon: TrendingUp },
  { id: 'performance', label: 'User Performance',   icon: Star       },
];
const IDS = TABS.map(t => t.id);

export default function MarketingAnalytics() {
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
        icon={BarChart3}
        eyebrow="Marketing"
        title="Marketing Analytics"
        subtitle="Campaign performance, win/loss analysis and individual user productivity"
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
        {active === 'campaigns'   && <CampaignAnalytics />}
        {active === 'won-lost'    && <OrdersWonLost />}
        {active === 'performance' && <UserPerformance />}
      </div>
    </PageShell>
  );
}
