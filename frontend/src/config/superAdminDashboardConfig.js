export const SUPER_ADMIN_DASHBOARD_CONFIG = {
  layout: {
    type: 'grid',
    gap: '20px',
    padding: '24px'
  },

  rows: [
    // Row 1: Executive KPI Overview
    {
      id: 'kpi-overview',
      title: null,
      columns: 5,
      widgets: [
        {
          id: 'total-employees',
          component: 'KPICard',
          props: {
            title: 'Total Employees',
            icon: 'Users',
            color: '#3b82f6',
            apiEndpoint: '/api/admin/dashboard/kpis',
            dataKey: 'totalEmployees'
          },
          size: { cols: 1 }
        },
        {
          id: 'present-today',
          component: 'KPICard',
          props: {
            title: 'Present Today',
            icon: 'CheckCircle',
            color: '#10b981',
            apiEndpoint: '/api/admin/dashboard/kpis',
            dataKey: 'presentToday'
          },
          size: { cols: 1 }
        },
        {
          id: 'active-projects',
          component: 'KPICard',
          props: {
            title: 'Active Projects',
            icon: 'Briefcase',
            color: '#8b5cf6',
            apiEndpoint: '/api/admin/dashboard/kpis',
            dataKey: 'activeProjects'
          },
          size: { cols: 1 }
        },
        {
          id: 'revenue-mtd',
          component: 'KPICard',
          props: {
            title: 'Revenue MTD',
            icon: 'IndianRupee',
            color: '#f59e0b',
            apiEndpoint: '/api/admin/dashboard/kpis',
            dataKey: 'revenueMTD'
          },
          size: { cols: 1 }
        },
        {
          id: 'pending-approvals',
          component: 'KPICard',
          props: {
            title: 'Pending Approvals',
            icon: 'AlertCircle',
            color: '#ef4444',
            apiEndpoint: '/api/admin/dashboard/kpis',
            dataKey: 'pendingApprovals'
          },
          size: { cols: 1 }
        }
      ]
    },

    // Row 2: Financial Overview
    {
      id: 'financial-overview',
      title: 'Financial Overview',
      columns: 12,
      widgets: [
        {
          id: 'revenue-trend',
          component: 'RevenueTrendChart',
          props: {
            title: 'Revenue Trend',
            apiEndpoint: '/api/admin/dashboard/financial/revenue-trend',
            period: '12months'
          },
          size: { cols: 6 }
        },
        {
          id: 'expense-breakdown',
          component: 'ExpenseBreakdownChart',
          props: {
            title: 'Expense Breakdown',
            apiEndpoint: '/api/admin/dashboard/financial/expense-breakdown'
          },
          size: { cols: 3 }
        },
        {
          id: 'cash-position',
          component: 'CashPositionCard',
          props: {
            title: 'Cash Position',
            apiEndpoint: '/api/admin/dashboard/financial/cash-position'
          },
          size: { cols: 3 }
        }
      ]
    },

    // Row 3: Projects & Operations
    {
      id: 'operations',
      title: 'Projects & Operations',
      columns: 3,
      widgets: [
        {
          id: 'project-health',
          component: 'ProjectHealthWidget',
          props: {
            title: 'Project Health',
            apiEndpoint: '/api/admin/dashboard/projects/health'
          },
          size: { cols: 1 }
        },
        {
          id: 'operations-alerts',
          component: 'OperationsAlertsWidget',
          props: {
            title: 'Operations Alerts',
            apiEndpoint: '/api/admin/dashboard/operations/alerts'
          },
          size: { cols: 1 }
        },
        {
          id: 'team-attendance',
          component: 'TeamAttendanceWidget',
          props: {
            title: 'Team Attendance',
            apiEndpoint: '/api/admin/dashboard/attendance/company-summary'
          },
          size: { cols: 1 }
        }
      ]
    },

    // Row 4: Approvals Queue
    {
      id: 'approvals-queue',
      title: 'Approvals Queue',
      columns: 1,
      widgets: [
        {
          id: 'pending-approvals-queue',
          component: 'ApprovalsQueueWidget',
          props: {
            title: 'Pending Approvals',
            apiEndpoint: '/api/admin/dashboard/approvals/pending',
            showActions: true
          },
          size: { cols: 1 }
        }
      ]
    },

    // Row 5: Recent Activity & System Alerts
    {
      id: 'activity-alerts',
      title: 'Recent Activity & System Alerts',
      columns: 2,
      widgets: [
        {
          id: 'activity-timeline',
          component: 'ActivityTimelineWidget',
          props: {
            title: 'Activity Timeline (Last 24 Hours)',
            apiEndpoint: '/api/admin/dashboard/activity/recent',
            hours: 24,
            limit: 10
          },
          size: { cols: 1 }
        },
        {
          id: 'system-alerts',
          component: 'SystemAlertsWidget',
          props: {
            title: 'System Alerts',
            apiEndpoint: '/api/admin/dashboard/alerts/system',
            groupBySeverity: true
          },
          size: { cols: 1 }
        }
      ]
    }
  ],

  refreshInterval: 300000, // 5 minutes
  enableAutoRefresh: true,
  enableExport: true
};
