import React from 'react';
import RevenueWidget        from './widgets/RevenueWidget';
import ProfitabilityWidget  from './widgets/ProfitabilityWidget';
import CashPositionWidget   from './widgets/CashPositionWidget';
import SalesPipelineWidget  from './widgets/SalesPipelineWidget';
import WorkforceWidget      from './widgets/WorkforceWidget';
import OperationsWidget     from './widgets/OperationsWidget';
import TeamAttendanceWidget from './widgets/TeamAttendanceWidget';
import PendingApprovalsWidget from './widgets/PendingApprovalsWidget';
import ProjectHealthWidget  from './widgets/ProjectHealthWidget';
import TeamPerformanceWidget from './widgets/TeamPerformanceWidget';
import DeptSpendWidget      from './widgets/DeptSpendWidget';
import MyAttendanceWidget   from './widgets/MyAttendanceWidget';
import MyLeaveWidget        from './widgets/MyLeaveWidget';
import MyTasksWidget        from './widgets/MyTasksWidget';
import MyApprovalsWidget    from './widgets/MyApprovalsWidget';
import MyPayslipsWidget     from './widgets/MyPayslipsWidget';
import AnnouncementsWidget  from './widgets/AnnouncementsWidget';
import NotificationsWidget  from './widgets/NotificationsWidget';
import WidgetErrorBoundary  from './WidgetErrorBoundary';
import { WIDGET_TYPES }     from '../../config/dashboardConfig';

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
          <WidgetComponent data={data || {}} />
        </WidgetErrorBoundary>
      </div>
    </div>
  );
}
