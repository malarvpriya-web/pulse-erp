export const WIDGET_TYPES = {
  REVENUE: "revenue",
  PROFITABILITY: "profitability",
  CASH_POSITION: "cashPosition",
  SALES_PIPELINE: "salesPipeline",
  WORKFORCE: "workforce",
  OPERATIONS: "operations",
  TEAM_ATTENDANCE: "teamAttendance",
  PENDING_APPROVALS: "pendingApprovals",
  PROJECT_HEALTH: "projectHealth",
  TEAM_PERFORMANCE: "teamPerformance",
  DEPT_SPEND: "deptSpend",
  MY_ATTENDANCE: "myAttendance",
  MY_LEAVE: "myLeave",
  MY_TASKS: "myTasks",
  MY_APPROVALS: "myApprovals",
  MY_PAYSLIPS: "myPayslips",
  ANNOUNCEMENTS: "announcements",
  NOTIFICATIONS: "notifications"
};

const EXECUTIVE_WIDGETS = [
  { id: "revenue", title: "Revenue Overview", type: WIDGET_TYPES.REVENUE, dataKey: "revenue", size: "large" },
  { id: "profitability", title: "Profitability", type: WIDGET_TYPES.PROFITABILITY, dataKey: "profitability", size: "medium" },
  { id: "cash", title: "Cash Position", type: WIDGET_TYPES.CASH_POSITION, dataKey: "cash", size: "medium" },
  { id: "sales", title: "Sales Pipeline", type: WIDGET_TYPES.SALES_PIPELINE, dataKey: "sales", size: "large" },
  { id: "workforce", title: "Workforce Snapshot", type: WIDGET_TYPES.WORKFORCE, dataKey: "workforce", size: "large" },
  { id: "operations", title: "Operations Snapshot", type: WIDGET_TYPES.OPERATIONS, dataKey: "operations", size: "large" },
  { id: "notifications", title: "Alerts", type: WIDGET_TYPES.NOTIFICATIONS, dataKey: "notifications", size: "small" }
];

const MANAGER_WIDGETS = [
  { id: "teamAttendance", title: "Team Attendance Today", type: WIDGET_TYPES.TEAM_ATTENDANCE, dataKey: "teamAttendance", size: "medium" },
  { id: "pendingApprovals", title: "Pending Approvals", type: WIDGET_TYPES.PENDING_APPROVALS, dataKey: "pendingApprovals", size: "large" },
  { id: "projectHealth", title: "Project Health", type: WIDGET_TYPES.PROJECT_HEALTH, dataKey: "projectHealth", size: "large" },
  { id: "teamPerformance", title: "Team Performance", type: WIDGET_TYPES.TEAM_PERFORMANCE, dataKey: "teamPerformance", size: "medium" },
  { id: "deptSpend", title: "Department Spend", type: WIDGET_TYPES.DEPT_SPEND, dataKey: "deptSpend", size: "medium" },
  { id: "notifications", title: "Alerts", type: WIDGET_TYPES.NOTIFICATIONS, dataKey: "notifications", size: "small" }
];

const EMPLOYEE_WIDGETS = [
  { id: "myAttendance", title: "My Attendance", type: WIDGET_TYPES.MY_ATTENDANCE, dataKey: "myAttendance", size: "medium" },
  { id: "myLeave", title: "My Leave", type: WIDGET_TYPES.MY_LEAVE, dataKey: "myLeave", size: "medium" },
  { id: "myTasks", title: "My Tasks", type: WIDGET_TYPES.MY_TASKS, dataKey: "myTasks", size: "large" },
  { id: "myApprovals", title: "My Approvals", type: WIDGET_TYPES.MY_APPROVALS, dataKey: "myApprovals", size: "medium" },
  { id: "myPayslips", title: "My Payslips", type: WIDGET_TYPES.MY_PAYSLIPS, dataKey: "myPayslips", size: "small" },
  { id: "announcements", title: "Announcements", type: WIDGET_TYPES.ANNOUNCEMENTS, dataKey: "announcements", size: "large" }
];

export const getWidgetsForRole = (role) => {
  const roleMap = {
  admin: EXECUTIVE_WIDGETS,
  superadmin: EXECUTIVE_WIDGETS,
  executive: EXECUTIVE_WIDGETS,
  manager: MANAGER_WIDGETS,
  employee: EMPLOYEE_WIDGETS,
  user: EMPLOYEE_WIDGETS
};
  
  return roleMap[role?.toLowerCase()] || EMPLOYEE_WIDGETS;
};
