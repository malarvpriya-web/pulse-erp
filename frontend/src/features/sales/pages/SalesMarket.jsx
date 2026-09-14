import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Handshake, Globe, Shield, ShoppingCart } from 'lucide-react';
import SalesPartners from './SalesPartners';
import Territories from './Territories';
import Competitors from './Competitors';
import { PageHero, PageShell } from '@/components/pulse-ui';

const TABS = [
  { id: 'partners',    label: 'Partners',    icon: Handshake },
  { id: 'territories', label: 'Territories', icon: Globe     },
  { id: 'competitors', label: 'Competitors', icon: Shield    },
];
const IDS = TABS.map(t => t.id);

export default function SalesMarket() {
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
        icon={ShoppingCart}
        eyebrow="Sales"
        title="Market Presence"
        subtitle="Manage channel partners, define territories and track competitor intelligence"
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
        {/* embedded: this page already renders the heading, so the child suppresses its own */}
        {active === 'partners'    && <SalesPartners embedded />}
        {active === 'territories' && <Territories />}
        {active === 'competitors' && <Competitors />}
      </div>
    </PageShell>
  );
}
