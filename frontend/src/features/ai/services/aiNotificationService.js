export const AI_RULES = [
  {
    id: 'attrition_risk',
    check: (data) => data.attendance?.dropPct > 20,
    severity: 'warning',
    title: 'Attrition risk detected',
    message: (data) =>
      `Attendance dropped ${data.attendance.dropPct}% this week. Employee may be at risk of leaving.`,
    module: 'hr',
    roles: ['admin', 'super_admin', 'manager'],
  },
  {
    id: 'expense_threshold',
    check: (data) => data.expenses?.overBudgetPct > 20,
    severity: 'warning',
    title: 'Expense threshold exceeded',
    message: (data) =>
      `Expenses are ${data.expenses.overBudgetPct}% over budget this month.`,
    module: 'finance',
    roles: ['admin', 'super_admin'],
  },
  {
    id: 'project_delay',
    check: (data) => data.projects?.atRiskCount > 0,
    severity: 'warning',
    title: 'Project delay likely',
    message: (data) =>
      `${data.projects.atRiskCount} project(s) are at risk of missing deadlines in the next 3 days.`,
    module: 'projects',
    roles: ['admin', 'super_admin', 'manager'],
  },
  {
    id: 'low_stock',
    check: (data) => data.inventory?.lowStockCount > 5,
    severity: 'info',
    title: 'Low stock alert',
    message: (data) =>
      `${data.inventory.lowStockCount} items are below reorder level.`,
    module: 'inventory',
    roles: ['admin', 'super_admin'],
  },
  {
    id: 'pending_approvals',
    check: (data) => data.approvals?.pendingCount > 10,
    severity: 'info',
    title: 'Approval backlog',
    message: (data) =>
      `${data.approvals.pendingCount} items are pending approval.`,
    module: 'hr',
    roles: ['admin', 'super_admin', 'manager'],
  },
];

export function evaluateRules(erpData, userRole) {
  return AI_RULES
    .filter(rule => rule.roles.includes(userRole))
    .filter(rule => rule.check(erpData))
    .map(rule => ({
      id: rule.id,
      severity: rule.severity,
      title: rule.title,
      message: rule.message(erpData),
      module: rule.module,
      timestamp: new Date().toISOString(),
      isAI: true,
    }));
}
