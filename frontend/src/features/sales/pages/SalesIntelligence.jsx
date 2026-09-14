import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TrendingUp, Filter, Target, ShoppingCart, CheckSquare } from 'lucide-react';
import SalesConversionAnalytics from './SalesConversionAnalytics';
import SalesFunnel from './SalesFunnel';
import SalesForecasts from './SalesForecasts';
import ForecastCommit from './ForecastCommit';
import { PageHero, PageShell } from '@/components/pulse-ui';

const TABS = [
  { id: 'conversion', label: 'Conversion Analytics', icon: TrendingUp },
  { id: 'funnel',     label: 'Sales Funnel',         icon: Filter     },
  { id: 'forecasts',  label: 'Forecasts',            icon: Target     },
  // The computed roll-up (Forecasts) and the forecast a person STATES are
  // different questions, so they are different tabs rather than one screen
  // showing two numbers under the same heading.
  { id: 'commit',     label: 'Forecast & Commit',    icon: CheckSquare },
];
const IDS = TABS.map(t => t.id);

export default function SalesIntelligence() {
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
        title="Sales Intelligence"
        subtitle="Conversion analytics, sales funnel and forecasting — all your sales insights in one view"
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

      {/* `embedded` suppresses each tab's own PageShell + PageHero. Rendered
          bare, every tab stacked a second hero and a second scroll container
          inside this one — the Conversion tab put "Sales Target & Conversion
          Analytics" directly under this page's own title. */}
      <div>
        {active === 'conversion' && <SalesConversionAnalytics embedded />}
        {active === 'funnel'     && <SalesFunnel embedded />}
        {active === 'forecasts'  && <SalesForecasts embedded />}
        {active === 'commit'     && <ForecastCommit embedded />}
      </div>
    </PageShell>
  );
}
