import { ClipboardList, Briefcase, Globe } from 'lucide-react';
import TabPage from '../shared/components/TabPage';
import JobRequisitionPipeline from './JobRequisitionPipeline';
import CareersPageAdmin from './CareersPageAdmin';

/**
 * Jobs — one job, from request to advert.
 *
 * 2026-11-17 (owner): the Job Openings tab was removed. Candidates apply on the
 * company website, so the opening is no longer a list of its own: it is posted
 * and edited from its approved requisition (Requisitions tab). The Careers
 * Website tab holds the website's address and what the website developer
 * needs to list the jobs and send applications back against each job.
 * Old ?tab=openings links fall back to Requisitions (TabPage picks the first
 * tab for an unknown id), and ?opening= / ?requisition= still open the job.
 */
/**
 * EXPORTED with a `page` key per tab, for the same reason as Candidates.jsx:
 * nav.hubs.test.jsx verifies every `inHub: 'Jobs'` row is genuinely a tab here.
 */
export const TABS = [
  { id: 'requisitions', label: 'Requisitions',     icon: ClipboardList, page: 'JobRequisitionPipeline' },
  { id: 'website',      label: 'Careers Website',  icon: Globe,         page: 'CareersPageAdmin' },
];

export default function Jobs({ setPage }) {
  return (
    <TabPage
      icon={Briefcase}
      title="Jobs"
      subtitle="Raise and approve requisitions, post the job, and candidates apply on your website"
      tabs={TABS.map(t => ({
        ...t,
        render: t.page === 'JobRequisitionPipeline'
          ? () => <JobRequisitionPipeline setPage={setPage} embedded />
          : () => <CareersPageAdmin setPage={setPage} embedded />,
      }))}
    />
  );
}
