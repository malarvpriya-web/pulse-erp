/**
 * Complete Pulse ERP route manifest.
 * Derived from src/config/routes.jsx NAV_ITEMS — single source of truth.
 *
 * severity:
 *   P0 — mission-critical; failure blocks go-live
 *   P1 — important; visible to end users daily
 *   P2 — secondary / settings / edge pages
 */

export type Severity = 'P0' | 'P1' | 'P2';

export interface RouteConfig {
  name: string;
  path: string;
  module: string;
  severity: Severity;
  skipSmoke?: boolean;   // wizard / portal flows requiring extra setup
}

export const ALL_ROUTES: RouteConfig[] = [
  // ── Core ─────────────────────────────────────────────────────────────────
  { name: 'Home',                     path: '/',                            module: 'core',        severity: 'P0' },
  { name: 'Approvals',                path: '/ApprovalCenter',              module: 'core',        severity: 'P0' },
  { name: 'Notifications',            path: '/NotificationCenter',          module: 'core',        severity: 'P0' },
  { name: 'Org Chart',                path: '/OrgChart',                    module: 'core',        severity: 'P1' },
  { name: 'Audit Logs',               path: '/AuditLogs',                   module: 'core',        severity: 'P1' },

  // ── Analytics & AI ───────────────────────────────────────────────────────
  { name: 'CEO Intelligence',         path: '/CEOIntelligenceDashboard',    module: 'analytics',   severity: 'P0' },
  { name: 'CEO Dashboard',            path: '/CeoDashboard',                module: 'analytics',   severity: 'P0' },
  { name: 'Executive Dashboard',      path: '/ExecutiveDashboard',          module: 'analytics',   severity: 'P0' },
  { name: 'HR Dashboard',             path: '/HRDashboard',                 module: 'analytics',   severity: 'P0' },
  { name: 'Admin Dashboard',          path: '/AdminDashboard',              module: 'analytics',   severity: 'P0' },
  { name: 'ERP Intelligence',         path: '/ERPIntelligence',             module: 'analytics',   severity: 'P1' },
  { name: 'System Health',            path: '/SystemHealth',                module: 'analytics',   severity: 'P1' },

  // ── Employees ────────────────────────────────────────────────────────────
  { name: 'Employees Dashboard',      path: '/EmployeesDashboard',          module: 'employees',   severity: 'P0' },
  { name: 'All Employees',            path: '/EmployeesData',               module: 'employees',   severity: 'P0' },
  { name: 'Ex-Employees',            path: '/ExEmployees',                 module: 'employees',   severity: 'P1' },

  // ── HR ────────────────────────────────────────────────────────────────────
  { name: 'Announcements',            path: '/Announcements',               module: 'hr',          severity: 'P1' },
  { name: 'Payroll Center',           path: '/PayrollCenter',               module: 'hr',          severity: 'P0' },
  { name: 'Probation',                path: '/Probation',                   module: 'hr',          severity: 'P2' },
  { name: 'Policies',                 path: '/Policies',                    module: 'hr',          severity: 'P2' },
  { name: 'HR Documents',             path: '/Downloads',                   module: 'hr',          severity: 'P2' },
  { name: 'Offboarding',              path: '/Offboarding',                 module: 'hr',          severity: 'P1' },
  { name: 'Exit Management',          path: '/ExitManagement',              module: 'hr',          severity: 'P1' },
  { name: 'Employee Directory',       path: '/EmployeeDirectory',           module: 'hr',          severity: 'P1' },
  { name: 'Employee Documents',       path: '/EmployeeDocuments',           module: 'hr',          severity: 'P1' },
  { name: 'Employee Self Service',    path: '/EmployeeSelfService',         module: 'hr',          severity: 'P1' },
  { name: 'Succession Center',        path: '/SuccessionCenter',            module: 'hr',          severity: 'P1' },
  { name: 'Skill Matrix',             path: '/SkillMatrix',                 module: 'hr',          severity: 'P1' },
  { name: 'Employee Reports',         path: '/EmployeeReports',             module: 'hr',          severity: 'P1' },
  { name: 'Employee Assets',          path: '/EmployeeAssets',              module: 'hr',          severity: 'P1' },
  { name: 'HR Analytics',             path: '/HRAnalyticsDashboard',        module: 'hr',          severity: 'P1' },

  // ── Learning Center ──────────────────────────────────────────────────────
  { name: 'L&D Dashboard',            path: '/LearningDashboard',           module: 'lnd',         severity: 'P1' },
  { name: 'Training Calendar',        path: '/LearningDevelopment',         module: 'lnd',         severity: 'P1' },
  { name: 'Learning Paths',           path: '/LearningPaths',               module: 'lnd',         severity: 'P1' },
  { name: 'Assessments',              path: '/AssessmentCenter',            module: 'lnd',         severity: 'P1' },
  { name: 'Certifications',           path: '/CertificationManagement',     module: 'lnd',         severity: 'P1' },
  { name: 'Competency Framework',     path: '/CompetencyFramework',         module: 'lnd',         severity: 'P2' },
  { name: 'Trainer Management',       path: '/TrainerManagement',           module: 'lnd',         severity: 'P2' },
  { name: 'Training Reports',         path: '/TrainingReports',             module: 'lnd',         severity: 'P2' },
  { name: 'LND Settings',             path: '/LNDSettings',                 module: 'lnd',         severity: 'P2' },

  // ── Attendance ───────────────────────────────────────────────────────────
  { name: 'Live Workforce',           path: '/LiveWorkforceDashboard',      module: 'attendance',  severity: 'P0' },
  { name: 'My Attendance',            path: '/AttendanceDashboard',         module: 'attendance',  severity: 'P0' },
  { name: 'QR Attendance',            path: '/QRAttendance',                module: 'attendance',  severity: 'P1' },
  { name: 'Team Attendance',          path: '/TeamAttendance',              module: 'attendance',  severity: 'P1' },
  { name: 'Shift Calendar',           path: '/ShiftCalendar',               module: 'attendance',  severity: 'P1' },
  { name: 'Regularization',           path: '/RegularizationApprovals',     module: 'attendance',  severity: 'P1' },
  { name: 'Overtime',                 path: '/OvertimeApprovals',           module: 'attendance',  severity: 'P1' },
  { name: 'Approval Delegation',      path: '/ApprovalDelegation',          module: 'attendance',  severity: 'P2' },
  { name: 'Attendance Reports Hub',   path: '/AttendanceReportsHub',        module: 'attendance',  severity: 'P1' },
  { name: 'Work Centres',             path: '/WorkCentres',                 module: 'attendance',  severity: 'P2' },
  { name: 'Contract Labour',          path: '/ContractLabour',              module: 'attendance',  severity: 'P2' },
  { name: 'Payroll Sync',             path: '/PayrollSync',                 module: 'attendance',  severity: 'P1' },
  { name: 'Attendance Settings',      path: '/AttendanceSettings',          module: 'attendance',  severity: 'P2' },
  { name: 'Attendance Audit Logs',    path: '/AttendanceAuditLogs',         module: 'attendance',  severity: 'P2' },

  // ── Leaves ───────────────────────────────────────────────────────────────
  { name: 'My Leaves',                path: '/MyLeaves',                    module: 'leaves',      severity: 'P0' },
  { name: 'Apply Leave',              path: '/ApplyLeave',                  module: 'leaves',      severity: 'P0' },
  { name: 'Leave Approvals',          path: '/LeaveApprovals',              module: 'leaves',      severity: 'P0' },
  { name: 'Team Leaves',              path: '/TeamLeaves',                  module: 'leaves',      severity: 'P1' },
  { name: 'Leave Calendar',           path: '/LeaveCalendar',               module: 'leaves',      severity: 'P1' },
  { name: 'Holiday Calendar',         path: '/HolidayCalendar',             module: 'leaves',      severity: 'P1' },
  { name: 'Comp Off',                 path: '/CompOff',                     module: 'leaves',      severity: 'P1' },
  { name: 'All Leaves',               path: '/AllLeaves',                   module: 'leaves',      severity: 'P1' },
  { name: 'Leave Reports',            path: '/LeaveReports',                module: 'leaves',      severity: 'P1' },
  { name: 'Leave Encashment',         path: '/LeaveEncashment',             module: 'leaves',      severity: 'P2' },
  { name: 'Leave Settings',           path: '/LeaveSettings',               module: 'leaves',      severity: 'P2' },

  // ── Finance ──────────────────────────────────────────────────────────────
  { name: 'Finance Dashboard',        path: '/FinanceDashboardNew',         module: 'finance',     severity: 'P0' },
  { name: 'Accounting Engine',        path: '/AccountingEngine',            module: 'finance',     severity: 'P0' },
  { name: 'Receivables',              path: '/ReceivablesPage',             module: 'finance',     severity: 'P0' },
  { name: 'Payables',                 path: '/PayablesPage',                module: 'finance',     severity: 'P0' },
  { name: 'Payments',                 path: '/PaymentBatch',                module: 'finance',     severity: 'P0' },
  { name: 'Tax & Compliance',         path: '/TaxManagement',               module: 'finance',     severity: 'P0' },
  { name: 'Budget Management',        path: '/BudgetManagement',            module: 'finance',     severity: 'P1' },
  { name: 'Fixed Assets',             path: '/FixedAssets',                 module: 'finance',     severity: 'P1' },
  { name: 'Financial Reports',        path: '/FinanceReports',              module: 'finance',     severity: 'P1' },
  { name: 'Customers & Suppliers',    path: '/Parties',                     module: 'finance',     severity: 'P1' },
  { name: 'Finance Settings',         path: '/FinanceSettings',             module: 'finance',     severity: 'P2' },

  // ── Recruitment ──────────────────────────────────────────────────────────
  { name: 'Recruitment Dashboard',    path: '/RecruitmentDashboard',        module: 'recruitment', severity: 'P0' },
  { name: 'Job Requisitions',         path: '/JobRequisitionPipeline',      module: 'recruitment', severity: 'P1' },
  { name: 'Job Openings',             path: '/JobOpenings',                 module: 'recruitment', severity: 'P1' },
  { name: 'All Candidates',           path: '/AllCandidates',               module: 'recruitment', severity: 'P1' },
  { name: 'Candidate Pipeline',       path: '/CandidatePipeline',           module: 'recruitment', severity: 'P1' },
  { name: 'Interview Scheduler',      path: '/InterviewScheduler',          module: 'recruitment', severity: 'P1' },
  { name: 'Offer Management',         path: '/OfferManagement',             module: 'recruitment', severity: 'P1' },
  { name: 'Onboarding',               path: '/OnboardingChecklist',         module: 'recruitment', severity: 'P1' },
  { name: 'Email Templates',          path: '/EmailTemplates',              module: 'recruitment', severity: 'P2' },
  { name: 'Hiring Forecasts',         path: '/HiringForecasts',             module: 'recruitment', severity: 'P2' },
  { name: 'Employee Auto-Creation',   path: '/EmployeeAutoCreation',        module: 'recruitment', severity: 'P1' },
  { name: 'Recruitment Settings',     path: '/RecruitmentSettings',         module: 'recruitment', severity: 'P2' },

  // ── Talent ───────────────────────────────────────────────────────────────
  { name: 'Resume Database',          path: '/ResumeDatabase',              module: 'talent',      severity: 'P1' },
  { name: 'Talent Pools',             path: '/TalentPools',                 module: 'talent',      severity: 'P1' },
  { name: 'Question Bank',            path: '/InterviewQuestionBank',       module: 'talent',      severity: 'P2' },
  { name: 'Agencies',                 path: '/RecruitmentAgencies',         module: 'talent',      severity: 'P2' },
  { name: 'Recruiter Dashboard',      path: '/RecruiterDashboard',          module: 'talent',      severity: 'P1' },

  // ── CRM ──────────────────────────────────────────────────────────────────
  { name: 'CRM Dashboard',            path: '/SalesDashboard',              module: 'crm',         severity: 'P0' },
  { name: 'Leads',                    path: '/Leads',                       module: 'crm',         severity: 'P0' },
  { name: 'Accounts',                 path: '/Accounts',                    module: 'crm',         severity: 'P0' },
  { name: 'Contacts',                 path: '/Contacts',                    module: 'crm',         severity: 'P1' },
  { name: 'Opportunities',            path: '/OpportunitiesKanban',         module: 'crm',         severity: 'P0' },
  { name: 'CRM Email',                path: '/CRMEmail',                    module: 'crm',         severity: 'P1' },
  { name: 'Customer 360',             path: '/Customer360',                 module: 'crm',         severity: 'P1' },
  { name: 'Customer Health',          path: '/CustomerHealthDashboard',     module: 'crm',         severity: 'P1' },
  { name: 'CRM Activities',           path: '/CRMActivities',               module: 'crm',         severity: 'P1' },
  { name: 'CRM Reports',              path: '/CRMReports',                  module: 'crm',         severity: 'P1' },
  { name: 'Pipeline Automation',      path: '/PipelineAutomation',          module: 'crm',         severity: 'P2' },
  { name: 'CRM Settings',             path: '/CRMSettings',                 module: 'crm',         severity: 'P2' },

  // ── Sales ─────────────────────────────────────────────────────────────────
  { name: 'Sales Command Center',     path: '/SalesCommandCenter',          module: 'sales',       severity: 'P0' },
  { name: 'Quotations',               path: '/Quotations',                  module: 'sales',       severity: 'P0' },
  { name: 'Sales Orders',             path: '/SalesOrders',                 module: 'sales',       severity: 'P0' },
  { name: 'Sales Targets',            path: '/SalesTargets',                module: 'sales',       severity: 'P1' },
  { name: 'Sales Intelligence',       path: '/SalesIntelligence',           module: 'sales',       severity: 'P1' },
  { name: 'Pricing Engine',           path: '/PricingEngine',               module: 'sales',       severity: 'P1' },
  { name: 'Commission',               path: '/CommissionManagement',        module: 'sales',       severity: 'P1' },
  { name: 'Fulfilment',               path: '/FulfilmentTracking',          module: 'sales',       severity: 'P1' },
  { name: 'Sales Playbooks',          path: '/SalesPlaybooks',              module: 'sales',       severity: 'P2' },
  { name: 'Sales Calendar',           path: '/SalesCalendar',               module: 'sales',       severity: 'P2' },
  { name: 'Sales Documents',          path: '/SalesDocuments',              module: 'sales',       severity: 'P2' },
  { name: 'Subscriptions',            path: '/Subscriptions',               module: 'sales',       severity: 'P2' },
  { name: 'Sales Market',             path: '/SalesMarket',                 module: 'sales',       severity: 'P2' },
  { name: 'Sales Settings',           path: '/SalesSettings',               module: 'sales',       severity: 'P2' },

  // ── Marketing ────────────────────────────────────────────────────────────
  { name: 'Marketing Dashboard',      path: '/MarketingDashboard',          module: 'marketing',   severity: 'P1' },
  { name: 'Campaigns',                path: '/Campaigns',                   module: 'marketing',   severity: 'P1' },
  { name: 'Marketing Analytics',      path: '/MarketingAnalytics',          module: 'marketing',   severity: 'P1' },
  { name: 'Assign Tasks',             path: '/AssignTasks',                 module: 'marketing',   severity: 'P2' },
  { name: 'Delivery Tracker',         path: '/DeliveryTracker',             module: 'marketing',   severity: 'P2' },
  { name: 'Pursuit List',             path: '/PursuitList',                 module: 'marketing',   severity: 'P2' },
  { name: 'Marketing Settings',       path: '/MarketingSettings',           module: 'marketing',   severity: 'P2' },

  // ── Procurement ──────────────────────────────────────────────────────────
  { name: 'Purchase Requests',        path: '/PurchaseRequestDashboard',    module: 'procurement', severity: 'P0' },
  { name: 'PO Management',            path: '/PurchaseOrderManagement',     module: 'procurement', severity: 'P0' },
  { name: 'Purchase Orders',          path: '/PurchaseOrders',              module: 'procurement', severity: 'P0' },
  { name: 'Goods Receipt',            path: '/GoodsReceipt',                module: 'procurement', severity: 'P0' },
  { name: 'Vendor Center',            path: '/VendorCenter',                module: 'procurement', severity: 'P0' },
  { name: 'Vendor 360',               path: '/Vendor360',                   module: 'procurement', severity: 'P1' },
  { name: 'MRP Planning',             path: '/MRPPlanning',                 module: 'procurement', severity: 'P1' },
  { name: 'Quality Inspection',       path: '/QualityInspection',           module: 'procurement', severity: 'P1' },
  { name: 'Procurement Reports',      path: '/ProcurementReports',          module: 'procurement', severity: 'P1' },
  { name: 'Vendor Dashboard',         path: '/VendorDashboard',             module: 'procurement', severity: 'P1' },
  { name: 'Vendor Approval Queue',    path: '/VendorApprovalQueue',         module: 'procurement', severity: 'P1' },
  { name: 'Vendor Risk Dashboard',    path: '/VendorRiskDashboard',         module: 'procurement', severity: 'P1' },
  { name: 'Procurement Settings',     path: '/ProcurementSettings',         module: 'procurement', severity: 'P2' },

  // ── Inventory ────────────────────────────────────────────────────────────
  { name: 'Inventory Dashboard',      path: '/InventoryDashboard',          module: 'inventory',   severity: 'P0' },
  { name: 'Advanced Dashboard',       path: '/AdvancedInventoryDashboard',  module: 'inventory',   severity: 'P1' },
  { name: 'Item Master',              path: '/ItemMaster',                  module: 'inventory',   severity: 'P0' },
  { name: 'Stock Summary',            path: '/StockSummary',                module: 'inventory',   severity: 'P0' },
  { name: 'Stock Movements',          path: '/StockMovements',              module: 'inventory',   severity: 'P1' },
  { name: 'Batch Tracking',           path: '/BatchTracking',               module: 'inventory',   severity: 'P1' },
  { name: 'Stock Alerts',             path: '/StockAlertsAndSuggestions',   module: 'inventory',   severity: 'P1' },
  { name: 'Stock Reservations',       path: '/StockReservations',           module: 'inventory',   severity: 'P1' },
  { name: 'Material Consumption',     path: '/MaterialConsumption',         module: 'inventory',   severity: 'P1' },
  { name: 'Inventory Intelligence',   path: '/InventoryIntelligence',       module: 'inventory',   severity: 'P1' },
  { name: 'Inventory Report',         path: '/InventoryReport',             module: 'inventory',   severity: 'P1' },
  { name: 'Warehouse Management',     path: '/WarehouseManagement',         module: 'inventory',   severity: 'P1' },
  { name: 'Stores Dashboard',         path: '/StoresDashboard',             module: 'inventory',   severity: 'P2' },
  { name: 'Inventory Settings',       path: '/InventorySettings',           module: 'inventory',   severity: 'P2' },

  // ── Production ───────────────────────────────────────────────────────────
  { name: 'Production Dashboard',     path: '/ProductionDashboard',         module: 'production',  severity: 'P0' },
  { name: 'Production Orders',        path: '/ProductionOrders',            module: 'production',  severity: 'P0' },
  { name: 'BOM Builder',              path: '/BOMBuilder',                  module: 'production',  severity: 'P0' },
  { name: 'Work Centre Planning',     path: '/WorkCentrePlanning',          module: 'production',  severity: 'P1' },
  { name: 'Upload BOM',               path: '/UploadBOM',                   module: 'production',  severity: 'P2' },
  { name: 'Production Settings',      path: '/ProductionSettings',          module: 'production',  severity: 'P2' },

  // ── Quality ──────────────────────────────────────────────────────────────
  { name: 'Quality Dashboard',        path: '/QualityDashboard',            module: 'quality',     severity: 'P0' },
  { name: 'NCR Management',           path: '/NCRManagement',               module: 'quality',     severity: 'P0' },
  { name: 'CAPA Management',          path: '/CAPAManagement',              module: 'quality',     severity: 'P1' },
  { name: 'Inspection Center',        path: '/InspectionCenter',            module: 'quality',     severity: 'P1' },
  { name: 'FAT / SAT',                path: '/FATManagement',               module: 'quality',     severity: 'P1' },
  { name: 'Equipment Calibration',    path: '/EquipmentCalibration',        module: 'quality',     severity: 'P1' },
  { name: 'Supplier Quality',         path: '/SupplierQuality',             module: 'quality',     severity: 'P1' },
  { name: 'Quality Reports',          path: '/QualityReports',              module: 'quality',     severity: 'P1' },
  { name: 'Quality Settings',         path: '/QualitySettings',             module: 'quality',     severity: 'P2' },

  // ── Engineering ──────────────────────────────────────────────────────────
  { name: 'Engineering Dashboard',    path: '/EngineeringDashboard',        module: 'engineering', severity: 'P0' },
  { name: 'Power Quality',            path: '/PowerQualityAnalytics',       module: 'engineering', severity: 'P1' },
  { name: 'R&D Projects',             path: '/RDProjects',                  module: 'engineering', severity: 'P1' },
  { name: 'Design Phases',            path: '/DesignPhases',                module: 'engineering', severity: 'P1' },
  { name: 'Prototype Tracker',        path: '/PrototypeTracker',            module: 'engineering', severity: 'P2' },
  { name: 'Test Plans',               path: '/TestPlans',                   module: 'engineering', severity: 'P2' },

  // ── Projects ─────────────────────────────────────────────────────────────
  { name: 'Projects Dashboard',       path: '/ProjectsDashboard',           module: 'projects',    severity: 'P0' },
  { name: 'Projects',                 path: '/Projects',                    module: 'projects',    severity: 'P0' },
  { name: 'Project Master',           path: '/ProjectMaster',               module: 'projects',    severity: 'P1' },
  { name: 'Task Board',               path: '/KanbanBoard',                 module: 'projects',    severity: 'P1' },
  { name: 'Gantt Chart',              path: '/GanttChart',                  module: 'projects',    severity: 'P1' },
  { name: 'Resource Management',      path: '/ResourceManagement',          module: 'projects',    severity: 'P1' },
  { name: 'Project Financials Hub',   path: '/ProjectFinancialsHub',        module: 'projects',    severity: 'P1' },
  { name: 'CEO Command Center',       path: '/CEOCommandCenter',            module: 'projects',    severity: 'P1' },
  { name: 'Project 360',              path: '/Project360',                  module: 'projects',    severity: 'P1' },
  { name: 'Issue Management',         path: '/IssueManagement',             module: 'projects',    severity: 'P1' },
  { name: 'Project Lifecycle Hub',    path: '/ProjectLifecycleHub',         module: 'projects',    severity: 'P1' },
  { name: 'Project Reports',          path: '/ProjectReports',              module: 'projects',    severity: 'P1' },
  { name: 'Project Settings',         path: '/ProjectSettings',             module: 'projects',    severity: 'P2' },

  // ── Operations ───────────────────────────────────────────────────────────
  { name: 'Workflow Center',          path: '/WorkflowCenter',              module: 'operations',  severity: 'P1' },
  { name: 'Project Tracker',          path: '/ProjectWorkflowTracker',      module: 'operations',  severity: 'P1' },
  { name: 'Department Workload',      path: '/DepartmentWorkload',          module: 'operations',  severity: 'P1' },
  { name: 'Bottleneck Analytics',     path: '/BottleneckAnalytics',         module: 'operations',  severity: 'P2' },
  { name: 'Lifecycle Tracker',        path: '/LifecycleTracker',            module: 'operations',  severity: 'P1' },
  { name: 'Post-Delivery Hub',        path: '/OperationsLifecycleHub',      module: 'operations',  severity: 'P2' },

  // ── Timesheets ───────────────────────────────────────────────────────────
  { name: 'My Timesheet',             path: '/MyTimesheet',                 module: 'timesheets',  severity: 'P0' },
  { name: 'All Timesheets',           path: '/Timesheets',                  module: 'timesheets',  severity: 'P1' },
  { name: 'Timesheet Approvals',      path: '/TimesheetApprovals',          module: 'timesheets',  severity: 'P1' },
  { name: 'Utilization Report',       path: '/UtilizationReport',           module: 'timesheets',  severity: 'P1' },
  { name: 'Weekly Production Report', path: '/WeeklyProductionReport',      module: 'timesheets',  severity: 'P2' },
  { name: 'Timesheet Settings',       path: '/TimesheetSettings',           module: 'timesheets',  severity: 'P2' },

  // ── Performance ──────────────────────────────────────────────────────────
  { name: 'Performance Reviews',      path: '/PerformanceReviews',          module: 'performance', severity: 'P1' },
  { name: 'Goals & KPIs',             path: '/Goals',                       module: 'performance', severity: 'P1' },
  { name: 'Team Performance',         path: '/TeamPerformance',             module: 'performance', severity: 'P1' },
  { name: 'Performance Settings',     path: '/PerformanceSettings',         module: 'performance', severity: 'P2' },

  // ── Complaints ───────────────────────────────────────────────────────────
  { name: 'Complaints Dashboard',     path: '/ComplaintsDashboard',         module: 'complaints',  severity: 'P1' },
  { name: 'All Complaints',           path: '/AllComplaints',               module: 'complaints',  severity: 'P1' },
  { name: 'New Complaint',            path: '/NewComplaint',                module: 'complaints',  severity: 'P1' },

  // ── Service Desk ─────────────────────────────────────────────────────────
  { name: 'Support Dashboard',        path: '/SupportDashboard',            module: 'servicedesk', severity: 'P0' },
  { name: 'All Tickets',              path: '/AllTickets',                  module: 'servicedesk', severity: 'P0' },
  { name: 'My Tickets',               path: '/MyTickets',                   module: 'servicedesk', severity: 'P0' },
  { name: 'SLA Management',           path: '/SLAManagement',               module: 'servicedesk', severity: 'P1' },
  { name: 'Field Service',            path: '/FieldVisitScheduler',         module: 'servicedesk', severity: 'P1' },
  { name: 'Service Engineers',        path: '/ServiceEngineers',            module: 'servicedesk', severity: 'P1' },
  { name: 'Knowledge Base',           path: '/KnowledgeBase',               module: 'servicedesk', severity: 'P1' },
  { name: 'Service Contracts',        path: '/ServiceContracts',            module: 'servicedesk', severity: 'P1' },
  { name: 'Service Warranty',         path: '/OperationsWarranty',          module: 'servicedesk', severity: 'P1' },
  { name: 'Spare Parts Stock',        path: '/ServiceStockManagement',      module: 'servicedesk', severity: 'P1' },
  { name: 'Agent Workload',           path: '/AgentWorkload',               module: 'servicedesk', severity: 'P2' },
  { name: 'Delivery Note',            path: '/DeliveryNote',                module: 'servicedesk', severity: 'P2' },
  { name: 'Service Reviews',          path: '/ServiceReviews',              module: 'servicedesk', severity: 'P2' },
  { name: 'Service Master',           path: '/ServiceMaster',               module: 'servicedesk', severity: 'P2' },
  { name: 'Customer Portal Mgmt',     path: '/CustomerPortalManagement',    module: 'servicedesk', severity: 'P1' },
  { name: 'Commissioning',            path: '/CommissioningWorkflow',       module: 'servicedesk', severity: 'P1' },
  { name: 'Service Intelligence',     path: '/ServiceIntelligence',         module: 'servicedesk', severity: 'P1' },
  { name: 'Service Desk Settings',    path: '/ServiceDeskSettings',         module: 'servicedesk', severity: 'P2' },

  // ── Travel Desk ──────────────────────────────────────────────────────────
  { name: 'Travel Dashboard',         path: '/TravelDashboard',             module: 'travel',      severity: 'P0' },
  { name: 'Travel Requests',          path: '/TravelRequests',              module: 'travel',      severity: 'P0' },
  { name: 'Expense Claims',           path: '/ExpenseClaims',               module: 'travel',      severity: 'P0' },
  { name: 'Visit Reports',            path: '/VisitReports',                module: 'travel',      severity: 'P1' },
  { name: 'Customer Visits',          path: '/CustomerVisits',              module: 'travel',      severity: 'P1' },
  { name: 'Travel Approvals',         path: '/TravelApprovals',             module: 'travel',      severity: 'P1' },
  { name: 'Expense Review',           path: '/ExpenseReview',               module: 'travel',      severity: 'P1' },
  { name: 'Travel Calendar',          path: '/TravelCalendar',              module: 'travel',      severity: 'P2' },
  { name: 'Travel Advances',          path: '/TravelAdvances',              module: 'travel',      severity: 'P2' },
  { name: 'Travel Bookings',          path: '/TravelBookings',              module: 'travel',      severity: 'P2' },
  { name: 'Travel Policy Engine',     path: '/TravelPolicyEngine',          module: 'travel',      severity: 'P2' },
  { name: 'Travel Reports',           path: '/TravelReports',               module: 'travel',      severity: 'P2' },
  { name: 'Travel Command Center',    path: '/TravelCommandCenter',         module: 'travel',      severity: 'P1' },
  { name: 'Travel Analytics',         path: '/TravelAnalytics',             module: 'travel',      severity: 'P1' },

  // ── Reports ──────────────────────────────────────────────────────────────
  { name: 'Report Builder',           path: '/Reports',                     module: 'reports',     severity: 'P1' },
  { name: 'Saved Reports',            path: '/SavedReports',                module: 'reports',     severity: 'P2' },

  // ── Settings ─────────────────────────────────────────────────────────────
  { name: 'Settings Center',          path: '/SettingsCenter',              module: 'settings',    severity: 'P1' },
  { name: 'User Preferences',         path: '/UserPreferences',             module: 'settings',    severity: 'P2' },
  { name: 'Setup Center',             path: '/SetupCenter',                 module: 'settings',    severity: 'P2' },
  { name: 'Company Profile',          path: '/CompanyProfile',              module: 'settings',    severity: 'P1' },
  { name: 'Branch Management',        path: '/BranchManagement',            module: 'settings',    severity: 'P1' },
  { name: 'Access Control',           path: '/AccessControl',               module: 'settings',    severity: 'P1' },
  { name: 'Workflow Builder',         path: '/WorkflowBuilder',             module: 'settings',    severity: 'P2' },
  { name: 'Integrations Hub',         path: '/IntegrationsHub',             module: 'settings',    severity: 'P2' },
  { name: 'API Documentation',        path: '/APIDocumentation',            module: 'settings',    severity: 'P2' },
  { name: 'System Settings',          path: '/SystemSettings',              module: 'settings',    severity: 'P2' },
  { name: 'Document Setup',           path: '/DocumentSetup',               module: 'settings',    severity: 'P2' },
  { name: 'Document Signing',         path: '/DocumentSigning',             module: 'settings',    severity: 'P2' },
  { name: 'Product Setup',            path: '/ProductSetup',                module: 'settings',    severity: 'P2' },
  { name: 'Master Setup',             path: '/MasterSetup',                 module: 'settings',    severity: 'P2' },
  { name: 'Order Policy',             path: '/OrderPolicy',                 module: 'settings',    severity: 'P2' },
  { name: 'Asset Maintenance',        path: '/AssetMaintenance',            module: 'settings',    severity: 'P2' },
  { name: 'Setup Notifications',      path: '/SetupNotifications',          module: 'settings',    severity: 'P2' },
  { name: 'Org Setup',                path: '/OrganizationSetup',           module: 'settings',    severity: 'P2' },
  { name: 'Roles Setup',              path: '/RolesSetup',                  module: 'settings',    severity: 'P2' },
];

/** Routes filtered by severity for targeted test runs */
export function routesBySeverity(sev: Severity): RouteConfig[] {
  return ALL_ROUTES.filter(r => r.severity === sev && !r.skipSmoke);
}

/** Routes for a specific ERP module */
export function routesByModule(module: string): RouteConfig[] {
  return ALL_ROUTES.filter(r => r.module === module && !r.skipSmoke);
}

/** All routes available for smoke testing */
export const SMOKE_ROUTES = ALL_ROUTES.filter(r => !r.skipSmoke);
