/**
 * moduleRegistry.js — Single source of truth for all ERP modules.
 *
 * Each entry describes:
 *   id          — unique module identifier (used in hasAccess / ModuleGuard)
 *   name        — display label in sidebar
 *   icon        — lucide-react component name (string); resolved via ICON_MAP
 *   page        — ROUTES key for leaf-level items (omit for parent-only nodes)
 *   permissions — roles that can see this item; empty array = visible to all authenticated users
 *   children    — sub-pages (same shape, minus children)
 *
 * Role hierarchy (for reference):
 *   super_admin → everything
 *   admin       → everything except HR-sensitive payroll/payslip internals
 *   manager     → team-facing pages; no finance write, no admin
 *   employee    → self-service: dashboard, leaves, timesheets, travel, service desk, profile
 */

import {
  Home, LayoutDashboard, ShieldCheck, Shield, BarChart2,
  Users, Megaphone, Briefcase, Star, CalendarCheck, Umbrella,
  TrendingUp, Headphones, Plane, Handshake, ShoppingCart,
  Target, Package, Box, FolderKanban, Settings2, Clock,
  Trophy, FileText, Bell, Network, History, Settings, CheckSquare, PenSquare,
  LineChart,
  PieChart,
  Activity,
  MessageSquareWarning,
  MessageSquare,
  Database,
  FlaskConical,
  Factory,
  Sparkles,
  BotMessageSquare,
  Zap,
} from 'lucide-react';

/** Icon lookup — keyed by the string stored in each registry entry. */
export const ICON_MAP = {
  LineChart,
  PieChart,
  Activity,
  MessageSquareWarning,
  Home,
  LayoutDashboard,
  ShieldCheck,
  Shield,
  BarChart2,
  Users,
  Megaphone,
  Briefcase,
  Star,
  CalendarCheck,
  Umbrella,
  TrendingUp,
  Headphones,
  Plane,
  Handshake,
  ShoppingCart,
  Target,
  Package,
  Box,
  FolderKanban,
  Settings2,
  Clock,
  Trophy,
  FileText,
  Bell,
  Network,
  History,
  Settings,
  CheckSquare,
  PenSquare,
  Database,
  FlaskConical,
  Factory,
  MessageSquare,
  Sparkles,
  BotMessageSquare,
  Zap,
};

