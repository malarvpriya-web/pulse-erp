import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Map, Users, BookOpen, Database, BarChart3, Settings2 } from 'lucide-react';
import SuccessionPlanning from '../succession/SuccessionPlanning';
import LeadershipPipeline from '../succession/LeadershipPipeline';
import DevelopmentPlans from '../succession/DevelopmentPlans';
import EmployeeSuccessionPools from '../succession/EmployeeSuccessionPools';
import SuccessionReports from '../succession/SuccessionReports';
import SuccessionSettings from '../succession/SuccessionSettings';
import { PageHero, PageShell } from '@/components/pulse-ui';

const TABS = [
  { id: 'planning',  label: 'Planning',          icon: Map       },
  { id: 'pipeline',  label: 'Leadership Pipeline',icon: Users     },
  { id: 'plans',     label: 'Development Plans',  icon: BookOpen  },
  { id: 'pools',     label: 'Talent Pools',       icon: Database  },
  { id: 'reports',   label: 'Reports',            icon: BarChart3 },
  { id: 'settings',  label: 'Settings',           icon: Settings2 },
];
const IDS = TABS.map(t => t.id);

export default function SuccessionCenter() {
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
        icon={Users}
        eyebrow="Human Resources"
        title="Succession Center"
        subtitle="Plan succession, build leadership pipelines, develop talent and track readiness"
        actions={TABS.map(({ id, label, icon: Icon }) => {
            const on = active === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={on}
                className={`plh-cta${on ? '' : ' plh-cta--ghost'}`}
                onClick={() => go(id)}
              >
                <Icon size={14} />{label}
              </button>
            );
          })}
      />
    }>

      {/* The tab bodies are plain sections (2026-11-12): each used to be a
          full PageShell page with its own hero, a second header under this
          one. `.plh-tabpanel` stays as the host-side guard TabHub uses
          (pulse-hero.css), so nothing a section renders can cover the tabs. */}
      <div className="plh-tabpanel" role="tabpanel">
        {active === 'planning'  && <SuccessionPlanning />}
        {active === 'pipeline'  && <LeadershipPipeline />}
        {active === 'plans'     && <DevelopmentPlans />}
        {active === 'pools'     && <EmployeeSuccessionPools />}
        {active === 'reports'   && <SuccessionReports />}
        {active === 'settings'  && <SuccessionSettings />}
      </div>
    </PageShell>
  );
}
