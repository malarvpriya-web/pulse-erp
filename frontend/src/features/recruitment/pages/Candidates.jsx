import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FolderKanban, List, FileText, UserPlus } from 'lucide-react';
import CandidatePipeline from './CandidatePipeline';
import CandidateWorkbench from './CandidateWorkbench';
import ResumeDatabase from './ResumeDatabase';
import { PageHero, PageShell } from '@/components/pulse-ui';

/**
 * Candidates — one candidate record, three views.
 *
 * ── THE LIST TAB IS NOW CandidateWorkbench ──────────────────────────────────
 * It was AllCandidates, which had no checkbox column, no way to change a stage
 * without leaving the page, and no quick view — clicking a candidate was a full
 * page transition that discarded every filter on the way there and back.
 * AllCandidates is still registered in ROUTES and still works; swapping this one
 * import back is all it takes to revert.
 *
 * ── `embedded` ON THE CHILD, NOT A SECOND PageShell ─────────────────────────
 * This page owns the shell. Each tab child used to render its own `PageShell`
 * too, and a nested shell is a known fault in this codebase: the inner shell's
 * -20px gutters pull the panel wider than its host on each side, and its sticky
 * dock (opaque, z-index 20) freezes over the host's tab strip and eats its
 * pointer events — the tabs render half-covered and stop clicking. See PageShell's
 * own `embedded` note. The workbench takes `embedded` and renders no shell at all.
 */

/**
 * EXPORTED, and each entry carries its `page` key.
 *
 * nav.hubs.test.jsx reads this export and asserts that every NAV_ITEMS row marked
 * `inHub: 'Candidates'` appears here. That test exists to catch a silent failure:
 * mark a row `inHub` and forget to add it to the hub's TABS and the page becomes
 * unreachable by any click — absent from the sidebar AND from the hub. The `page`
 * keys are what close that loop, so they are not decoration.
 */
export const TABS = [
  { id: 'all',      label: 'Candidates',      icon: List,          page: 'CandidateWorkbench' },
  { id: 'pipeline', label: 'Pipeline',        icon: FolderKanban,  page: 'CandidatePipeline' },
  { id: 'resumes',  label: 'Resume Database', icon: FileText,      page: 'ResumeDatabase' },
];
const IDS = TABS.map(t => t.id);

export default function Candidates({ setPage }) {
  const [sp, setSp] = useSearchParams();
  const urlTab = sp.get('tab');

  // 'all' leads, not 'pipeline'. §6 calls the candidate list "the most frequently
  // used screen"; opening the Kanban first cost a click on every visit.
  const [active, setActive] = useState(IDS.includes(urlTab) ? urlTab : 'all');

  const go = (id) => {
    setActive(id);
    // Only `tab` is rewritten. Replacing the whole query string here would wipe the
    // workbench's filters, which live in these same params — the exact loss §31
    // asks us to prevent.
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
        subtitle="One candidate record; a working list, a pipeline board and the résumé database over it"
        actions={TABS.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            // plh-cta for the active tab, plh-cta--ghost for the others. Both are
            // existing variants in pulse-hero.css; inventing a new '--on' class
            // would mean editing the shared design system for one page.
            className={`plh-cta${active === id ? '' : ' plh-cta--ghost'}`}
            key={id}
            onClick={() => go(id)}
            aria-pressed={active === id}
          >
            <Icon size={14} />{label}
          </button>
        ))}
      />
    }>
      {active === 'all'      && <CandidateWorkbench setPage={setPage} embedded />}
      {active === 'pipeline' && <CandidatePipeline setPage={setPage} embedded />}
      {active === 'resumes'  && <ResumeDatabase embedded />}
    </PageShell>
  );
}
