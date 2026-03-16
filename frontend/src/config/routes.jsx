/**
 * routes.jsx — single source of truth for all ERP navigation and routing.
 *
 * To add a new page:
 *   1. Create the page component file.
 *   2. Add one entry to ROUTES below with its key, lazy import, and optional module permission.
 *   3. Add it to NAV_ITEMS if it needs a sidebar link.
 *   Done. No changes needed anywhere else.
 *
 * `module`  — permission key checked against hasPermission(module, 'view').
 *             Omit for pages that are always accessible once logged in.
 * `props`   — function (ctx) => object, where ctx = { setPage, selectedEmployee, setSelectedEmployee, role }.
 *             Omit for pages that need no extra props.
 */

import { lazy } from 'react';
import {
  FaHome, FaUsers, FaChartLine, FaBullhorn, FaProjectDiagram,
  FaBox, FaFileAlt, FaCog, FaClock, FaStar, FaHandshake,
  FaShoppingCart, FaBell, FaSitemap, FaHistory, FaCalendarCheck,
  FaUmbrellaBeach, FaBriefcase, FaHeadset, FaPlane, FaCogs, FaShieldAlt,
} from 'react-icons/fa';

// ---------------------------------------------------------------------------
// Route registry
// ---------------------------------------------------------------------------
export const ROUTES = {
  // Core
  Home:                 { component: lazy(() => import('@/pages/Home')),
                          props: ctx => ({ setPage: ctx.setPage }) },
  ERPDashboard:         { component: lazy(() => import('@/components/dashboard/DashboardEngine')),
                          props: ctx => ({ role: ctx.role }) },
  SuperAdminDashboard:  { component: lazy(() => import('@/pages/SuperAdminDashboard')),
                          props: ctx => ({ setPage: ctx.setPage }) },
  AdminDashboard:       { component: lazy(() => import('@/pages/AdminDashboard')),
                          props: ctx => ({ setPage: ctx.setPage }) },
  ManagerDashboard:     { component: lazy(() => import('@/pages/ManagerDashboard')),
                          props: ctx => ({ setPage: ctx.setPage }) },
  EmployeeDashboard:    { component: lazy(() => import('@/pages/EmployeeDashboard')),
                          props: ctx => ({ setPage: ctx.setPage }) },
  Unauthorized:         { component: lazy(() => import('@/pages/Unauthorized')),
                          props: ctx => ({ setPage: ctx.setPage }) },

  // Employees
  EmployeesDashboard: { module: 'employees', component: lazy(() => import('@/features/employees/pages/EmployeesDashboard')),
                        props: ctx => ({ setPage: ctx.setPage, setSelectedEmployee: ctx.setSelectedEmployee }) },
  EmployeesData:      { module: 'employees', component: lazy(() => import('@/features/employees/pages/EmployeesData')),
                        props: ctx => ({ setPage: ctx.setPage, setSelectedEmployee: ctx.setSelectedEmployee }) },
  ExEmployees:        { module: 'employees', component: lazy(() => import('@/features/employees/pages/ExEmployees')),
                        props: ctx => ({ setPage: ctx.setPage, setSelectedEmployee: ctx.setSelectedEmployee }) },
  EmployeeProfile:    { module: 'employees', component: lazy(() => import('@/features/employees/pages/EmployeeProfile')),
                        props: ctx => ({ employee: ctx.selectedEmployee, setPage: ctx.setPage, setSelectedEmployee: ctx.setSelectedEmployee }) },
  AddEmployee:        { module: 'employees', component: lazy(() => import('@/features/employees/pages/AddEmployee')),
                        props: ctx => ({ setPage: ctx.setPage, employee: ctx.selectedEmployee, setSelectedEmployee: ctx.setSelectedEmployee }) },
  EditEmployee:       { module: 'employees', component: lazy(() => import('@/features/employees/pages/EditEmployee')),
                        props: ctx => ({ employee: ctx.selectedEmployee, setPage: ctx.setPage }) },

  // HR
  Announcements:   { module: 'announcements', component: lazy(() => import('@/features/hr/pages/Announcements')) },
  Probation:       { component: lazy(() => import('@/features/hr/pages/Probation')) },
  HolidayCalendar: { component: lazy(() => import('@/features/hr/pages/HolidayCalendar')) },
  Policies:        { module: 'policies',      component: lazy(() => import('@/features/hr/pages/Policies')) },
  Downloads:       { module: 'downloads',     component: lazy(() => import('@/features/hr/pages/Downloads')) },
  Notifications:   { component: lazy(() => import('@/features/notifications/pages/Notifications')) },
  Payroll:         { module: 'hr',            component: lazy(() => import('@/features/hr/pages/Payroll')),
                     props: ctx => ({ setPage: ctx.setPage }) },

  // Leaves
  LeaveApplication:  { module: 'leave', component: lazy(() => import('@/features/leaves/pages/LeaveApplication')) },
  LeaveManagementNew:{ module: 'leave', component: lazy(() => import('@/features/leaves/pages/LeaveManagement')) },
  LeaveManagement:   { module: 'leave', component: lazy(() => import('@/features/leaves/pages/LeaveManagement')) },
  ApplyLeave:        { module: 'leave', component: lazy(() => import('@/features/leaves/pages/ApplyLeave')) },
  MyLeaves:          { module: 'leave', component: lazy(() => import('@/features/leaves/pages/MyLeaves')) },
  TeamLeaves:        { module: 'leave', component: lazy(() => import('@/features/leaves/pages/TeamLeaves')) },
  AllLeaves:         { module: 'leave', component: lazy(() => import('@/features/leaves/pages/AllLeaves')) },
  LeaveSettings:     { module: 'leave', component: lazy(() => import('@/features/leaves/pages/LeaveSettings')) },
  LeaveApprovals:    { module: 'leave', component: lazy(() => import('@/features/leaves/pages/LeaveApprovals')) },
  LeaveCalendar:     { module: 'leave', component: lazy(() => import('@/features/leaves/pages/LeaveCalendar')) },

  // Attendance
  AttendanceDashboard: { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/AttendanceDashboard')) },
  TeamAttendance:      { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/TeamAttendance')) },
  LateArrivals:        { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/LateArrivals')) },

  // Approvals / Notifications
  ApprovalCenter:    { component: lazy(() => import('@/features/approvals/pages/ApprovalCenter')) },
  NotificationCenter:{ component: lazy(() => import('@/features/notifications/pages/NotificationCenter')) },

  // Finance
FinanceDashboardNew: {
  module: 'finance',
  component: lazy(() => import('@/features/finance/pages/FinanceDashboard')),
  props: ctx => ({ setPage: ctx.setPage }),
},
CFODashboard: {
  module: 'finance',
  component: lazy(() => import('@/features/finance/pages/CFODashboard')),
  props: ctx => ({ setPage: ctx.setPage }),
},
ChartOfAccounts: {
  module: 'finance',
  component: lazy(() => import('@/features/finance/pages/ChartOfAccounts')),
},
JournalEntry: {
  module: 'finance',
  component: lazy(() => import('@/features/finance/pages/JournalEntry')),
},
PeriodClosing: {
  module: 'finance',
  component: lazy(() => import('@/features/finance/pages/PeriodClosing')),
},
Parties: {
  module: 'finance',
  component: lazy(() => import('@/features/finance/pages/Parties')),
  props: ctx => ({ setPage: ctx.setPage }),
},
InvoicesNew: {
  module: 'finance',
  component: lazy(() => import('@/features/finance/pages/Invoices')),
},
SupplierBills: {
  module: 'finance',
  component: lazy(() => import('@/features/finance/pages/SupplierBills')),
},
PaymentBatch: {
  module: 'finance',
  component: lazy(() => import('@/features/finance/pages/PaymentBatch')),
},
BankAccounts: {
  module: 'finance',
  component: lazy(() => import('@/features/finance/pages/BankAccounts')),
},
FinancialRatios: {
  module: 'finance',
  component: lazy(() => import('@/features/finance/pages/FinancialRatios')),
},
FinanceReports: {
  module: 'finance',
  component: lazy(() => import('@/features/finance/pages/Reports')),
},
Tickets: {
  module: 'finance',
  component: lazy(() => import('@/features/finance/pages/Tickets')),
},

  // Procurement / Inventory
  PurchaseRequestDashboard: { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/PurchaseRequest')) },
  PurchaseOrderManagement:  { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/PurchaseOrderManagement')) },
  PurchaseOrders:           { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/PurchaseOrders')) },
  GoodsReceipt:             { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/GoodsReceipt')) },
  StockSummary:             { module: 'inventory',   component: lazy(() => import('@/features/inventory/pages/StockSummary')) },
  InventoryDashboard:       { module: 'inventory',   component: lazy(() => import('@/features/inventory/pages/InventoryDashboard')),
                              props: ctx => ({ setPage: ctx.setPage }) },
  ItemMaster:               { module: 'inventory',   component: lazy(() => import('@/features/inventory/pages/ItemMaster')),
                              props: ctx => ({ setPage: ctx.setPage }) },
  StockMovements:           { module: 'inventory',   component: lazy(() => import('@/features/inventory/pages/StockMovements')) },

  // Projects
  ProjectsDashboard: { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectsDashboard')),
                       props: ctx => ({ setPage: ctx.setPage }) },
  ProjectDetail:     { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectDetail')),
                       props: ctx => ({ setPage: ctx.setPage }) },
  Projects:          { module: 'projects', component: lazy(() => import('@/features/projects/pages/Projects')) },
  KanbanBoard:       { module: 'projects', component: lazy(() => import('@/features/projects/pages/KanbanBoard')) },
  ProjectCosting:    { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectCosting')) },

  // Timesheets
  MyTimesheet:       { module: 'timesheets', component: lazy(() => import('@/features/timesheets/pages/MyTimesheet')) },
  Timesheets:        { module: 'timesheets', component: lazy(() => import('@/features/timesheets/pages/Timesheets')) },
  TimesheetApprovals:{ module: 'timesheets', component: lazy(() => import('@/features/timesheets/pages/TimesheetApprovals')) },
  UtilizationReport: { module: 'timesheets', component: lazy(() => import('@/features/timesheets/pages/UtilizationReport')) },

  // Performance
  PerformanceReviews:{ module: 'performance', component: lazy(() => import('@/features/performance/pages/PerformanceReviews')),
                       props: ctx => ({ setPage: ctx.setPage }) },
  Goals:             { module: 'performance', component: lazy(() => import('@/features/performance/pages/Goals')) },
  TeamPerformance:   { module: 'performance', component: lazy(() => import('@/features/performance/pages/TeamPerformance')) },

  // CRM
  SalesDashboard:      { component: lazy(() => import('@/features/crm/pages/SalesDashboard')) },
  Leads:               { component: lazy(() => import('@/features/crm/pages/Leads')) },
  Accounts:            { component: lazy(() => import('@/features/crm/pages/Accounts')) },
  Contacts:            { component: lazy(() => import('@/features/crm/pages/Contacts')) },
  OpportunitiesKanban: { component: lazy(() => import('@/features/crm/pages/OpportunitiesKanban')) },
  LeadActivities:      { component: lazy(() => import('@/features/crm/pages/LeadActivities')) },

  // Sales
  Quotations:    { component: lazy(() => import('@/features/sales/pages/Quotations')) },
  SalesOrders:   { component: lazy(() => import('@/features/sales/pages/SalesOrders')) },
  SalesTargets:  { component: lazy(() => import('@/features/sales/pages/SalesTargets')) },
  SalesForecasts:{ component: lazy(() => import('@/features/sales/pages/SalesForecasts')) },
  SalesPlaybooks:{ component: lazy(() => import('@/features/sales/pages/SalesPlaybooks')) },
  SalesCalendar: { component: lazy(() => import('@/features/sales/pages/SalesCalendar')) },
  SalesDocuments:{ component: lazy(() => import('@/features/sales/pages/SalesDocuments')) },
  Subscriptions: { component: lazy(() => import('@/features/sales/pages/Subscriptions')) },
  SalesPartners: { component: lazy(() => import('@/features/sales/pages/SalesPartners')) },
  Territories:   { component: lazy(() => import('@/features/sales/pages/Territories')) },
  Competitors:   { component: lazy(() => import('@/features/sales/pages/Competitors')) },

  // Marketing
  Campaigns:        { component: lazy(() => import('@/features/marketing/pages/Campaigns')) },
  CampaignAnalytics:{ component: lazy(() => import('@/features/marketing/pages/CampaignAnalytics')) },

  // Recruitment
  RecruitmentDashboard:  { component: lazy(() => import('@/features/recruitment/pages/RecruitmentDashboard')),
                           props: ctx => ({ setPage: ctx.setPage }) },
  JobRequisitionPipeline:{ component: lazy(() => import('@/features/recruitment/pages/JobRequisitionPipeline')) },
  JobOpenings:           { component: lazy(() => import('@/features/recruitment/pages/JobOpenings')) },
  CandidatePipeline:     { component: lazy(() => import('@/features/recruitment/pages/CandidatePipeline')) },
  HiringForecasts:       { component: lazy(() => import('@/features/recruitment/pages/HiringForecasts')) },
  InterviewScheduler:    { component: lazy(() => import('@/features/recruitment/pages/InterviewScheduler')) },
  OfferManagement:       { component: lazy(() => import('@/features/recruitment/pages/OfferManagement')) },

  // Talent
  ResumeDatabase:       { component: lazy(() => import('@/features/talent/pages/ResumeDatabase')) },
  TalentPools:          { component: lazy(() => import('@/features/talent/pages/TalentPools')) },
  InterviewQuestionBank:{ component: lazy(() => import('@/features/talent/pages/InterviewQuestionBank')) },
  RecruitmentAgencies:  { component: lazy(() => import('@/features/talent/pages/RecruitmentAgencies')) },
  RecruiterDashboard:   { component: lazy(() => import('@/features/talent/pages/RecruiterDashboard')) },

  // Service Desk
  SupportDashboard:   { component: lazy(() => import('@/features/servicedesk/pages/SupportDashboard')) },
  AllTickets:         { component: lazy(() => import('@/features/servicedesk/pages/AllTickets')) },
  MyTickets:          { component: lazy(() => import('@/features/servicedesk/pages/MyTickets')) },
  FieldService:       { component: lazy(() => import('@/features/servicedesk/pages/FieldService')) },
  FieldVisitScheduler:{ component: lazy(() => import('@/features/servicedesk/pages/FieldVisitScheduler')) },
  ServiceEngineers:   { component: lazy(() => import('@/features/servicedesk/pages/ServiceEngineers')) },
  KnowledgeBase:      { component: lazy(() => import('@/features/servicedesk/pages/KnowledgeBase')) },
  ServiceContracts:   { component: lazy(() => import('@/features/servicedesk/pages/ServiceContracts')) },
  AgentWorkload:      { component: lazy(() => import('@/features/servicedesk/pages/AgentWorkload')) },

  // Travel Desk
  TravelDashboard: { component: lazy(() => import('@/features/travel/pages/TravelDashboard')) },
  TravelRequests:  { component: lazy(() => import('@/features/travel/pages/TravelRequests')) },
  TravelCalendar:  { component: lazy(() => import('@/features/travel/pages/TravelCalendar')) },
  TravelBookings:  { component: lazy(() => import('@/features/travel/pages/TravelBookings')) },
  TravelAdvances:  { component: lazy(() => import('@/features/travel/pages/TravelAdvances')) },
  TravelExpenses:  { component: lazy(() => import('@/features/travel/pages/TravelExpenses')) },
  TravelApprovals: { component: lazy(() => import('@/features/travel/pages/TravelApprovals')) },
  TravelAnalytics: { component: lazy(() => import('@/features/travel/pages/TravelAnalytics')) },

  // Operations
  WorkflowConfiguration: { component: lazy(() => import('@/features/operations/pages/WorkflowConfiguration')) },
  ProjectWorkflowTracker:{ component: lazy(() => import('@/features/operations/pages/ProjectWorkflowTracker')) },
  DepartmentWorkload:    { component: lazy(() => import('@/features/operations/pages/DepartmentWorkload')) },
  BottleneckAnalytics:   { component: lazy(() => import('@/features/operations/pages/BottleneckAnalytics')) },

  // Reports / Org / Audit
  Reports:     { module: 'reports', component: lazy(() => import('@/features/reports/pages/Reports')) },
  SavedReports:{ module: 'reports', component: lazy(() => import('@/features/reports/pages/SavedReports')) },
  OrgChart:    { component: lazy(() => import('@/features/orgchart/pages/OrgChart')) },
  AuditLogs:   { component: lazy(() => import('@/features/audit/pages/AuditLogs')) },
};

// ---------------------------------------------------------------------------
// Sidebar navigation tree
// Each leaf node's `page` key must match a key in ROUTES above.
// `module` on a group controls visibility for that entire group.
// ---------------------------------------------------------------------------
export const NAV_ITEMS = [
  { name: 'Home',                icon: <FaHome />,          page: 'Home' },
  { name: 'SuperAdminDashboard', icon: <FaChartLine />,     page: 'SuperAdminDashboard' },
  { name: 'Admin',               icon: <FaShieldAlt />,     page: 'AdminDashboard' },
  { name: 'Manager Dashboard',   icon: <FaChartLine />,     page: 'ManagerDashboard' },
  { name: 'My Dashboard',        icon: <FaHome />,          page: 'EmployeeDashboard' },
  { name: 'Dashboard',           icon: <FaChartLine />,     page: 'ERPDashboard' },
  { name: 'Approvals',           icon: <FaBell />,          page: 'ApprovalCenter' },
  { name: 'Employees', icon: <FaUsers />, module: 'employees', submenu: [
    { name: 'Employees Dashboard', page: 'EmployeesDashboard' },
    { name: 'Employees Data',      page: 'EmployeesData' },
    { name: 'Ex-Employees',        page: 'ExEmployees' },
  ]},
  { name: 'HR', icon: <FaBullhorn />, module: 'announcements', submenu: [
    { name: 'Announcements',    page: 'Announcements' },
    { name: 'Payroll',          page: 'Payroll' },
    { name: 'Probation',        page: 'Probation' },
    { name: 'Notifications',    page: 'Notifications' },
    { name: 'Leave Application',page: 'LeaveApplication' },
    { name: 'Leave Management', page: 'LeaveManagementNew' },
    { name: 'Holiday Calendar', page: 'HolidayCalendar' },
    { name: 'Policies',         page: 'Policies' },
    { name: 'Downloads',        page: 'Downloads' },
  ]},
  { name: 'Recruitment', icon: <FaBriefcase />, submenu: [
    { name: 'Dashboard',            page: 'RecruitmentDashboard' },
    { name: 'Requisition Pipeline', page: 'JobRequisitionPipeline' },
    { name: 'Job Openings',         page: 'JobOpenings' },
    { name: 'Candidate Pipeline',   page: 'CandidatePipeline' },
    { name: 'Hiring Forecasts',     page: 'HiringForecasts' },
    { name: 'Interview Scheduler',  page: 'InterviewScheduler' },
    { name: 'Offer Management',     page: 'OfferManagement' },
  ]},
  { name: 'Talent', icon: <FaStar />, submenu: [
    { name: 'Resume Database',     page: 'ResumeDatabase' },
    { name: 'Talent Pools',        page: 'TalentPools' },
    { name: 'Question Bank',       page: 'InterviewQuestionBank' },
    { name: 'Agencies',            page: 'RecruitmentAgencies' },
    { name: 'Recruiter Performance', page: 'RecruiterDashboard' },
  ]},
  { name: 'Attendance', icon: <FaCalendarCheck />, module: 'attendance', submenu: [
    { name: 'My Attendance',  page: 'AttendanceDashboard' },
    { name: 'Team Attendance',page: 'TeamAttendance' },
    { name: 'Late Arrivals',  page: 'LateArrivals' },
  ]},
  { name: 'Leaves', icon: <FaUmbrellaBeach />, module: 'leave', submenu: [
    { name: 'My Leaves',     page: 'MyLeaves' },
    { name: 'All Leaves',    page: 'AllLeaves' },
    { name: 'Team Leaves',   page: 'TeamLeaves' },
    { name: 'Apply Leave',   page: 'LeaveManagementNew' },
    { name: 'Leave Approvals',page: 'LeaveApprovals' },
    { name: 'Leave Calendar', page: 'LeaveCalendar' },
    { name: 'Leave Settings', page: 'LeaveSettings' },
  ]},
  { name: 'Finance', icon: <FaChartLine />, module: 'finance', submenu: [
    { name: 'Finance Dashboard',    page: 'FinanceDashboardNew' },
    { name: 'CFO Dashboard',        page: 'CFODashboard' },
    { name: 'Chart of Accounts',    page: 'ChartOfAccounts' },
    { name: 'Journal Entry',        page: 'JournalEntry' },
    { name: 'Period Closing',       page: 'PeriodClosing' },
    { name: 'Customers & Suppliers',page: 'Parties' },
    { name: 'Invoices',             page: 'InvoicesNew' },
    { name: 'Bills',                page: 'SupplierBills' },
    { name: 'Payment Batches',      page: 'PaymentBatch' },
    { name: 'Bank Accounts',        page: 'BankAccounts' },
    { name: 'Financial Ratios',     page: 'FinancialRatios' },
    { name: 'Reports',              page: 'FinanceReports' },
    { name: 'Tickets',              page: 'Tickets' },
  ]},
  { name: 'Service Desk', icon: <FaHeadset />, module: 'service', submenu: [
    { name: 'Dashboard',        page: 'SupportDashboard' },
    { name: 'All Tickets',      page: 'AllTickets' },
    { name: 'My Tickets',       page: 'MyTickets' },
    { name: 'Field Service',    page: 'FieldService' },
    { name: 'Visit Scheduler',  page: 'FieldVisitScheduler' },
    { name: 'Service Engineers',page: 'ServiceEngineers' },
    { name: 'Knowledge Base',   page: 'KnowledgeBase' },
    { name: 'Contracts',        page: 'ServiceContracts' },
    { name: 'Agent Workload',   page: 'AgentWorkload' },
  ]},
  { name: 'Travel Desk', icon: <FaPlane />, module: 'travel', submenu: [
    { name: 'Dashboard',      page: 'TravelDashboard' },
    { name: 'My Requests',    page: 'TravelRequests' },
    { name: 'Travel Calendar',page: 'TravelCalendar' },
    { name: 'Bookings',       page: 'TravelBookings' },
    { name: 'Advances',       page: 'TravelAdvances' },
    { name: 'Expenses',       page: 'TravelExpenses' },
    { name: 'Approvals',      page: 'TravelApprovals' },
    { name: 'Analytics',      page: 'TravelAnalytics' },
  ]},
  { name: 'CRM', icon: <FaHandshake />, submenu: [
    { name: 'Dashboard',      page: 'SalesDashboard' },
    { name: 'Leads',          page: 'Leads' },
    { name: 'Accounts',       page: 'Accounts' },
    { name: 'Contacts',       page: 'Contacts' },
    { name: 'Opportunities',  page: 'OpportunitiesKanban' },
    { name: 'Lead Activities',page: 'LeadActivities' },
  ]},
  { name: 'Sales', icon: <FaShoppingCart />, submenu: [
    { name: 'Quotations',   page: 'Quotations' },
    { name: 'Sales Orders', page: 'SalesOrders' },
    { name: 'Sales Targets',page: 'SalesTargets' },
    { name: 'Forecasts',    page: 'SalesForecasts' },
    { name: 'Playbooks',    page: 'SalesPlaybooks' },
    { name: 'Calendar',     page: 'SalesCalendar' },
    { name: 'Documents',    page: 'SalesDocuments' },
    { name: 'Subscriptions',page: 'Subscriptions' },
    { name: 'Partners',     page: 'SalesPartners' },
    { name: 'Territories',  page: 'Territories' },
    { name: 'Competitors',  page: 'Competitors' },
  ]},
  { name: 'Marketing', icon: <FaBullhorn />, submenu: [
    { name: 'Campaigns',         page: 'Campaigns' },
    { name: 'Campaign Analytics',page: 'CampaignAnalytics' },
  ]},
  { name: 'Procurement', icon: <FaProjectDiagram />, module: 'procurement', submenu: [
    { name: 'PR Dashboard',  page: 'PurchaseRequestDashboard' },
    { name: 'PO Management', page: 'PurchaseOrderManagement' },
    { name: 'Purchase Orders',page: 'PurchaseOrders' },
    { name: 'Goods Receipt', page: 'GoodsReceipt' },
  ]},
  { name: 'Inventory', icon: <FaBox />, module: 'inventory', submenu: [
    { name: 'Dashboard',      page: 'InventoryDashboard' },
    { name: 'Item Master',    page: 'ItemMaster' },
    { name: 'Stock Summary',  page: 'StockSummary' },
    { name: 'Stock Movements',page: 'StockMovements' },
  ]},
  { name: 'Projects', icon: <FaProjectDiagram />, module: 'projects', submenu: [
    { name: 'Dashboard',      page: 'ProjectsDashboard' },
    { name: 'Projects',       page: 'Projects' },
    { name: 'Task Board',     page: 'KanbanBoard' },
    { name: 'Project Costing',page: 'ProjectCosting' },
  ]},
  { name: 'Operations', icon: <FaCogs />, submenu: [
    { name: 'Workflow Config',  page: 'WorkflowConfiguration' },
    { name: 'Project Tracker',  page: 'ProjectWorkflowTracker' },
    { name: 'Dept Workload',    page: 'DepartmentWorkload' },
    { name: 'Bottlenecks',      page: 'BottleneckAnalytics' },
  ]},
  { name: 'Timesheets', icon: <FaClock />, module: 'timesheets', submenu: [
    { name: 'My Timesheet',        page: 'MyTimesheet' },
    { name: 'Timesheet Approvals', page: 'TimesheetApprovals' },
    { name: 'Utilization Report',  page: 'UtilizationReport' },
  ]},
  { name: 'Performance', icon: <FaStar />, module: 'performance', submenu: [
    { name: 'My Reviews',      page: 'PerformanceReviews' },
    { name: 'Goals & KPIs',    page: 'Goals' },
    { name: 'Team Performance',page: 'TeamPerformance' },
  ]},
  { name: 'Reports', icon: <FaFileAlt />, module: 'reports', submenu: [
    { name: 'Report Builder', page: 'Reports' },
    { name: 'Saved Reports',  page: 'SavedReports' },
  ]},
  { name: 'Notifications', icon: <FaBell />,    page: 'NotificationCenter' },
  { name: 'Org Chart',     icon: <FaSitemap />, page: 'OrgChart' },
  { name: 'Audit Logs',    icon: <FaHistory />, page: 'AuditLogs' },
  { name: 'Settings',      icon: <FaCog /> },
];
