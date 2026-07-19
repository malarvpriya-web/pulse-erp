import { lazy, Suspense } from 'react';
import WidgetErrorBoundary  from './WidgetErrorBoundary';
import { WIDGET_TYPES }     from '../../config/dashboardConfig';

const RevenueWidget          = lazy(() => import('./widgets/RevenueWidget'));
const ProfitabilityWidget    = lazy(() => import('./widgets/ProfitabilityWidget'));
const CashPositionWidget     = lazy(() => import('./widgets/CashPositionWidget'));
const SalesPipelineWidget    = lazy(() => import('./widgets/SalesPipelineWidget'));
const WorkforceWidget        = lazy(() => import('./widgets/WorkforceWidget'));
const OperationsWidget       = lazy(() => import('./widgets/OperationsWidget'));
const TeamAttendanceWidget   = lazy(() => import('./widgets/TeamAttendanceWidget'));
const PendingApprovalsWidget = lazy(() => import('./widgets/PendingApprovalsWidget'));
const ProjectHealthWidget    = lazy(() => import('./widgets/ProjectHealthWidget'));
const TeamPerformanceWidget  = lazy(() => import('./widgets/TeamPerformanceWidget'));
const DeptSpendWidget        = lazy(() => import('./widgets/DeptSpendWidget'));
const MyAttendanceWidget     = lazy(() => import('./widgets/MyAttendanceWidget'));
const MyLeaveWidget          = lazy(() => import('./widgets/MyLeaveWidget'));
const MyTasksWidget          = lazy(() => import('./widgets/MyTasksWidget'));
const MyApprovalsWidget      = lazy(() => import('./widgets/MyApprovalsWidget'));
const MyPayslipsWidget       = lazy(() => import('./widgets/MyPayslipsWidget'));
const AnnouncementsWidget    = lazy(() => import('./widgets/AnnouncementsWidget'));
const NotificationsWidget    = lazy(() => import('./widgets/NotificationsWidget'));

const WIDGET_COMPONENTS = {
  [WIDGET_TYPES.REVENUE]:           RevenueWidget,
  [WIDGET_TYPES.PROFITABILITY]:     ProfitabilityWidget,
  [WIDGET_TYPES.CASH_POSITION]:     CashPositionWidget,
  [WIDGET_TYPES.SALES_PIPELINE]:    SalesPipelineWidget,
  [WIDGET_TYPES.WORKFORCE]:         WorkforceWidget,
  [WIDGET_TYPES.OPERATIONS]:        OperationsWidget,
  [WIDGET_TYPES.TEAM_ATTENDANCE]:   TeamAttendanceWidget,
  [WIDGET_TYPES.PENDING_APPROVALS]: PendingApprovalsWidget,
  [WIDGET_TYPES.PROJECT_HEALTH]:    ProjectHealthWidget,
  [WIDGET_TYPES.TEAM_PERFORMANCE]:  TeamPerformanceWidget,
  [WIDGET_TYPES.DEPT_SPEND]:        DeptSpendWidget,
  [WIDGET_TYPES.MY_ATTENDANCE]:     MyAttendanceWidget,
  [WIDGET_TYPES.MY_LEAVE]:          MyLeaveWidget,
  [WIDGET_TYPES.MY_TASKS]:          MyTasksWidget,
  [WIDGET_TYPES.MY_APPROVALS]:      MyApprovalsWidget,
  [WIDGET_TYPES.MY_PAYSLIPS]:       MyPayslipsWidget,
  [WIDGET_TYPES.ANNOUNCEMENTS]:     AnnouncementsWidget,
  [WIDGET_TYPES.NOTIFICATIONS]:     NotificationsWidget,
};

export default function Widget({ widget, data }) {
  const WidgetComponent = WIDGET_COMPONENTS[widget.type];

  if (!WidgetComponent) {
    return (
      <div className={`widget widget-${widget.size}`}>
        <div className="widget-header"><h3>{widget.title}</h3></div>
        <div className="widget-content">
          <div className="widget-error">Unknown widget type: {widget.type}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`widget widget-${widget.size}`}>
      <div className="widget-header"><h3>{widget.title}</h3></div>
      <div className="widget-content">
        <WidgetErrorBoundary>
          <Suspense fallback={<div className="widget-skeleton" />}>
            <WidgetComponent data={data || {}} />
          </Suspense>
        </WidgetErrorBoundary>
      </div>
    </div>
  );
}
