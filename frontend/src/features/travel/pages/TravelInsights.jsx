import { lazy } from 'react';
import { BarChart3 as IcBarChart3, FileText as IcFileText, History as IcHistory, LayoutDashboard as IcLayoutDashboard, Scale as IcScale } from 'lucide-react';
import { TabHub } from '@/components/pulse-ui';

/**
 * Insights & Policy — hub page for the Travel Desk menu.
 *
 * Spend figures show ACTUAL spend (paid company-borne claims + travel-desk
 * bookings) next to the ESTIMATED budget of approved trips (26 Nov 26). Each tab
 * is drawn only for the people its data endpoint serves:
 *   Command Center   admin / super admin
 *   Analytics, Reports  admin, HR and Finance desks, line managers
 *   Travel Audit     admin, Finance, managers (reconciliation + ledger accounts)
 *   Policy Engine    everyone who opens this hub reads it; admin / HR edit
 */
const TravelCommandCenter = lazy(() => import('./TravelCommandCenter'));
const TravelAnalytics = lazy(() => import('./TravelAnalytics'));
const TravelReports = lazy(() => import('./TravelReports'));
const TravelAudit = lazy(() => import('./TravelAudit'));
const TravelPolicyEngine = lazy(() => import('./TravelPolicyEngine'));

const ANALYTICS = ['admin', 'super_admin', 'hr', 'hr_manager', 'finance', 'finance_manager', 'accounts_exec', 'manager', 'department_head'];
const AUDIT = ['admin', 'super_admin', 'finance', 'finance_manager', 'accounts_exec', 'manager'];

export const TABS = [
  { id: 'command', label: 'Command Center', icon: IcLayoutDashboard, page: 'TravelCommandCenter', Component: TravelCommandCenter,
    show: ({ hasAnyRole }) => hasAnyRole('admin', 'super_admin') },
  { id: 'analytics', label: 'Analytics', icon: IcBarChart3, page: 'TravelAnalytics', Component: TravelAnalytics,
    show: ({ hasAnyRole }) => hasAnyRole(...ANALYTICS) },
  { id: 'reports', label: 'Travel Reports', icon: IcFileText, page: 'TravelReports', Component: TravelReports,
    show: ({ hasAnyRole }) => hasAnyRole(...ANALYTICS) },
  { id: 'audit', label: 'Travel Audit', icon: IcHistory, page: 'TravelAudit', Component: TravelAudit,
    show: ({ hasAnyRole }) => hasAnyRole(...AUDIT) },
  { id: 'policy', label: 'Policy Engine', icon: IcScale, page: 'TravelPolicyEngine', Component: TravelPolicyEngine },
];

export default function TravelInsights({ setPage }) {
  return (
    <TabHub
      icon={IcBarChart3}
      eyebrow="Travel Desk"
      title="Insights & Policy"
      subtitle="Actual and estimated travel spend, reports, the finance reconciliation and the travel policy"
      tabs={TABS}
      setPage={setPage}
    />
  );
}
