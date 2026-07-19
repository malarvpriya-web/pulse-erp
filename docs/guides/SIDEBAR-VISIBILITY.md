# Sidebar Module Visibility Rules

## Overview
The sidebar dynamically filters menu items based on user roles and permissions to ensure users only see relevant modules.

## Role-Based Visibility

### Super Admin
**Philosophy:** Executive-level view focused on management and oversight, not day-to-day operations.

**Visible Modules:**
- Dashboard (Executive Dashboard)
- Approvals
- Employees
  - Employees Dashboard
  - Employees Data
  - Ex-Employees
- HR
  - Announcements
  - Probation
  - Notifications
  - Leave Management (admin view)
  - Holiday Calendar
  - Policies
- Recruitment
  - Dashboard
  - Requisition Pipeline
  - Job Openings
  - Candidate Pipeline
  - Hiring Forecasts
  - Interview Scheduler
  - Offer Management
- Talent
  - Resume Database
  - Talent Pools
  - Question Bank
  - Agencies
  - Recruiter Performance
- Finance
  - Finance Dashboard
  - CFO Dashboard
  - Chart of Accounts
  - Journal Entry
  - Period Closing
  - Customers & Suppliers
  - Invoices
  - Bills
  - Payment Batches
  - Bank Accounts
  - Financial Ratios
  - Reports
- Service Desk
  - Dashboard
  - All Tickets
  - Field Service
  - Visit Scheduler
  - Service Engineers
  - Knowledge Base
  - Contracts
  - Agent Workload
- CRM
  - Dashboard
  - Leads
  - Accounts
  - Contacts
  - Opportunities
  - Lead Activities
- Sales
  - Quotations
  - Sales Orders
  - Sales Targets
  - Forecasts
  - Playbooks
  - Calendar
  - Documents
  - Subscriptions
  - Partners
  - Territories
  - Competitors
- Marketing
  - Campaigns
  - Campaign Analytics
- Procurement
  - PR Dashboard
  - PO Management
  - Goods Receipt
- Inventory
  - Stock Summary
- Projects
  - Projects
  - Task Board
  - Project Costing
- Operations
  - Workflow Config
  - Project Tracker
  - Dept Workload
  - Bottlenecks
- Reports
  - Report Builder
  - Saved Reports
- Notifications
- Org Chart
- Audit Logs
- Settings

**Hidden Modules (Employee Self-Service):**
- Home (employee portal)
- Attendance
  - My Attendance
- Leaves
  - Apply Leave
- Travel Desk
  - My Requests
- Service Desk
  - My Tickets
- Timesheets
  - My Timesheets
- Performance
  - My Reviews

**Rationale:**
Super admins focus on strategic oversight, not personal tasks. They manage the system, view analytics, and oversee operations but don't need to apply for leave or submit timesheets themselves.

### Admin
**Philosophy:** Full system access for HR and administrative staff.

**Visible Modules:**
- All modules (no restrictions)
- Full access to both management and employee self-service modules

**Rationale:**
Admins need comprehensive access to manage all aspects of the system, including helping employees with their personal tasks.

### Department Head
**Philosophy:** Team management and oversight.

**Visible Modules:**
- Home
- Dashboard
- Approvals
- Employees
- Attendance (team view)
- Leaves (approvals)
- Recruitment
- Performance (team view)
- Projects
- Reports
- Settings

**Rationale:**
Department heads need to manage their teams, approve requests, and view team performance.

### Manager
**Philosophy:** Team supervision and operational management.

**Visible Modules:**
- Home
- Dashboard
- Approvals
- Employees
- Attendance (team view)
- Leaves (approvals)
- Recruitment
- Performance (team view)
- Projects
- Reports
- Settings

**Rationale:**
Similar to department heads but may have more limited scope depending on permissions.

### Employee
**Philosophy:** Self-service and day-to-day operations.

**Visible Modules:**
- Home
- Attendance
  - My Attendance
- Leaves
  - Apply Leave
  - Leave Calendar
- Travel Desk
  - My Requests
  - Travel Calendar
- Service Desk
  - My Tickets
  - All Tickets
- HR
  - Announcements
  - Policies
  - Holiday Calendar
  - Notifications
