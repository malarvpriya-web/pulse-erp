// Role-based access control configuration
export const ROLES = {
  ADMIN: "admin",
  HR: "hr",
  FINANCE: "finance",
  MANAGER: "manager",
  EMPLOYEE: "employee",
};

// Department-based access control
export const DEPARTMENT_PERMISSIONS = {
  HR: {
    canAddEmployee: true,
    canEditEmployee: true,
    canDeleteEmployee: true,
    canApproveEmployee: false,
    canViewFinance: false,
    canViewPayroll: false,
    modules: ["Employees", "Dashboard"],
  },
  FINANCE: {
    canAddEmployee: false,
    canEditEmployee: false,
    canDeleteEmployee: false,
    canApproveEmployee: true,
    canViewFinance: true,
    canViewPayroll: true,
    modules: ["Dashboard", "Finance", "Payroll"],
  },
  MANAGER: {
    canAddEmployee: false,
    canEditEmployee: false,
    canDeleteEmployee: false,
    canApproveEmployee: false,
    canViewFinance: false,
    canViewPayroll: false,
    modules: ["Dashboard", "Team"],
  },
  ADMIN: {
    canAddEmployee: true,
    canEditEmployee: true,
    canDeleteEmployee: true,
    canApproveEmployee: true,
    canViewFinance: true,
    canViewPayroll: true,
    modules: ["Dashboard", "Employees", "Finance", "Payroll", "Users", "Settings"],
  },
};

// Employee approval workflow statuses
export const APPROVAL_STATUS = {
  DRAFT: "draft",
  HR_PENDING: "hr_pending",
  FINANCE_PENDING: "finance_pending",
  APPROVED: "approved",
  REJECTED: "rejected",
};

// Get permissions by role
export const getPermissionsByRole = (role) => {
  return DEPARTMENT_PERMISSIONS[role.toUpperCase()] || DEPARTMENT_PERMISSIONS.EMPLOYEE;
};

// Check if user has permission
export const hasPermission = (userRole, permission) => {
  const permissions = getPermissionsByRole(userRole);
  return permissions[permission] || false;
};

// Get accessible modules for user
export const getAccessibleModules = (userRole) => {
  const permissions = getPermissionsByRole(userRole);
  return permissions.modules || [];
};
