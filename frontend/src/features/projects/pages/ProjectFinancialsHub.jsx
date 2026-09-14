import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Calculator, Activity, TrendingUp, List, Layers, IndianRupee,
  LayoutDashboard,
} from 'lucide-react';
import ProjectCosting from './ProjectCosting';
import ProjectEVMDashboard from './ProjectEVMDashboard';
import ProjectProfitabilityDashboard from './ProjectProfitabilityDashboard';
import CostTransactions from './CostTransactions';
import CostCentreTracking from './CostCentreTracking';
import ProjectRevenueSummary from './ProjectRevenueSummary';
import { PageHero, PageShell } from '@/components/pulse-ui';

const TABS = [
  { id: 'costing',       label: 'Project Costing',  icon: Calculator  },
  { id: 'evm',           label: 'EVM Dashboard',     icon: Activity    },
  { id: 'profitability', label: 'Profitability',     icon: TrendingUp  },
  { id: 'transactions',  label: 'Transactions',      icon: List        },
  { id: 'cost-centres',  label: 'Cost Centres',      icon: Layers      },
  { id: 'revenue',       label: 'Revenue Summary',   icon: IndianRupee  },
];
const IDS = TABS.map(t => t.id);

export default function ProjectFinancialsHub({ setPage }) {
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
        title="Project Financials"
        subtitle="Costing, EVM metrics, profitability, transactions, cost centres and revenue in one view"
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
        {active === 'costing'       && <ProjectCosting />}
        {active === 'evm'           && <ProjectEVMDashboard setPage={setPage} />}
        {active === 'profitability' && <ProjectProfitabilityDashboard setPage={setPage} />}
        {active === 'transactions'  && <CostTransactions setPage={setPage} />}
        {active === 'cost-centres'  && <CostCentreTracking setPage={setPage} />}
        {active === 'revenue'       && <ProjectRevenueSummary setPage={setPage} />}
      </div>
    </PageShell>
  );
}