export const MODULE_REGISTRY = [
  // ─────────────────────────────────────────────────────────────
  // Core / top-level single pages
  // ─────────────────────────────────────────────────────────────
  {
    id: 'home',
    name: 'Home',
    icon: 'Home',
    page: 'Home',
    permissions: ['super_admin', 'admin', 'manager', 'employee'],
  },
  {
    id: 'announcements',
    name: 'Announcements',
    icon: 'Megaphone',
    page: 'Announcements',
    permissions: ['super_admin', 'admin', 'manager', 'employee'],
  },
  {
    id: 'documentsigning',
    name: 'Document Signing',
    icon: 'PenSquare',
    page: 'DocumentSigning',
    permissions: ['super_admin', 'admin', 'manager'],
  },
  {
    id: 'native_signature',
    name: 'Digital Signatures',
    icon: 'Shield',
    page: 'NativeSignature',
    permissions: ['super_admin', 'admin', 'manager'],
  },
  {
    id: 'document_master',
    name: 'Document Master',
    icon: 'FolderOpen',
    page: 'DocumentMaster',
    permissions: ['super_admin', 'admin', 'manager', 'engineer'],
  },
  {
    id: 'system_health',
    name: 'System Health',
    icon: 'Activity',
    page: 'SystemHealth',
    permissions: ['super_admin', 'admin'],
  },
  {
    id: 'db_test',
    name: 'DB Write Tests',
    icon: 'FlaskConical',
    page: 'DatabaseTest',
    permissions: ['super_admin'],
  },
  {
    id: 'admin_dashboard',
    name: 'Operations',
    icon: 'Shield',
    page: 'AdminDashboard',
    permissions: ['super_admin', 'admin', 'manager'],
  },
  // ─────────────────────────────────────────────────────────────
  // Admin Setup
  // ─────────────────────────────────────────────────────────────
  {
    id: 'admin_setup',
    name: 'Admin Setup',
    icon: 'Settings',
    permissions: ['super_admin', 'admin'],
    children: [
      { id: 'admin.roles',    name: 'Roles',                 page: 'RolesSetup',          permissions: ['super_admin', 'admin'] },
      { id: 'admin.users',    name: 'Users',                 page: 'UserSetup',           permissions: ['super_admin', 'admin'] },
      { id: 'admin.docs',     name: 'Document Types',        page: 'DocumentSetup',       permissions: ['super_admin', 'admin'] },
      { id: 'admin.products', name: 'Product Setup',         page: 'ProductSetup',        permissions: ['super_admin', 'admin'] },
      { id: 'admin.policy',   name: 'Order Policy',          page: 'OrderPolicy',         permissions: ['super_admin', 'admin'] },
      { id: 'admin.approvers',name: 'Approver Setup',        page: 'ApproverSetup',       permissions: ['super_admin', 'admin'] },
      { id: 'admin.notifs',   name: 'Setup Notifications',   page: 'SetupNotifications',  permissions: ['super_admin', 'admin'] },
    ],
  },
  {
    id: 'employee_dashboard',
    name: 'My Dashboard',
    icon: 'LayoutDashboard',
    page: 'EmployeeDashboard',
    permissions: ['super_admin', 'admin', 'manager', 'employee'],
  },
  {
    id: 'approvals',
    name: 'Approvals',
    icon: 'CheckSquare',
    page: 'ApprovalCenter',
    permissions: ['super_admin', 'admin', 'manager', 'employee'],
  },

  // ─────────────────────────────────────────────────────────────
  // Employees
  // ─────────────────────────────────────────────────────────────
  {
    id: 'employees',
    name: 'Employees',
    icon: 'Users',
    permissions: ['super_admin', 'admin', 'manager'],
    children: [
      { id: 'employees.dashboard', name: 'Employees Dashboard', page: 'EmployeesDashboard', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'employees.data',      name: 'Employees Data',      page: 'EmployeesData',      permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'employees.ex',        name: 'Ex-Employees',        page: 'ExEmployees',        permissions: ['super_admin', 'admin'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // HR
  // ─────────────────────────────────────────────────────────────
  {
    id: 'hr',
    name: 'HR',
    icon: 'Megaphone',
    permissions: ['super_admin', 'admin', 'manager', 'employee'],
    children: [
      { id: 'hr.employees',    name: 'Employees',          page: 'EmployeesDashboard', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'hr.directory',    name: 'Employee Directory', page: 'EmployeeDirectory',  permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'hr.documents',    name: 'Employee Documents', page: 'EmployeeDocuments',  permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'hr.offboarding',  name: 'Offboarding',        page: 'Offboarding',        permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'hr.payslip',      name: 'Payslip Viewer',     page: 'PayslipViewer',      permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'hr.attendance',   name: 'Attendance',         page: 'AttendanceDashboard',permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'hr.payroll',      name: 'Payroll',            page: 'Payroll',            permissions: ['super_admin', 'admin'] },
      { id: 'hr.orgchart',     name: 'Org Chart',          page: 'OrgChart',           permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'hr.probation',    name: 'Probation',          page: 'Probation',          permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'hr.holiday',      name: 'Holiday Calendar',   page: 'HolidayCalendar',    permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'hr.policies',     name: 'Policies',           page: 'Policies',           permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'hr.downloads',    name: 'Downloads',          page: 'Downloads',          permissions: ['super_admin', 'admin', 'manager', 'employee'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Recruitment
  // ─────────────────────────────────────────────────────────────
  {
    id: 'recruitment',
    name: 'Recruitment',
    icon: 'Briefcase',
    permissions: ['super_admin', 'admin', 'manager', 'hr', 'recruiter'],
    children: [
      { id: 'recruitment.dashboard',  name: 'Dashboard',            page: 'RecruitmentDashboard',   permissions: ['super_admin', 'admin', 'manager', 'hr', 'recruiter'] },
      { id: 'recruitment.pipeline',   name: 'Requisition Pipeline', page: 'JobRequisitionPipeline', permissions: ['super_admin', 'admin', 'manager', 'hr', 'recruiter'] },
      { id: 'recruitment.openings',   name: 'Job Openings',         page: 'JobOpenings',            permissions: ['super_admin', 'admin', 'manager', 'hr', 'recruiter'] },
      { id: 'recruitment.candidates', name: 'Candidate Pipeline',   page: 'CandidatePipeline',      permissions: ['super_admin', 'admin', 'manager', 'hr', 'recruiter'] },
      { id: 'recruitment.all_cands',  name: 'All Candidates',       page: 'AllCandidates',          permissions: ['super_admin', 'admin', 'manager', 'hr', 'recruiter'] },
      { id: 'recruitment.interviews', name: 'Interview Scheduler',  page: 'InterviewScheduler',     permissions: ['super_admin', 'admin', 'manager', 'hr', 'recruiter'] },
      { id: 'recruitment.offers',     name: 'Offer Management',     page: 'OfferManagement',        permissions: ['super_admin', 'admin', 'manager', 'hr'] },
      { id: 'recruitment.onboarding', name: 'Onboarding Checklist', page: 'OnboardingChecklist',    permissions: ['super_admin', 'admin', 'manager', 'hr', 'recruiter'] },
      { id: 'recruitment.reports',    name: 'Recruitment Reports',  page: 'RecruitmentReports',     permissions: ['super_admin', 'admin', 'manager', 'hr'] },
      { id: 'recruitment.forecasts',  name: 'Hiring Forecasts',     page: 'HiringForecasts',        permissions: ['super_admin', 'admin', 'manager', 'hr'] },
      { id: 'recruitment.email_tmpl', name: 'Email Templates',      page: 'EmailTemplates',         permissions: ['super_admin', 'admin', 'manager', 'hr'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Talent
  // ─────────────────────────────────────────────────────────────
  {
    id: 'talent',
    name: 'Talent',
    icon: 'Star',
    permissions: ['super_admin', 'admin', 'manager', 'hr', 'recruiter'],
    children: [
      { id: 'talent.resumes',    name: 'Resume Database',       page: 'ResumeDatabase',        permissions: ['super_admin', 'admin', 'manager', 'hr', 'recruiter'] },
      { id: 'talent.pools',      name: 'Talent Pools',          page: 'TalentPools',           permissions: ['super_admin', 'admin', 'manager', 'hr', 'recruiter'] },
      { id: 'talent.questions',  name: 'Question Bank',         page: 'InterviewQuestionBank', permissions: ['super_admin', 'admin', 'manager', 'hr', 'recruiter'] },
      { id: 'talent.agencies',   name: 'Agencies',              page: 'RecruitmentAgencies',   permissions: ['super_admin', 'admin', 'manager', 'hr'] },
      { id: 'talent.recruiters', name: 'Recruiter Dashboard',   page: 'RecruiterDashboard',    permissions: ['super_admin', 'admin', 'manager', 'hr'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Attendance
  // ─────────────────────────────────────────────────────────────
  {
    id: 'attendance',
    name: 'Attendance',
    icon: 'CalendarCheck',
    permissions: ['super_admin', 'admin', 'manager', 'employee'],
    children: [
      { id: 'attendance.live',          name: 'Live Workforce',   page: 'LiveWorkforceDashboard',  permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'attendance.my',            name: 'My Attendance',    page: 'AttendanceDashboard',     permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'attendance.qr',            name: 'QR Attendance',    page: 'QRAttendance',            permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'attendance.team',          name: 'Team Attendance',  page: 'TeamAttendance',          permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'attendance.shift_cal',     name: 'Shift Calendar',   page: 'ShiftCalendar',           permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'attendance.regularize',    name: 'Regularization',   page: 'RegularizationApprovals', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'attendance.overtime',      name: 'Overtime',         page: 'OvertimeApprovals',       permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'attendance.analytics',     name: 'Analytics',        page: 'AttendanceAnalytics',     permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'attendance.monthly',       name: 'Monthly Report',   page: 'MonthlyAttendanceReport', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'attendance.late',          name: 'Late Arrivals',    page: 'LateArrivals',            permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'attendance.reports',       name: 'Reports',          page: 'AttendanceReports',       permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'attendance.work_centres',  name: 'Work Centres',     page: 'WorkCentres',             permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'attendance.contract',      name: 'Contract Labour',  page: 'ContractLabour',          permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'attendance.payroll_sync',  name: 'Payroll Sync',     page: 'PayrollSync',             permissions: ['super_admin', 'admin'] },
      { id: 'attendance.settings',      name: 'Settings',         page: 'AttendanceSettings',      permissions: ['super_admin', 'admin'] },
      { id: 'attendance.audit',         name: 'Audit Logs',       page: 'AttendanceAuditLogs',     permissions: ['super_admin', 'admin'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Leaves
  // ─────────────────────────────────────────────────────────────
  {
    id: 'leaves',
    name: 'Leaves',
    icon: 'Umbrella',
    permissions: ['super_admin', 'admin', 'manager', 'employee'],
    children: [
      { id: 'leaves.my',          name: 'My Leaves',         page: 'MyLeaves',          permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'leaves.apply',       name: 'Apply Leave',       page: 'ApplyLeave',        permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'leaves.approvals',   name: 'Leave Approvals',   page: 'LeaveApprovals',    permissions: ['super_admin', 'admin', 'manager', 'department_head', 'l2_approver', 'hr', 'hr_manager'] },
      { id: 'leaves.team',        name: 'Team Leaves',       page: 'TeamLeaves',        permissions: ['super_admin', 'admin', 'manager', 'department_head', 'hr', 'hr_manager'] },
      { id: 'leaves.calendar',    name: 'Leave Calendar',    page: 'LeaveCalendar',     permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'leaves.holidays',    name: 'Holiday Calendar',  page: 'HolidayCalendar',   permissions: ['super_admin', 'admin', 'manager', 'employee', 'hr'] },
      { id: 'leaves.compoff',     name: 'Comp Off',          page: 'CompOff',           permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'leaves.all',         name: 'All Leaves',        page: 'AllLeaves',         permissions: ['super_admin', 'admin', 'hr', 'hr_manager'] },
      { id: 'leaves.reports',     name: 'Leave Reports',     page: 'LeaveReports',      permissions: ['super_admin', 'admin', 'hr', 'hr_manager'] },
      { id: 'leaves.encashment',  name: 'Encashment',        page: 'LeaveEncashment',   permissions: ['super_admin', 'admin', 'hr', 'hr_manager'] },
      { id: 'leaves.settings',    name: 'Leave Settings',    page: 'LeaveSettings',     permissions: ['super_admin', 'admin', 'hr', 'hr_manager'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Finance
  // ─────────────────────────────────────────────────────────────
  {
    id: 'finance',
    name: 'Finance',
    icon: 'TrendingUp',
    permissions: ['super_admin', 'admin'],
    children: [
      { id: 'finance.dashboard',    name: 'Finance Dashboard',     page: 'FinanceDashboardNew', permissions: ['super_admin', 'admin', 'cfo', 'finance'] },
      { id: 'finance.accounting',   name: 'Accounting Engine',     page: 'AccountingEngine',    permissions: ['super_admin', 'admin', 'cfo', 'finance'] },
      { id: 'finance.receivables',  name: 'Receivables',           page: 'ReceivablesPage',     permissions: ['super_admin', 'admin', 'finance'] },
      { id: 'finance.payables',     name: 'Payables',              page: 'PayablesPage',        permissions: ['super_admin', 'admin', 'finance'] },
      { id: 'finance.payments',     name: 'Payments',              page: 'PaymentBatch',        permissions: ['super_admin', 'admin', 'finance'] },
      { id: 'finance.tax',          name: 'Tax & Compliance',      page: 'TaxManagement',       permissions: ['super_admin', 'admin', 'finance'] },
      { id: 'finance.budget',       name: 'Budget Management',     page: 'BudgetManagement',    permissions: ['super_admin', 'admin', 'cfo', 'finance'] },
      { id: 'finance.assets',       name: 'Fixed Assets',          page: 'FixedAssets',         permissions: ['super_admin', 'admin', 'finance'] },
      { id: 'finance.reports',      name: 'Financial Reports',     page: 'FinanceReports',      permissions: ['super_admin', 'admin', 'cfo', 'finance'] },
      { id: 'finance.parties',      name: 'Customers & Suppliers', page: 'Parties',             permissions: ['super_admin', 'admin', 'finance'] },
      { id: 'finance.settings',     name: 'Settings',              page: 'FinanceSettings',     permissions: ['super_admin', 'admin'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Service Desk
  // ─────────────────────────────────────────────────────────────
  {
    id: 'servicedesk',
    name: 'Service Desk',
    icon: 'Headphones',
    permissions: ['super_admin', 'admin', 'manager', 'employee'],
    children: [
      { id: 'servicedesk.dashboard', name: 'Dashboard',          page: 'SupportDashboard',    permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'servicedesk.all',       name: 'All Tickets',        page: 'AllTickets',          permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'servicedesk.my',        name: 'My Tickets',         page: 'MyTickets',           permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'servicedesk.field',     name: 'Field Service',      page: 'FieldVisitScheduler', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'servicedesk.engineers', name: 'Service Engineers',  page: 'ServiceEngineers',    permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'servicedesk.kb',        name: 'Knowledge Base',     page: 'KnowledgeBase',       permissions: ['super_admin', 'admin'] },
      { id: 'servicedesk.contracts', name: 'Contracts',          page: 'ServiceContracts',    permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'servicedesk.workload',  name: 'Agent Workload',     page: 'AgentWorkload',       permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'servicedesk.delivery',  name: 'Delivery Note',    page: 'DeliveryNote',     permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'servicedesk.rev_cust',  name: 'Review Customers', page: 'ReviewCustomers',  permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'servicedesk.rev_feed',  name: 'Review Feedback',  page: 'ReviewFeedback',   permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'servicedesk.rev_sites', name: 'Review Sites',     page: 'ReviewSites',      permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'servicedesk.ips',       name: 'Service Master',   page: 'ServiceMasterIPS', permissions: ['super_admin', 'admin', 'manager'] },
      // The other half of the IPS loop: a complaint (IPCS) escalates into a
      // service ticket (IPS). Sits next to Service Master on purpose.
      { id: 'servicedesk.ipcs',      name: 'Customer Complaints', page: 'CustomerComplaintsIPCS', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'servicedesk.master',    name: 'Service Catalog',  page: 'ServiceMaster',    permissions: ['super_admin', 'admin'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Travel Desk
  // ─────────────────────────────────────────────────────────────
  {
    id: 'travel',
    name: 'Travel Desk',
    icon: 'Plane',
    permissions: ['super_admin', 'admin', 'manager', 'employee'],
    children: [
      { id: 'travel.dashboard', name: 'Dashboard',       page: 'TravelDashboard', permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'travel.requests',  name: 'My Requests',     page: 'TravelRequests',  permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'travel.calendar',  name: 'Travel Calendar', page: 'TravelCalendar',  permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'travel.bookings',  name: 'Bookings',        page: 'TravelBookings',  permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'travel.advances',  name: 'Advances',        page: 'TravelAdvances',  permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'travel.expenses',  name: 'Expenses',        page: 'TravelExpenses',  permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'travel.approvals', name: 'Approvals',       page: 'TravelApprovals', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'travel.analytics', name: 'Analytics',       page: 'TravelAnalytics', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'travel.entry',    name: 'Travel Entry',   page: 'TravelEntry',   permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'travel.expense_review', name: 'Expense Review', page: 'ExpenseReview', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'travel.payment',  name: 'Payment',      page: 'TravelPayment', permissions: ['super_admin', 'admin', 'finance'] },
      { id: 'travel.audit',    name: 'Travel Audit', page: 'TravelAudit',   permissions: ['super_admin', 'admin', 'finance', 'manager'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // CRM
  // ─────────────────────────────────────────────────────────────
  {
    id: 'crm',
    name: 'CRM',
    icon: 'Handshake',
    permissions: ['super_admin', 'admin', 'manager'],
    children: [
      { id: 'crm.dashboard',     name: 'Dashboard',       page: 'SalesDashboard',      permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'crm.leads',         name: 'IEM — Enquiries', page: 'Leads',               permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'crm.accounts',      name: 'Accounts',        page: 'Accounts',              permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'crm.contacts',      name: 'Contacts',        page: 'Contacts',              permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'crm.opportunities', name: 'Opportunities',   page: 'OpportunitiesKanban',   permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'crm.pursuits',      name: 'Pursuits',        page: 'Pursuits',              permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'crm.health',        name: 'Health Engine',   page: 'CustomerHealthDashboard', permissions: ['super_admin', 'admin', 'manager'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Sales
  // ─────────────────────────────────────────────────────────────
  {
    id: 'sales',
    name: 'Sales',
    icon: 'ShoppingCart',
    permissions: ['super_admin', 'admin', 'manager'],
    children: [
      { id: 'sales.quotations',    name: 'Quotations',    page: 'Quotations',    permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'sales.orders',        name: 'Sales Orders',  page: 'SalesOrders',   permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'sales.targets',       name: 'Sales Targets', page: 'SalesTargets',  permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'sales.forecasts',     name: 'Forecasts',     page: 'SalesForecasts',permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'sales.playbooks',     name: 'Playbooks',     page: 'SalesPlaybooks',permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'sales.calendar',      name: 'Calendar',      page: 'SalesCalendar', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'sales.documents',     name: 'Documents',     page: 'SalesDocuments',permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'sales.subscriptions', name: 'Subscriptions', page: 'Subscriptions', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'sales.partners',      name: 'Partners',      page: 'SalesPartners', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'sales.territories',   name: 'Territories',   page: 'Territories',   permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'sales.competitors',   name: 'Competitors',   page: 'Competitors',   permissions: ['super_admin', 'admin', 'manager'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Marketing
  // ─────────────────────────────────────────────────────────────
  {
    id: 'marketing',
    name: 'Marketing',
    icon: 'Target',
    permissions: ['super_admin', 'admin', 'manager'],
    children: [
      { id: 'marketing.campaigns', name: 'Campaigns',          page: 'Campaigns',         permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'marketing.analytics', name: 'Campaign Analytics', page: 'CampaignAnalytics', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'marketing.dashboard', name: 'Marketing Dashboard', page: 'MarketingDashboard', permissions: ['super_admin', 'admin', 'manager'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Procurement
  // ─────────────────────────────────────────────────────────────
  {
    id: 'procurement',
    name: 'Procurement',
    icon: 'Package',
    permissions: ['super_admin', 'admin', 'manager'],
    children: [
      { id: 'procurement.pr',  name: 'Purchase Requests', page: 'PurchaseRequestDashboard', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'procurement.pom', name: 'PO Management',   page: 'PurchaseOrderManagement',  permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'procurement.po',  name: 'Purchase Orders', page: 'PurchaseOrders',           permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'procurement.gr',  name: 'Goods Receipt',   page: 'GoodsReceipt',             permissions: ['super_admin', 'admin', 'manager'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Inventory
  // ─────────────────────────────────────────────────────────────
  {
    id: 'inventory',
    name: 'Inventory',
    icon: 'Box',
    permissions: ['super_admin', 'admin', 'manager', 'stores_manager', 'production_head'],
    children: [
      { id: 'inventory.dashboard',    name: 'Dashboard',           page: 'InventoryDashboard',         permissions: ['super_admin', 'admin', 'manager', 'stores_manager', 'production_head'] },
      { id: 'inventory.stores',       name: 'Stores Dashboard',    page: 'StoresDashboard',            permissions: ['super_admin', 'admin', 'manager', 'stores_manager'] },
      { id: 'inventory.items',        name: 'Item Master',         page: 'ItemMaster',                 permissions: ['super_admin', 'admin', 'manager', 'stores_manager'] },
      { id: 'inventory.serials',      name: 'Serial Tracking',     page: 'SerialTracking',             permissions: ['super_admin', 'admin', 'manager', 'stores_manager'] },
      { id: 'inventory.batch',        name: 'Batch Tracking',      page: 'BatchTracking',              permissions: ['super_admin', 'admin', 'manager', 'stores_manager'] },
      { id: 'inventory.stock',        name: 'Stock Summary',       page: 'StockSummary',               permissions: ['super_admin', 'admin', 'manager', 'stores_manager', 'production_head'] },
      { id: 'inventory.movements',    name: 'Stock Movements',     page: 'StockMovements',             permissions: ['super_admin', 'admin', 'manager', 'stores_manager'] },
      { id: 'inventory.material',     name: 'Material Consumption',page: 'MaterialConsumption',        permissions: ['super_admin', 'admin', 'manager', 'stores_manager', 'production_head'] },
      { id: 'inventory.reservations', name: 'Reservations',        page: 'StockReservations',          permissions: ['super_admin', 'admin', 'manager', 'stores_manager', 'production_head'] },
      { id: 'inventory.alerts',       name: 'Stock Alerts',        page: 'StockAlertsAndSuggestions',  permissions: ['super_admin', 'admin', 'manager', 'stores_manager'] },
      { id: 'inventory.warehouse',    name: 'Warehouse Management',page: 'WarehouseManagement',        permissions: ['super_admin', 'admin', 'manager', 'stores_manager'] },
      { id: 'inventory.intelligence', name: 'Inventory Analytics', page: 'InventoryIntelligence',      permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'inventory.advanced',     name: 'Advanced Dashboard',  page: 'AdvancedInventoryDashboard', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'inventory.report',       name: 'Inventory Reports',   page: 'InventoryReport',            permissions: ['super_admin', 'admin', 'manager', 'stores_manager'] },
      { id: 'inventory.costanalysis', name: 'Stores Cost Analysis',page: 'StoresCostAnalysis',         permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'inventory.pricing',      name: 'Component Pricing',   page: 'VendorPriceComparison',      permissions: ['super_admin', 'admin', 'manager', 'stores_manager'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Production
  // ─────────────────────────────────────────────────────────────
  {
    id: 'production',
    name: 'Production',
    icon: 'Factory',
    permissions: ['super_admin', 'admin', 'manager', 'production_head', 'production_engineer', 'supervisor', 'planner'],
    children: [
      { id: 'production.dashboard',    name: 'Dashboard',          page: 'ProductionDashboard',   permissions: ['super_admin', 'admin', 'manager', 'production_head', 'production_engineer', 'supervisor', 'planner'] },
      { id: 'production.orders',       name: 'Module Production Batches',  page: 'ProductionOrders',      permissions: ['super_admin', 'admin', 'manager', 'production_head', 'production_engineer', 'supervisor', 'planner'] },
      { id: 'production.imr',          name: 'Module Batch Requests', page: 'ProductionModuleRequests', permissions: ['super_admin', 'admin', 'manager', 'production_head', 'production_engineer', 'supervisor', 'planner'] },
      { id: 'production.shopfloor',    name: 'Shop Floor',         page: 'ShopFloor',             permissions: ['super_admin', 'admin', 'manager', 'production_head', 'production_engineer', 'supervisor'] },
      { id: 'production.bom',          name: 'BOM Builder',        page: 'BOMBuilder',            permissions: ['super_admin', 'admin', 'manager', 'production_head', 'production_engineer', 'planner'] },
      { id: 'production.bommodel',     name: 'BOM Modeling',       page: 'BOMModeling',           permissions: ['super_admin', 'admin', 'manager', 'production_head', 'production_engineer', 'planner'] },
      { id: 'production.mrp',          name: 'MRP Workbench',      page: 'MRPWorkbench',          permissions: ['super_admin', 'admin', 'manager', 'production_head', 'planner'] },
      { id: 'production.crp',          name: 'Capacity Planning (CRP)', page: 'CRPWorkbench',     permissions: ['super_admin', 'admin', 'manager', 'production_head', 'planner'] },
      { id: 'production.sop',          name: 'S&OP / RCCP',        page: 'SOPPlanning',           permissions: ['super_admin', 'admin', 'manager', 'production_head', 'planner'] },
      { id: 'production.subcontract',  name: 'Subcontracting',     page: 'SubcontractOrders',     permissions: ['super_admin', 'admin', 'manager', 'production_head', 'planner'] },
      { id: 'production.genealogy',    name: 'Batch Genealogy',    page: 'GenealogyTrace',        permissions: ['super_admin', 'admin', 'manager', 'production_head', 'production_engineer', 'planner'] },
      { id: 'production.capacity',     name: 'Work Centre Planning', page: 'WorkCentrePlanning',  permissions: ['super_admin', 'admin', 'manager', 'production_head', 'planner'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Projects
  // ─────────────────────────────────────────────────────────────
  {
    id: 'projects',
    name: 'Projects',
    icon: 'FolderKanban',
    permissions: ['super_admin', 'admin', 'manager'],
    children: [
      { id: 'projects.dashboard', name: 'Dashboard',       page: 'ProjectsDashboard', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'projects.list',      name: 'Projects',        page: 'Projects',          permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'projects.kanban',    name: 'Task Board',      page: 'KanbanBoard',       permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'projects.costing',   name: 'Project Costing',  page: 'ProjectCosting',         permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'projects.workflow',  name: 'Workflow Tracker', page: 'ProjectWorkflowTracker', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'projects.master',        name: 'Project Master',        page: 'ProductionDeliveryTracker', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'projects.pipeline',      name: 'Project Pipeline',      page: 'ProjectPipelineBoard',      permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'projects.installation',  name: 'Installation Dashboard',page: 'InstallationDashboard', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'projects.bom',           name: 'Upload BOM',            page: 'UploadBOM',             permissions: ['super_admin', 'admin', 'manager'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Operations
  // ─────────────────────────────────────────────────────────────
  {
    id: 'operations',
    name: 'Operations',
    icon: 'Settings2',
    permissions: ['super_admin', 'admin', 'manager'],
    children: [
      { id: 'operations.workflow',    name: 'Workflow Config', page: 'WorkflowConfiguration', permissions: ['super_admin', 'admin'] },
      { id: 'operations.tracker',     name: 'Project Tracker', page: 'ProjectWorkflowTracker', permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'operations.workload',    name: 'Dept Workload',   page: 'DepartmentWorkload',     permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'operations.bottlenecks', name: 'Bottlenecks',     page: 'BottleneckAnalytics',    permissions: ['super_admin', 'admin', 'manager'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Timesheets
  // ─────────────────────────────────────────────────────────────
  {
    id: 'timesheets',
    name: 'Timesheets',
    icon: 'Clock',
    permissions: ['super_admin', 'admin', 'manager', 'employee'],
    children: [
      { id: 'timesheets.my',            name: 'My Timesheet',          page: 'MyTimesheet',            permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'timesheets.all',           name: 'All Timesheets',        page: 'Timesheets',             permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'timesheets.approvals',     name: 'Timesheet Approvals',   page: 'TimesheetApprovals',     permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'timesheets.util',          name: 'Utilization Report',    page: 'UtilizationReport',      permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'timesheets.weekly-report', name: 'Weekly Report',         page: 'WeeklyProductionReport', permissions: ['super_admin', 'admin', 'manager'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Performance
  // ─────────────────────────────────────────────────────────────
  {
    id: 'performance',
    name: 'Performance',
    icon: 'Trophy',
    permissions: ['super_admin', 'admin', 'manager', 'employee'],
    children: [
      { id: 'performance.dashboard',   name: 'PMS Dashboard',     page: 'PerformanceDashboard',  permissions: ['super_admin', 'admin', 'hr'] },
      { id: 'performance.reviews',     name: 'My Reviews',         page: 'PerformanceReviews',    permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'performance.goals',       name: 'Goals & KPIs',       page: 'Goals',                 permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'performance.okr',         name: 'OKR Management',     page: 'OKRManagement',         permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'performance.kra',         name: 'KRA Framework',      page: 'KRAManagement',         permissions: ['super_admin', 'admin', 'hr'] },
      { id: 'performance.team',        name: 'Team Performance',   page: 'TeamPerformance',       permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'performance.cycles',      name: 'Review Cycles',      page: 'ReviewCycleManager',    permissions: ['super_admin', 'admin', 'hr'] },
      { id: 'performance.feedback360', name: '360° Feedback',      page: 'Feedback360',           permissions: ['super_admin', 'admin', 'manager', 'employee'] },
      { id: 'performance.calibration', name: 'Calibration Center', page: 'CalibrationCenter',     permissions: ['super_admin', 'admin', 'hr'] },
      { id: 'performance.increments',  name: 'Increment Planning', page: 'IncrementPlanning',     permissions: ['super_admin', 'admin', 'hr'] },
      { id: 'performance.promotions',  name: 'Promotion Planning', page: 'PromotionPlanning',     permissions: ['super_admin', 'admin', 'hr'] },
      { id: 'performance.reports',     name: 'PMS Reports',        page: 'PerformanceReports',    permissions: ['super_admin', 'admin', 'hr', 'manager'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Reports
  // ─────────────────────────────────────────────────────────────
  {
    id: 'reports',
    name: 'Reports',
    icon: 'FileText',
    permissions: ['super_admin', 'admin', 'manager'],
    children: [
      { id: 'reports.builder', name: 'Report Builder', page: 'Reports',      permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'reports.saved',   name: 'Saved Reports',  page: 'SavedReports', permissions: ['super_admin', 'admin', 'manager'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Analytics
  // ─────────────────────────────────────────────────────────────
  {
    id: 'analytics',
    name: 'Analytics',
    icon: 'LineChart',
    permissions: ['super_admin', 'admin'],
    children: [
      { id: 'analytics.ceo',  name: 'CEO Dashboard',  page: 'CeoDashboard',         permissions: ['super_admin', 'admin'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Standalone utility pages
  // ─────────────────────────────────────────────────────────────
  {
    id: 'notifications',
    name: 'Notifications',
    icon: 'Bell',
    page: 'NotificationCenter',
    permissions: ['super_admin', 'admin', 'manager', 'employee'],
  },
  {
    id: 'orgchart',
    name: 'Org Chart',
    icon: 'Network',
    page: 'OrgChart',
    permissions: ['super_admin', 'admin', 'manager', 'employee'],
  },
  {
    id: 'org_setup',
    name: 'Organization Setup',
    icon: 'Network',
    page: 'OrganizationSetup',
    permissions: ['super_admin', 'admin'],
  },
  {
    id: 'setup',
    name: 'Setup',
    icon: 'Zap',
    page: 'SetupWizard',
    permissions: ['super_admin'],
  },
  {
    id: 'setup_dashboard',
    name: 'Setup Dashboard',
    icon: 'Sparkles',
    page: 'SetupDashboard',
    permissions: ['super_admin'],
  },
  {
    id: 'audit',
    name: 'Audit Logs',
    icon: 'History',
    page: 'AuditLogs',
    permissions: ['super_admin', 'admin'],
  },
  {
    id: 'settings',
    name: 'Settings',
    icon: 'Settings',
    page: 'SettingsCenter',
    permissions: ['super_admin', 'admin'],
    children: [
      { id: 'settings.center',       name: 'Settings Center',   page: 'SettingsCenter',      permissions: ['super_admin', 'admin'] },
      { id: 'settings.workflow',     name: 'Workflow Builder',  page: 'WorkflowBuilder',     permissions: ['super_admin', 'admin'] },
      { id: 'settings.security',     name: 'Security Center',   page: 'SecurityCenter',      permissions: ['super_admin', 'admin'] },
      { id: 'settings.integrations', name: 'Integrations',      page: 'IntegrationsHub',     permissions: ['super_admin', 'admin'] },
      // Tally Integration (external sync bridge) hidden from menu — using in-app Tally-parity module instead. Code/route/table retained.
      { id: 'settings.zoho',         name: 'Zoho Sign',         page: 'ZohoSignIntegration', permissions: ['super_admin', 'admin'] },
      { id: 'settings.api',          name: 'API Docs',          page: 'APIDocumentation',    permissions: ['super_admin', 'admin'] },
      { id: 'settings.docsign',      name: 'Document Signing',  page: 'DocumentSigning',     permissions: ['super_admin', 'admin'] },
      { id: 'settings.mastersetup',  name: 'Master Setup',      page: 'MasterSetup',         permissions: ['super_admin', 'admin'] },
      { id: 'settings.assets',       name: 'Asset Maintenance', page: 'AssetMaintenance',    permissions: ['super_admin', 'admin'] },
      { id: 'settings.dbtest',       name: 'Database Test',     page: 'DatabaseTest',        permissions: ['super_admin', 'admin'] },
      // ── Module Config
      { id: 'settings.payroll',      name: 'Payroll Config',      page: 'PayrollSettings',      permissions: ['super_admin', 'admin'] },
      { id: 'settings.finance',      name: 'Finance Config',      page: 'FinanceSettings',      permissions: ['super_admin', 'admin'] },
      { id: 'settings.sales',        name: 'Sales Config',        page: 'SalesSettings',        permissions: ['super_admin', 'admin'] },
      { id: 'settings.inventory',    name: 'Inventory Config',    page: 'InventorySettings',    permissions: ['super_admin', 'admin'] },
      { id: 'settings.projects',     name: 'Projects Config',     page: 'ProjectSettings',      permissions: ['super_admin', 'admin'] },
      { id: 'settings.timesheets',   name: 'Timesheets Config',   page: 'TimesheetSettings',    permissions: ['super_admin', 'admin'] },
      { id: 'settings.servicedesk',  name: 'Service Desk Config', page: 'ServiceDeskSettings',  permissions: ['super_admin', 'admin'] },
      { id: 'settings.recruitment',  name: 'Recruitment Config',  page: 'RecruitmentSettings',  permissions: ['super_admin', 'admin'] },
      { id: 'settings.production',   name: 'Production Config',   page: 'ProductionSettings',   permissions: ['super_admin', 'admin'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Complaints
  // ─────────────────────────────────────────────────────────────
  // Retired 2026-07-17 (SERVICE_MASTER_IPCS_PLAN.md 3c): AllComplaints and
  // NewComplaint are gone — the IPCS register under Service Desk replaces both
  // (create is a drawer on the grid). `employee` was dropped earlier in the same
  // build: the API is gated on the `servicedesk` permission module, where
  // employee is can_view=false, so it would only have 403'd on click.
  //
  // The dashboard keeps a home here; the register is linked from Service Desk,
  // and ComplaintDetail stays a detail route (reached from the grid and from
  // ReviewFeedback), never a menu item.
  {
    id: 'complaints',
    name: 'Complaints',
    icon: 'MessageSquareWarning',
    permissions: ['super_admin', 'admin', 'manager'],
    children: [
      { id: 'complaints.dashboard', name: 'Dashboard',          page: 'ComplaintsDashboard',    permissions: ['super_admin', 'admin', 'manager'] },
      { id: 'complaints.register',  name: 'Complaint Register', page: 'CustomerComplaintsIPCS', permissions: ['super_admin', 'admin', 'manager'] },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // AI & Insights
  // ─────────────────────────────────────────────────────────────
  {
    id: 'ai_insights',
    name: 'AI & Insights',
    icon: 'Sparkles',
    permissions: ['super_admin', 'admin', 'manager', 'employee'],
    children: [
      {
        id: 'ai.intelligence',
        name: 'ERP Intelligence',
        icon: 'Brain',
        page: 'ERPIntelligence',
        permissions: ['super_admin', 'admin', 'manager', 'employee'],
      },
    ],
  },
];
