import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FolderKanban, List, FileText, UserPlus } from 'lucide-react';
import CandidatePipeline from './CandidatePipeline';
import AllCandidates from './AllCandidates';
import ResumeDatabase from './ResumeDatabase';
import { PageHero, PageShell } from '@/components/pulse-ui';

const TABS = [
  { id: 'pipeline', label: 'Pipeline',      icon: FolderKanban },
  { id: 'all',       label: 'All Candidates', icon: List },
  { id: 'resumes',   label: 'Resumes',        icon: FileText },
];
const IDS = TABS.map(t => t.id);

export default function Candidates({ setPage }) {
  const [sp, setSp] = useSearchParams();
  const urlTab = sp.get('tab');
  const [active, setActive] = useState(IDS.includes(urlTab) ? urlTab : IDS[0]);

  const go = id => { setActive(id); setSp({ tab: id }, { replace: true }); };

  return (
    <PageShell dock={
      <PageHero
        icon={UserPlus}
        eyebrow="Recruitment"
        title="Candidates"
        subtitle="Kanban pipeline, full candidate list and resume database — one candidate record, three views"
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
        {active === 'pipeline' && <CandidatePipeline setPage={setPage} />}
        {active === 'all'      && <AllCandidates setPage={(page, params) => (page === 'CandidatePipeline' ? go('pipeline') : setPage?.(page, params))} />}
        {active === 'resumes'  && <ResumeDatabase />}
      </div>
    </PageShell>
  );
}
