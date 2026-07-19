import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Users, Star, MapPin } from 'lucide-react';
import ReviewCustomers from './ReviewCustomers';
import ReviewFeedback from './ReviewFeedback';
import ReviewSites from './ReviewSites';

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
    <div style={{ minHeight: '100vh', background: '#f8f9fc', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: 'linear-gradient(135deg, #be185d 0%, #831843 100%)', padding: '18px 28px 0' }}>
        <div style={{ color: '#fff', fontSize: 11, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.75, marginBottom: 4 }}>
          Service Desk
        </div>
        <h1 style={{ margin: '0 0 2px', fontSize: 22, fontWeight: 700, color: '#fff' }}>Reviews & Ratings</h1>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
          Manage customer reviews, service feedback and site-level ratings
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
        {active === 'customers' && <ReviewCustomers />}
        {active === 'feedback'  && <ReviewFeedback setPage={setPage} />}
        {active === 'sites'     && <ReviewSites />}
      </div>
    </div>
  );
}