- Timesheets
  - My Timesheets

**Rationale:**
Employees need access to their personal tasks and company information but not management functions.

## Implementation Details

### Filtering Logic

```javascript
// 1. Define employee self-service submenu items
const employeeSelfServiceSubmenuItems = [
  "Apply Leave",
  "My Leaves",
  "My Attendance",
  "My Requests",
  "My Tickets",
  "My Timesheets",
  "My Reviews",
  "Leave Application"
];

// 2. Filter submenus for super admin
const filterSubmenuForSuperAdmin = (submenu) => {
  if (!submenu) return submenu;
  return submenu.filter(sub => !employeeSelfServiceSubmenuItems.includes(sub.name));
};

// 3. Define super admin allowed modules
const superAdminModules = [
  'Dashboard',
  'Approvals',
  'Employees',
  'HR',
  'Recruitment',
  'Talent',
  'Finance',
  'Service Desk',
  'CRM',
  'Sales',
  'Marketing',
  'Procurement',
  'Inventory',
  'Projects',
  'Operations',
  'Reports',
  'Notifications',
  'Org Chart',
  'Audit Logs',
  'Settings'
];

// 4. Filter menu items
if (userRole === 'super_admin') {
  filteredMenuItems = filteredMenuItems
    .filter(item => superAdminModules.includes(item.name))
    .map(item => ({
      ...item,
      submenu: item.submenu ? filterSubmenuForSuperAdmin(item.submenu) : undefined
    }));
}
```

### Permission-Based Filtering

In addition to role-based filtering, the sidebar also checks module-level permissions:

```javascript
const moduleName = moduleMap[item.name];
if (moduleName && !hasPermission(moduleName, "view")) {
  return false;
}
```

This ensures that even if a role typically has access to a module, individual permissions can further restrict access.

## Module Categories

### Management Modules
- Dashboard
- Employees
- Finance
- Projects
- Reports
- Inventory
- CRM
- Sales
- Marketing
- Procurement
- Operations
- Recruitment
- Talent

### Employee Self-Service Modules
- Home (employee portal)
- My Attendance
- Apply Leave
- My Requests (travel)
- My Tickets (service)
- My Timesheets
- My Reviews

### Shared Modules
- HR (announcements, policies)
- Service Desk (can be both management and self-service)
- Approvals
- Notifications

## Testing Visibility Rules

### Test Super Admin
1. Login as `superadmin@company.com`
2. Verify sidebar shows:
   - ✅ Dashboard
   - ✅ Employees
   - ✅ Finance
   - ✅ Projects
   - ✅ Reports
   - ✅ Inventory
   - ✅ Service Desk (management view)
   - ✅ Recruitment
3. Verify sidebar does NOT show:
   - ❌ Home (employee portal)
   - ❌ Attendance > My Attendance
   - ❌ Leaves > Apply Leave
   - ❌ Travel Desk > My Requests
   - ❌ Service Desk > My Tickets
   - ❌ Timesheets > My Timesheets
   - ❌ Performance > My Reviews

### Test Admin
1. Login as `admin@company.com`
2. Verify sidebar shows ALL modules

### Test Employee
1. Login as `employee@company.com`
2. Verify sidebar shows only employee self-service modules
3. Verify sidebar does NOT show management modules

## Customization

To add a new module to super admin view:

1. Add module name to `superAdminModules` array
2. Ensure module is not in employee self-service list

To hide a submenu item from super admin:

1. Add submenu item name to `employeeSelfServiceSubmenuItems` array

## Benefits

1. **Cleaner UI:** Users only see relevant options
2. **Better UX:** Reduces confusion and navigation time
3. **Security:** Prevents accidental access to restricted areas
4. **Role Clarity:** Clear separation between management and employee functions
5. **Scalability:** Easy to add new roles or modify existing ones

## Future Enhancements

1. **Dynamic Module Loading:** Load modules based on company configuration
2. **Custom Role Creation:** Allow admins to create custom roles with specific module access
3. **Favorites:** Allow users to pin frequently used modules
4. **Recent Items:** Show recently accessed pages
5. **Search:** Add search functionality to quickly find modules
