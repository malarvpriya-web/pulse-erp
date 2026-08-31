import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GitBranch, Settings2, CheckSquare } from 'lucide-react';
import WorkflowVisualizer from './WorkflowVisualizer';
import WorkflowConfiguration from './WorkflowConfiguration';
import { PageHero, PageShell } from '@/components/pulse-ui';

const TABS = [
  { id: 'board',  label: 'Workflow Board',   icon: GitBranch },
  { id: 'config', label: 'Configuration',    icon: Settings2 },
];
const IDS = TABS.map(t => t.id);

export default function WorkflowCenter({ setPage }) {
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
        icon={CheckSquare}
        eyebrow="Operations"
        title="Workflow Center"
        subtitle="Visualize active workflows and configure automation rules"
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
        {active === 'board'  && <WorkflowVisualizer setPage={setPage} />}
        {active === 'config' && <WorkflowConfiguration setPage={setPage} />}
      </div>
    </PageShell>
  );
}
