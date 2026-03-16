// Dashboard Layouts - Role-based default layouts
// Defines the default widget positions for each role

export const dashboardLayouts = {
  super_admin: [
    { i: 'revenueTrend', x: 0, y: 0, w: 8, h: 3 },
    { i: 'expenseBreakdown', x: 8, y: 0, w: 4, h: 3 },
    { i: 'cashPosition', x: 0, y: 3, w: 3, h: 2 },
    { i: 'workforce', x: 3, y: 3, w: 3, h: 2 },
    { i: 'operations', x: 6, y: 3, w: 3, h: 2 },
    { i: 'alerts', x: 9, y: 3, w: 3, h: 2 },
    { i: 'salesPipeline', x: 0, y: 5, w: 8, h: 3 },
    { i: 'approvalsQueue', x: 8, y: 5, w: 4, h: 3 },
    { i: 'recentActivity', x: 0, y: 8, w: 12, h: 4 }
  ],
  
  admin: [
    { i: 'workforce', x: 0, y: 0, w: 6, h: 3 },
    { i: 'operations', x: 6, y: 0, w: 6, h: 3 },
    { i: 'approvalsQueue', x: 0, y: 3, w: 6, h: 3 },
    { i: 'alerts', x: 6, y: 3, w: 6, h: 3 },
    { i: 'recentActivity', x: 0, y: 6, w: 12, h: 4 }
  ],
  
  manager: [
    { i: 'workforce', x: 0, y: 0, w: 6, h: 3 },
    { i: 'salesPipeline', x: 6, y: 0, w: 6, h: 3 },
    { i: 'approvalsQueue', x: 0, y: 3, w: 6, h: 3 },
    { i: 'operations', x: 6, y: 3, w: 6, h: 3 },
    { i: 'recentActivity', x: 0, y: 6, w: 12, h: 4 }
  ],
  
  department_head: [
    { i: 'workforce', x: 0, y: 0, w: 6, h: 3 },
    { i: 'salesPipeline', x: 6, y: 0, w: 6, h: 3 },
    { i: 'approvalsQueue', x: 0, y: 3, w: 6, h: 3 },
    { i: 'operations', x: 6, y: 3, w: 6, h: 3 },
    { i: 'recentActivity', x: 0, y: 6, w: 12, h: 4 }
  ],
  
  employee: [
    { i: 'recentActivity', x: 0, y: 0, w: 12, h: 4 }
  ]
};

// Get default layout for role
export const getDefaultLayout = (role) => {
  return dashboardLayouts[role] || dashboardLayouts.employee;
};

// Get saved layout from localStorage
export const getSavedLayout = (role) => {
  try {
    const saved = localStorage.getItem(`dashboard_layout_${role}`);
    return saved ? JSON.parse(saved) : null;
  } catch (error) {
    console.error('Error loading saved layout:', error);
    return null;
  }
};

// Save layout to localStorage
export const saveLayout = (role, layout) => {
  try {
    localStorage.setItem(`dashboard_layout_${role}`, JSON.stringify(layout));
    return true;
  } catch (error) {
    console.error('Error saving layout:', error);
    return false;
  }
};

// Reset layout to default
export const resetLayout = (role) => {
  try {
    localStorage.removeItem(`dashboard_layout_${role}`);
    return getDefaultLayout(role);
  } catch (error) {
    console.error('Error resetting layout:', error);
    return getDefaultLayout(role);
  }
};

export default dashboardLayouts;
