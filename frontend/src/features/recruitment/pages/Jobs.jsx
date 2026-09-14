import { ClipboardList, Briefcase } from 'lucide-react';
import TabPage from '../shared/components/TabPage';
import JobRequisitionPipeline from './JobRequisitionPipeline';
import JobOpenings from './JobOpenings';

/**
 * Jobs — Requisitions and Openings on one page.
 *
 * These are two halves of a single workflow: a requisition is raised and
 * approved, then an opening is created against it (and the API hard-blocks an
 * opening whose requisition isn't approved). Splitting them across two sidebar
 * entries meant constantly bouncing between menu items to follow one job from
 * request to posting. Same tab-container pattern as Candidates.jsx.
 */
export default function Jobs({ setPage }) {
  return (
    <TabPage
      icon={Briefcase}
      title="Jobs"
      subtitle="Raise and approve requisitions, then post the openings they authorise — one job, from request to advert"
      tabs={[
        {
          id: 'requisitions',
          label: 'Requisitions',
          icon: ClipboardList,
          render: () => <JobRequisitionPipeline setPage={setPage} embedded />,
        },
        {
          id: 'openings',
          label: 'Job Openings',
          icon: Briefcase,
          render: () => <JobOpenings setPage={setPage} embedded />,
        },
      ]}
    />
  );
}
