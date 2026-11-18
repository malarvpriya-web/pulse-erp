import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FolderKanban, List, Plus, UserPlus } from 'lucide-react';
import CandidatePipeline from './CandidatePipeline';
import CandidateWorkbench from './CandidateWorkbench';
import AddCandidateDialog from '../shared/components/AddCandidateDialog';
import useAppStore from '@/store/useAppStore';
import { useToast } from '@/context/ToastContext';
import { PageHero, PageShell } from '@/components/pulse-ui';

/**
 * Candidates — one candidate record, two views: the working list and the
 * pipeline board.
 *
 * The third tab, Résumé Database, was removed 2026-11-17 (recruitment page
 * audit D5): it listed the same candidates through a second API with its own
 * add and edit forms. Adding (with résumé reading) is the "Add candidate"
 * button here; editing every field is on Candidate Detail.
 *
 * `embedded` on the child, not a second PageShell: a nested shell steals the
 * host's clicks (see PageShell's own note).
 *
 * TABS is exported with a `page` key per tab — nav.hubs.test.jsx checks every
 * NAV_ITEMS row marked `inHub: 'Candidates'` is one of these.
 */
export const TABS = [
  { id: 'all',      label: 'Candidates', icon: List,         page: 'CandidateWorkbench' },
  { id: 'pipeline', label: 'Pipeline',   icon: FolderKanban, page: 'CandidatePipeline' },
];
const IDS = TABS.map(t => t.id);

export default function Candidates({ setPage }) {
  const [sp, setSp] = useSearchParams();
  const urlTab = sp.get('tab');
  const _toast = useToast();
  const setSelectedCandidateId = useAppStore(s => s.setSelectedCandidateId);
  const selectedJobId = useAppStore(s => s.selectedJobId);

  const [active, setActive] = useState(IDS.includes(urlTab) ? urlTab : 'all');
  const [adding, setAdding] = useState(false);
  const [version, setVersion] = useState(0);   // remounts the active view after an add

  const go = (id) => {
    setActive(id);
    // Only `tab` is rewritten; the workbench's filters live in the same params.
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', id);
      return next;
    }, { replace: true });
  };

  return (
    <PageShell dock={
      <PageHero
        icon={UserPlus}
        eyebrow="Recruitment"
        title="Candidates"
        subtitle="One candidate record: a working list and a pipeline board over it"
        actions={<>
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              className={`plh-cta${active === id ? '' : ' plh-cta--ghost'}`}
              key={id}
              onClick={() => go(id)}
              aria-pressed={active === id}
            >
              <Icon size={14} />{label}
            </button>
          ))}
          <button type="button" className="plh-cta" onClick={() => setAdding(true)}>
            <Plus size={14} />Add candidate
          </button>
        </>}
      />
    }>
      {active === 'all'      && <CandidateWorkbench key={`wb${version}`} setPage={setPage} embedded onAdd={() => setAdding(true)} />}
      {active === 'pipeline' && <CandidatePipeline key={`pl${version}`} setPage={setPage} embedded onAdd={() => setAdding(true)} />}
      <AddCandidateDialog
        open={adding}
        onClose={() => setAdding(false)}
        defaultJobId={active === 'pipeline' ? (selectedJobId || '') : ''}
        onCreated={(c) => {
          _toast({ message: `${c?.full_name || 'Candidate'} added`, type: 'success' });
          setVersion(v => v + 1);
          if (c?.id && active === 'all') { setSelectedCandidateId(c.id); }
        }}
      />
    </PageShell>
  );
}
