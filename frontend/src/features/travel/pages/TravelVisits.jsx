import { lazy } from 'react';
import { FileText as IcFileText, MapPin as IcMapPin } from 'lucide-react';
import { TabHub } from '@/components/pulse-ui';

/**
 * Visit Reports — the Travel Desk menu row.
 *
 * Customer Visits was a second register for the same visits (its own table,
 * gated on CRM) and was merged into Visit Reports on 26 Nov 26 (owner). One
 * tab; kept as a hub so the menu row, URL and gates stay as they were.
 */
const VisitReports = lazy(() => import('./VisitReports'));

export const TABS = [
  { id: 'reports', label: 'Visit Reports', icon: IcFileText, page: 'VisitReports', Component: VisitReports },
];

export default function TravelVisits({ setPage }) {
  return (
    <TabHub
      icon={IcMapPin}
      eyebrow="Travel Desk"
      title="Visit Reports"
      subtitle="Write up each customer or site visit; your manager reviews it"
      tabs={TABS}
      setPage={setPage}
    />
  );
}
