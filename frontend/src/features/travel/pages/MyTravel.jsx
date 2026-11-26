import { lazy } from 'react';
import { CalendarDays as IcCalendarDays, Plane as IcPlane, Send as IcSend, Ticket as IcTicket, Wallet as IcWallet } from 'lucide-react';
import { TabHub } from '@/components/pulse-ui';

/**
 * My Travel — hub page for the Travel Desk menu.
 *
 * Each page below keeps its NAV_ITEMS entry marked `inHub: 'MyTravel'`, so
 * getSectionForPage() still resolves it and every role gate behaves exactly as
 * it did when each was its own row. TabHub re-checks each tab with
 * canRoleOpenPage() before drawing it.
 *
 * Travel Entry was a read-only copy of Travel Requests and was merged into it
 * (26 Nov 26). Bookings are made by the travel desk; everyone else reads their
 * own there.
 */
const TravelRequests = lazy(() => import('./TravelRequests'));
const TravelBookings = lazy(() => import('./TravelBookings'));
const TravelAdvances = lazy(() => import('./TravelAdvances'));
const TravelCalendar = lazy(() => import('./TravelCalendar'));

export const TABS = [
  { id: 'requests', label: 'Travel Requests', icon: IcSend, page: 'TravelRequests', Component: TravelRequests },
  { id: 'bookings', label: 'Bookings', icon: IcTicket, page: 'TravelBookings', Component: TravelBookings },
  { id: 'advances', label: 'Advances', icon: IcWallet, page: 'TravelAdvances', Component: TravelAdvances },
  { id: 'calendar', label: 'Travel Calendar', icon: IcCalendarDays, page: 'TravelCalendar', Component: TravelCalendar },
];

export default function MyTravel({ setPage }) {
  return (
    <TabHub
      icon={IcPlane}
      eyebrow="Travel Desk"
      title="My Travel"
      subtitle="Raise and track trips, see your bookings, draw an advance and see who is travelling when"
      tabs={TABS}
      setPage={setPage}
    />
  );
}
