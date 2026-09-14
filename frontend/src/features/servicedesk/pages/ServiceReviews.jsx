import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Users, Star, MapPin, Target } from 'lucide-react';
import ReviewCustomers from './ReviewCustomers';
import ReviewFeedback from './ReviewFeedback';
import ReviewSites from './ReviewSites';
import { PageHero, PageShell } from '@/components/pulse-ui';

const TABS = [
  { id: 'customers', label: 'Customer Reviews', icon: Users  },
  { id: 'feedback',  label: 'Feedback',         icon: Star   },
  { id: 'sites',     label: 'Site Reviews',     icon: MapPin },
];
const IDS = TABS.map(t => t.id);

export default function ServiceReviews({ setPage }) {
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
        icon={Target}
        eyebrow="Service Desk"
        title="Reviews & Ratings"
        subtitle="Manage customer reviews, service feedback and site-level ratings"
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
        {active === 'customers' && <ReviewCustomers />}
        {active === 'feedback'  && <ReviewFeedback setPage={setPage} />}
        {active === 'sites'     && <ReviewSites />}
      </div>
    </PageShell>
  );
}
