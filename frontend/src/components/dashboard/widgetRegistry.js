// Widget Registry - Centralized widget management system
// All widgets must be registered here to be available in dashboards

import RevenueTrendChart from './widgets/RevenueTrendChart';
import ExpenseBreakdownChart from './widgets/ExpenseBreakdownChart';
import CashPositionCard from './widgets/CashPositionCard';
import SalesPipelineWidget from './widgets/SalesPipelineWidget';
import WorkforceWidget from './widgets/WorkforceWidget';
import OperationsWidget from './widgets/OperationsWidget';
import ApprovalsQueueWidget from './widgets/ApprovalsQueueWidget';
import SystemAlertsWidget from './widgets/SystemAlertsWidget';
import RecentActivityWidget from './widgets/RecentActivityWidget';

// Widget metadata structure
export const widgetRegistry = {
  revenueTrend: {
    id: 'revenueTrend',
    title: 'Revenue Trend',
    component: RevenueTrendChart,
    defaultSize: { w: 8, h: 3 },
    minSize: { w: 4, h: 2 },
    dataSource: '/api/dashboard/revenue',
    category: 'financial',
    roles: ['super_admin', 'admin', 'manager']
  },
  expenseBreakdown: {
    id: 'expenseBreakdown',
    title: 'Expense Breakdown',
    component: ExpenseBreakdownChart,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 },
    dataSource: '/api/dashboard/expenses',
    category: 'financial',
    roles: ['super_admin', 'admin']
  },
  cashPosition: {
    id: 'cashPosition',
    title: 'Cash Position',
    component: CashPositionCard,
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 3, h: 2 },
    dataSource: '/api/dashboard/cash',
    category: 'financial',
    roles: ['super_admin', 'admin']
  },
  workforce: {
    id: 'workforce',
    title: 'Workforce',
    component: WorkforceWidget,
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 3, h: 2 },
    dataSource: '/api/dashboard/workforce',
    category: 'operations',
    roles: ['super_admin', 'admin', 'manager']
  },
  operations: {
    id: 'operations',
    title: 'Operations',
    component: OperationsWidget,
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 3, h: 2 },
    dataSource: '/api/dashboard/operations',
    category: 'operations',
    roles: ['super_admin', 'admin', 'manager']
  },
  alerts: {
    id: 'alerts',
    title: 'System Alerts',
    component: SystemAlertsWidget,
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 3, h: 2 },
    dataSource: '/api/dashboard/alerts',
    category: 'monitoring',
    roles: ['super_admin', 'admin']
  },
  salesPipeline: {
    id: 'salesPipeline',
    title: 'Sales Pipeline',
    component: SalesPipelineWidget,
    defaultSize: { w: 8, h: 3 },
    minSize: { w: 4, h: 2 },
    dataSource: '/api/dashboard/sales',
    category: 'sales',
    roles: ['super_admin', 'admin', 'manager']
  },
  approvalsQueue: {
    id: 'approvalsQueue',
    title: 'Pending Approvals',
    component: ApprovalsQueueWidget,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 },
    dataSource: '/api/dashboard/approvals',
    category: 'workflow',
    roles: ['super_admin', 'admin', 'manager']
  },
  recentActivity: {
    id: 'recentActivity',
    title: 'Recent Activity',
    component: RecentActivityWidget,
    defaultSize: { w: 12, h: 4 },
    minSize: { w: 6, h: 2 },
    dataSource: '/api/dashboard/activity',
    category: 'monitoring',
    roles: ['super_admin', 'admin', 'manager', 'employee']
  }
};

// Get widget by ID
export const getWidget = (widgetId) => {
  return widgetRegistry[widgetId] || null;
};

// Get widgets by role
export const getWidgetsByRole = (role) => {
  return Object.values(widgetRegistry).filter(widget => 
    widget.roles.includes(role)
  );
};

// Get widgets by category
export const getWidgetsByCategory = (category) => {
  return Object.values(widgetRegistry).filter(widget => 
    widget.category === category
  );
};

export default widgetRegistry;
