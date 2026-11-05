import { Users, Building2 } from 'lucide-react';
import TabPage from '../shared/components/TabPage';
import TalentPools from './TalentPools';
import RecruitmentAgencies from './RecruitmentAgencies';

/**
 * Sourcing — Talent Pools and Agencies on one page.
 *
 * Both answer the same question ("where do candidates come from?"): pools are
 * the in-house bench, agencies the external supply. They were two adjacent
 * sidebar entries under a "Sourcing & Talent" separator, which is exactly the
 * signal that they belong on one page as tabs.
 *
 * Talent Pool *detail* stays a separate route — it's a drill-down with its own
 * URL, not a peer view.
 */
/**
 * EXPORTED with a `page` key per tab — nav.hubs.test.jsx reads this to verify that
 * every row marked `inHub: 'Sourcing'` really is a tab here. `render` is kept
 * because TabPage renders through it; the two coexist on one entry so there is one
 * list rather than a TABS export that can drift from the tabs actually drawn.
 */
export const TABS = [
  { id: 'pools',    label: 'Talent Pools', icon: Users,     page: 'TalentPools' },
  { id: 'agencies', label: 'Agencies',     icon: Building2, page: 'RecruitmentAgencies' },
];

export default function Sourcing({ setPage }) {
  return (
    <TabPage
      icon={Users}
      title="Sourcing"
      subtitle="Your in-house talent pools and the external agencies supplying candidates"
      tabs={TABS.map(t => ({
        ...t,
        render: t.page === 'TalentPools'
          ? () => <TalentPools setPage={setPage} embedded />
          : () => <RecruitmentAgencies setPage={setPage} embedded />,
      }))}
    />
  );
}
