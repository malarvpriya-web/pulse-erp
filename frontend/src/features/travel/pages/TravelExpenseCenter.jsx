import { lazy } from 'react';
import { Banknote as IcBanknote, Receipt as IcReceipt } from 'lucide-react';
import { TabHub } from '@/components/pulse-ui';

/**
 * Travel Expenses — hub page for the Travel Desk menu.
 *
 * Expense Claims is THE claim record: filing, the manager → accounts →
 * management review, and history. Payment is Finance's queue of
 * management-approved claims. Trip Expenses (a second, unapproved claim table)
 * and Expense Review (which actually approved TRIPS) were merged away on
 * 26 Nov 26.
 */
const ExpenseClaims = lazy(() => import('./ExpenseClaims'));
const TravelPayment = lazy(() => import('./TravelPayment'));

export const TABS = [
  { id: 'claims', label: 'Expense Claims', icon: IcReceipt, page: 'ExpenseClaims', Component: ExpenseClaims },
  { id: 'payment', label: 'Payment', icon: IcBanknote, page: 'TravelPayment', Component: TravelPayment,
    show: ({ hasPermission }) => hasPermission('expense_payments', 'approve') },
];

export default function TravelExpenseCenter({ setPage }) {
  return (
    <TabHub
      icon={IcReceipt}
      eyebrow="Travel Desk"
      title="Travel Expenses"
      subtitle="File and track expense claims; Finance pays approved claims from the Payment tab"
      tabs={TABS}
      setPage={setPage}
    />
  );
}
