import { lazy } from 'react';

export const ROUTES = {
  // ── Core pages ────────────────────────────────────────────────────────────
  Home:                  { component: lazy(() => import('@/pages/Home')),                props: ctx => ({ setPage: ctx.setPage }) },
  AdminDashboard:        { component: lazy(() => import('@/pages/AdminDashboard')),      props: ctx => ({ setPage: ctx.setPage }) },
  EmployeeDashboard:     { component: lazy(() => import('@/pages/EmployeeDashboard')),   props: ctx => ({ setPage: ctx.setPage }) },
  MyAnalytics:           { component: lazy(() => import('@/pages/MyAnalytics')),         props: ctx => ({ setPage: ctx.setPage }) },
  ExecutiveDashboard:    { component: lazy(() => import('@/pages/ExecutiveDashboard')),  props: ctx => ({ setPage: ctx.setPage }) },
  HRDashboard:           { component: lazy(() => import('@/pages/HRDashboard')),         props: ctx => ({ setPage: ctx.setPage }) },
  Unauthorized:          { component: lazy(() => import('@/pages/Unauthorized')),         props: ctx => ({ setPage: ctx.setPage }) },

  // ── Account / Profile ─────────────────────────────────────────────────────
  ProfileSettings:  { component: lazy(() => import('@/features/account/pages/ProfileSettings')) },
  UserPreferences:  { component: lazy(() => import('@/features/account/pages/UserPreferences')) },

  // ── Admin ─────────────────────────────────────────────────────────────────
  // Hub pages — merged submenus
  AccessControl:            { component: lazy(() => import('@/features/admin/pages/AccessControl')),            props: ctx => ({ setPage: ctx.setPage }) },
  SetupCenter:              { component: lazy(() => import('@/features/admin/pages/SetupCenter')),              props: ctx => ({ setPage: ctx.setPage }) },

  // Phase 35 — Enterprise Productization
  SystemSettings:           { component: lazy(() => import('@/features/admin/pages/SystemSettings')) },
  AttendanceSetupWizard:    { component: lazy(() => import('@/features/admin/pages/AttendanceSetupWizard')), props: ctx => ({ setPage: ctx.setPage }) },
  InventorySetupWizard:     { component: lazy(() => import('@/features/admin/pages/InventorySetupWizard')), props: ctx => ({ setPage: ctx.setPage }) },
  EngineeringSetupWizard:   { component: lazy(() => import('@/features/admin/pages/EngineeringSetupWizard')), props: ctx => ({ setPage: ctx.setPage }) },
  PayrollSetupWizard:       { component: lazy(() => import('@/features/admin/pages/PayrollSetupWizard')),    props: ctx => ({ setPage: ctx.setPage }) },
  APIDocumentation:      { component: lazy(() => import('@/features/admin/pages/APIDocumentation')) },
  ApproverSetup:         { component: lazy(() => import('@/features/admin/pages/ApproverSetup')), props: ctx => ({ setPage: ctx.setPage }) },
  AssetMaintenance:      { component: lazy(() => import('@/features/admin/pages/AssetMaintenance')) },
  DatabaseTest:          { component: lazy(() => import('@/features/admin/pages/DatabaseTest')) },
  DocumentSetup:         { component: lazy(() => import('@/features/admin/pages/DocumentSetup')) },
  IntegrationsHub:       { component: lazy(() => import('@/features/admin/pages/IntegrationsHub')), props: ctx => ({ setPage: ctx.setPage }) },
  OrderPolicy:           { component: lazy(() => import('@/features/admin/pages/OrderPolicy')) },
  ProductSetup:          { component: lazy(() => import('@/features/admin/pages/ProductSetup')) },
  RolesSetup:            { component: lazy(() => import('@/features/admin/pages/RolesSetup')) },
  SecurityCenter:        { component: lazy(() => import('@/features/admin/pages/SecurityCenter')) },
  SettingsCenter:        { component: lazy(() => import('@/features/admin/pages/SettingsCenter')), props: ctx => ({ setPage: ctx.setPage }) },
  SetupNotifications:    { component: lazy(() => import('@/features/admin/pages/SetupNotifications')) },
  MasterSetup:           { component: lazy(() => import('@/features/admin/pages/MasterSetup')) },
  SetupWizard:           { component: lazy(() => import('@/features/settings/pages/SetupWizard')),     props: ctx => ({ setPage: ctx.setPage }) },
  SetupDashboard:        { component: lazy(() => import('@/features/settings/pages/SetupDashboard')),  props: ctx => ({ setPage: ctx.setPage }) },
  MasterConfig:          { component: lazy(() => import('@/features/admin/pages/MasterConfig')) },
  SystemHealth:          { component: lazy(() => import('@/features/admin/pages/SystemHealth')) },
  TallyIntegration:      { component: lazy(() => import('@/features/admin/pages/TallyIntegration')) },
  ZohoSignIntegration:   { component: lazy(() => import('@/features/admin/pages/ZohoSignIntegration')), props: ctx => ({ setPage: ctx.setPage }) },
  UserSetup:             { component: lazy(() => import('@/features/admin/pages/UserSetup')) },
  WorkflowBuilder:       { component: lazy(() => import('@/features/admin/pages/WorkflowBuilder')), props: ctx => ({ setPage: ctx.setPage }) },

  // ── AI ────────────────────────────────────────────────────────────────────
  ERPIntelligence:       { component: lazy(() => import('@/features/ai/pages/ERPIntelligence')), props: ctx => ({ setPage: ctx.setPage }) },

  // ── Analytics ────────────────────────────────────────────────────────────
  CeoDashboard:             { component: lazy(() => import('@/features/analytics/pages/CeoDashboard')) },
  // Phase 49H — CEO Intelligence Dashboard
  CEOIntelligenceDashboard: { component: lazy(() => import('@/features/analytics/pages/CEOIntelligenceDashboard')), props: ctx => ({ setPage: ctx.setPage }) },
  PowerQualityAnalytics:    { module: 'engineering', component: lazy(() => import('@/features/engineering/pages/PowerQualityAnalytics')) },

  // ── Documents ────────────────────────────────────────────────────────────
  // NativeSignature re-exports DocumentSigning — both names render the unified page
  DocumentSigning:       { component: lazy(() => import('@/features/documents/pages/DocumentSigning')) },
  NativeSignature:       { component: lazy(() => import('@/features/documents/pages/DocumentSigning')) },
  DocumentMaster:        { component: lazy(() => import('@/features/documents/pages/DocumentMaster')) },
  QRCodeStudio:          { component: lazy(() => import('@/features/tools/pages/QRCodeStudio')) },

  // ── Approvals / Notifications ────────────────────────────────────────────
  ApprovalCenter:        { component: lazy(() => import('@/features/approvals/pages/ApprovalCenter')) },
  // Read-only "status of what I submitted" view — no approve/reject/delegate
  // controls. Reachable by every role via PERSONAL_PAGES (menuCatalog.js),
  // regardless of section allowlist, since it carries no approval authority.
  MyRequests:            { component: lazy(() => import('@/features/approvals/pages/MyRequests')) },
  NotificationCenter:    { component: lazy(() => import('@/features/notifications/pages/NotificationCenter')) },

  // ── Employees ────────────────────────────────────────────────────────────
  EmployeesDashboard:    { component: lazy(() => import('@/features/employees/pages/EmployeesDashboard')), props: ctx => ({ setPage: ctx.setPage, setSelectedEmployee: ctx.setSelectedEmployee }) },
  EmployeesData:         { module: 'employees', component: lazy(() => import('@/features/employees/pages/EmployeesData')),      props: ctx => ({ setPage: ctx.setPage, setSelectedEmployee: ctx.setSelectedEmployee }) },
  ExEmployees:           { module: 'employees', component: lazy(() => import('@/features/employees/pages/ExEmployees')),        props: ctx => ({ setPage: ctx.setPage, setSelectedEmployee: ctx.setSelectedEmployee }) },
  EmployeeProfile:       { module: 'employees', component: lazy(() => import('@/features/employees/pages/EmployeeProfile')),    props: ctx => ({ employee: ctx.selectedEmployee, setPage: ctx.setPage, setSelectedEmployee: ctx.setSelectedEmployee, urlParams: ctx.urlParams }) },
  AddEmployee:           { module: 'employees', component: lazy(() => import('@/features/employees/pages/AddEmployee')),        props: ctx => ({ setPage: ctx.setPage, employee: ctx.selectedEmployee, setSelectedEmployee: ctx.setSelectedEmployee }) },
  EditEmployee:          { module: 'employees', component: lazy(() => import('@/features/employees/pages/EditEmployee')),       props: ctx => ({ employee: ctx.selectedEmployee, setPage: ctx.setPage, setSelectedEmployee: ctx.setSelectedEmployee }) },

  // ── HR ────────────────────────────────────────────────────────────────────
  // Hub pages — merged submenus
  PayrollCenter:            { component: lazy(() => import('@/features/hr/pages/PayrollCenter')),              props: ctx => ({ setPage: ctx.setPage }) },
  SuccessionCenter:         { component: lazy(() => import('@/features/hr/pages/SuccessionCenter')) },

  PayrollSettings:       { component: lazy(() => import('@/features/hr/pages/PayrollSettings')),           props: ctx => ({ setPage: ctx.setPage }) },
  PayrollForm16:         { component: lazy(() => import('@/features/hr/pages/PayrollForm16')),              props: ctx => ({ setPage: ctx.setPage }) },
  PayrollForm24Q:        { component: lazy(() => import('@/features/hr/pages/PayrollForm24Q')),             props: ctx => ({ setPage: ctx.setPage }) },
  Announcements:         { component: lazy(() => import('@/features/hr/pages/Announcements')) },
  BiometricAccess:       { component: lazy(() => import('@/features/hr/pages/BiometricAccess')) },
  Downloads:             { component: lazy(() => import('@/features/hr/pages/Downloads')) },
  EmployeeDirectory:     { component: lazy(() => import('@/features/hr/pages/EmployeeDirectory')) },
  EmployeeDocuments:     { component: lazy(() => import('@/features/hr/pages/EmployeeDocuments')) },
  EmployeeSelfService:   { component: lazy(() => import('@/features/hr/pages/EmployeeSelfService')), props: ctx => ({ setPage: ctx.setPage }) },
  ExitManagement:        { component: lazy(() => import('@/features/hr/pages/ExitManagement')), props: ctx => ({ setPage: ctx.setPage }) },
  HolidayCalendar:       { component: lazy(() => import('@/features/hr/pages/HolidayCalendar')) },
  LearningDevelopment:   { component: lazy(() => import('@/features/hr/pages/LearningDevelopment')) },
  LearningDashboard:     { component: lazy(() => import('@/features/hr/pages/LearningDashboard')) },
  CertificationManagement: { component: lazy(() => import('@/features/hr/pages/CertificationManagement')) },
  LearningPaths:         { component: lazy(() => import('@/features/hr/pages/LearningPaths')) },
  AssessmentCenter:      { component: lazy(() => import('@/features/hr/pages/AssessmentCenter')) },
  TrainerManagement:     { component: lazy(() => import('@/features/hr/pages/TrainerManagement')) },
  TrainingReports:       { component: lazy(() => import('@/features/hr/pages/TrainingReports')) },
  CompetencyFramework:   { component: lazy(() => import('@/features/hr/pages/CompetencyFramework')) },
  LNDSettings:           { component: lazy(() => import('@/features/hr/pages/LNDSettings')), props: ctx => ({ setPage: ctx.setPage }) },
  Offboarding:           { component: lazy(() => import('@/features/hr/pages/Offboarding')), props: ctx => ({ setPage: ctx.setPage }) },
  Payroll:               { module: 'hr', component: lazy(() => import('@/features/hr/pages/Payroll')), props: ctx => ({ setPage: ctx.setPage }) },
  PayslipGenerator:      { component: lazy(() => import('@/features/hr/pages/PayslipGenerator')) },
  PayslipViewer:         { component: lazy(() => import('@/features/hr/pages/PayslipViewer')) },
  Policies:              { component: lazy(() => import('@/features/hr/pages/Policies')) },
  Probation:             { component: lazy(() => import('@/features/hr/pages/Probation')) },
  SalaryStructure:       { component: lazy(() => import('@/features/hr/pages/SalaryStructure')) },
  SuccessionPlanning:        { component: lazy(() => import('@/features/hr/pages/SuccessionPlanning')) },
  LeadershipPipeline:        { component: lazy(() => import('@/features/hr/pages/LeadershipPipeline')) },
  DevelopmentPlans:          { component: lazy(() => import('@/features/hr/pages/DevelopmentPlans')) },
  EmployeeSuccessionPools:   { component: lazy(() => import('@/features/hr/pages/EmployeeSuccessionPools')) },
  SuccessionReports:         { component: lazy(() => import('@/features/hr/pages/SuccessionReports')) },
  SuccessionSettings:        { component: lazy(() => import('@/features/hr/pages/SuccessionSettings')), props: ctx => ({ setPage: ctx.setPage }) },
  SkillMatrix:               { component: lazy(() => import('@/features/hr/pages/SkillMatrix')), props: ctx => ({ setPage: ctx.setPage }) },
  EmployeeReports:       { component: lazy(() => import('@/features/hr/pages/EmployeeReports')) },
  HRAnalyticsDashboard:    { component: lazy(() => import('@/features/hr/pages/HRAnalyticsDashboard')) },
  HRBenchmarkingDashboard: { component: lazy(() => import('@/features/hr/pages/HRBenchmarkingDashboard')) },
  EmployeeAssets:        { component: lazy(() => import('@/features/hr/pages/EmployeeAssets')) },

  // ── Attendance ───────────────────────────────────────────────────────────
  // Hub page — merged report submenus
  AttendanceReportsHub:     { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/AttendanceReportsHub')) },

  AttendanceDashboard:         { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/AttendanceDashboard')) },
  TeamAttendance:              { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/TeamAttendance')) },
  LateArrivals:                { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/LateArrivals')) },
  // Phase 32 — Enterprise Attendance Platform
  LiveWorkforceDashboard:      { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/LiveWorkforceDashboard')) },
  AttendancePolicies:          { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/AttendancePolicies')) },
  RegularizationApprovals:     { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/RegularizationApprovals')) },
  OvertimeApprovals:           { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/OvertimeApprovals')) },
  AttendanceAnalytics:         { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/AttendanceAnalytics')) },
  AttendanceAuditLogs:         { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/AttendanceAuditLogs')) },
  ShiftCalendar:               { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/ShiftCalendar')) },
  MonthlyAttendanceReport:     { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/MonthlyAttendanceReport')) },
  // Phase 33 — Enterprise Attendance Configuration + Control Center
  ShiftManagement:             { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/ShiftManagement')) },
  GeoFencing:                  { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/GeoFencing')) },
  AttendanceSettings:          { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/AttendanceSettings')) },
  DeviceManagement:            { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/DeviceManagement')) },
  FaceAttendance:              { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/FaceAttendance')) },
  WorkCentres:                 { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/WorkCentres')) },
  ContractLabour:              { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/ContractLabour')) },
  PayrollSync:                 { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/PayrollSync')), props: ctx => ({ setPage: ctx.setPage }) },
  AttendanceReports:           { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/AttendanceReports')) },
  QRAttendance:                { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/QRAttendance')) },
  GeoViolationsReport:         { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/GeoViolationsReport')) },
  GeneralSettings:             { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/settings/GeneralSettings')) },
  ApprovalDelegation:          { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/ApprovalDelegation')) },

  // ── Leaves ───────────────────────────────────────────────────────────────
  ApplyLeave:            { module: 'leaves', component: lazy(() => import('@/features/leaves/pages/ApplyLeave')), props: ctx => ({ setPage: ctx.setPage }) },
  MyLeaves:              { module: 'leaves', component: lazy(() => import('@/features/leaves/pages/MyLeaves')),   props: ctx => ({ setPage: ctx.setPage }) },
  AllLeaves:             { module: 'leaves', component: lazy(() => import('@/features/leaves/pages/AllLeaves')) },
  LeaveSettings:         { module: 'leaves', component: lazy(() => import('@/features/leaves/pages/LeaveSettings')), props: ctx => ({ setPage: ctx.setPage }) },
  LeaveApprovals:        { module: 'leaves', component: lazy(() => import('@/features/leaves/pages/LeaveApprovals')) },
  LeaveCalendar:         { module: 'leaves', component: lazy(() => import('@/features/leaves/pages/LeaveCalendar')) },
  LeaveReports:          { module: 'leaves', component: lazy(() => import('@/features/leaves/pages/LeaveReports')) },
  CompOff:               { module: 'leaves', component: lazy(() => import('@/features/leaves/pages/CompOffPage')) },
  LeaveEncashment:       { module: 'leaves', component: lazy(() => import('@/features/leaves/pages/LeaveEncashmentPage')) },
  // Legacy page keys — redirect to unified LeaveApprovals with pre-selected queue
  HRApprovalLeave:       { module: 'leaves', component: lazy(() => import('@/features/leaves/pages/LeaveApprovals')), props: () => ({ initialQueue: 'hr' }) },
  ManagerApprovalLeave:  { module: 'leaves', component: lazy(() => import('@/features/leaves/pages/LeaveApprovals')), props: () => ({ initialQueue: 'manager' }) },
  L2ApprovalLeave:       { module: 'leaves', component: lazy(() => import('@/features/leaves/pages/LeaveApprovals')), props: () => ({ initialQueue: 'l2' }) },
  TeamLeaves:            { module: 'leaves', component: lazy(() => import('@/features/leaves/pages/LeaveApprovals')), props: () => ({ initialQueue: 'team' }) },

  // ── Finance ──────────────────────────────────────────────────────────────
  // Primary nav pages
  FinanceDashboardNew:   { module: 'finance', component: lazy(() => import('@/features/finance/pages/FinanceDashboard')),    props: ctx => ({ setPage: ctx.setPage }) },
  AccountingEngine:      { module: 'finance', component: lazy(() => import('@/features/finance/pages/AccountingEngine')) },
  ReceivablesPage:       { module: 'finance', component: lazy(() => import('@/features/finance/pages/ReceivablesPage')),     props: ctx => ({ setPage: ctx.setPage }) },
  PayablesPage:          { module: 'finance', component: lazy(() => import('@/features/finance/pages/PayablesPage')),        props: ctx => ({ setPage: ctx.setPage }) },
  PaymentBatch:          { module: 'finance', component: lazy(() => import('@/features/finance/pages/PaymentBatch')) },
  TaxManagement:         { module: 'finance', component: lazy(() => import('@/features/finance/pages/TaxPage')) },
  BudgetManagement:      { module: 'finance', component: lazy(() => import('@/features/finance/pages/BudgetManagement')) },
  FixedAssets:           { module: 'finance', component: lazy(() => import('@/features/finance/pages/FixedAssets')) },
  FinanceReports:        { module: 'finance', component: lazy(() => import('@/features/finance/pages/Reports')) },
  Parties:               { module: 'finance', component: lazy(() => import('@/features/finance/pages/Parties')),             props: ctx => ({ setPage: ctx.setPage }) },
  FinanceSettings:       { module: 'finance', component: lazy(() => import('@/features/finance/pages/FinanceSettings')),     props: ctx => ({ setPage: ctx.setPage }) },
  CostCenters:           { module: 'finance', component: lazy(() => import('@/features/finance/pages/CostCenters')),         props: ctx => ({ setPage: ctx.setPage }) },
  // Still-accessible pages (not in sidebar but reachable via direct nav / links)
  CFODashboard:          { module: 'finance', component: lazy(() => import('@/features/finance/pages/CFODashboard')),        props: ctx => ({ setPage: ctx.setPage }) },
  BankAccounts:          { module: 'finance', component: lazy(() => import('@/features/finance/pages/BankAccounts')) },
  BudgetVsActuals:       { module: 'finance', component: lazy(() => import('@/features/finance/pages/BudgetVsActuals')) },
  ChartOfAccounts:       { module: 'finance', component: lazy(() => import('@/features/finance/pages/ChartOfAccounts')) },
  CustomerOutstanding:   { module: 'finance', component: lazy(() => import('@/features/finance/pages/CustomerOutstanding')) },
  FinancialRatios:       { module: 'finance', component: lazy(() => import('@/features/finance/pages/FinancialRatios')) },
  FinancialStatements:   { module: 'finance', component: lazy(() => import('@/features/finance/pages/FinancialStatements')) },
  ForexManagement:       { module: 'finance', component: lazy(() => import('@/features/finance/pages/ForexManagement')) },
  GSTModule:             { module: 'finance', component: lazy(() => import('@/features/finance/pages/GSTModule')) },
  InvoicesNew:           { module: 'finance', component: lazy(() => import('@/features/finance/pages/Invoices')) },
  JournalEntry:          { module: 'finance', component: lazy(() => import('@/features/finance/pages/JournalEntry')) },
  PDCManagement:         { module: 'finance', component: lazy(() => import('@/features/finance/pages/PDCManagement')) },
  PaymentGateway:        { module: 'finance', component: lazy(() => import('@/features/finance/pages/PaymentGateway')) },
  PeriodClosing:         { module: 'finance', component: lazy(() => import('@/features/finance/pages/PeriodClosing')) },
  PurchaseDashboard:     { module: 'finance', component: lazy(() => import('@/features/finance/pages/PurchaseDashboard')) },
  ReportPurchase:        { module: 'finance', component: lazy(() => import('@/features/finance/pages/ReportPurchase')) },
  SupplierBills:         { module: 'finance', component: lazy(() => import('@/features/finance/pages/SupplierBills')) },
  SupplierOutstanding:   { module: 'finance', component: lazy(() => import('@/features/finance/pages/SupplierOutstanding')) },
  TDSManagement:         { module: 'finance', component: lazy(() => import('@/features/finance/pages/TDSManagement')) },
  TCSManagement:         { module: 'finance', component: lazy(() => import('@/features/finance/pages/TCSManagement')) },
  Tickets:               { module: 'finance', component: lazy(() => import('@/features/finance/pages/Tickets')) },
  CreditNotes:           { module: 'finance', component: lazy(() => import('@/features/finance/pages/CreditNotes')),         props: ctx => ({ setPage: ctx.setPage }) },
  DebitNotes:            { module: 'finance', component: lazy(() => import('@/features/finance/pages/DebitNotes')),          props: ctx => ({ setPage: ctx.setPage }) },
  ComplianceSettings:    { module: 'finance', component: lazy(() => import('@/features/finance/pages/ComplianceSettings')),  props: ctx => ({ setPage: ctx.setPage }) },

  // ── Complaints (IPCS) ────────────────────────────────────────────────────
  // The list + create pages were retired 2026-07-17 and are served by
  // CustomerComplaintsIPCS (registered under Service Desk below) — see
  // SERVICE_MASTER_IPCS_PLAN.md 3c.
  //
  // ComplaintDetail SURVIVES on purpose: it is the only UI for the status
  // transition machine (PUT /complaints/:id/status), the history trail and
  // comments. The IPCS grid's drawer deliberately omits status, so deleting this
  // would leave open->in_progress->resolved->closed unreachable. ReviewFeedback
  // also drills into it by id.
  ComplaintsDashboard:   { component: lazy(() => import('@/features/complaints/pages/ComplaintsDashboard')), props: ctx => ({ setPage: ctx.setPage }) },
  ComplaintDetail:       { component: lazy(() => import('@/features/complaints/pages/ComplaintDetail')),     props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams }) },

  // ── Procurement ──────────────────────────────────────────────────────────
  // Hub page — merged vendor submenus
  VendorCenter:             { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/VendorCenter')), props: ctx => ({ setPage: ctx.setPage }) },

  PurchaseRequestDashboard: { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/PurchaseRequest')) },
  PurchaseOrderManagement:  { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/PurchaseOrderManagement')) },
  PurchaseOrders:           { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/PurchaseOrders')) },
  GoodsReceipt:             { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/GoodsReceipt')) },
  VendorManagement:         { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/VendorManagement')) },
  Vendor360:                { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/Vendor360')) },
  PriceHistory:             { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/PriceHistory')) },
  VendorComparison:         { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/VendorComparison')) },
  MRPPlanning:              { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/MRPPlanning')) },
  QualityInspection:        { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/QualityInspection')) },
  ProcurementReports:       { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/ProcurementReports')) },
  VendorPortal:             { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/VendorPortal')) },
  VendorScorecard:          { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/VendorScorecard')) },
  // Phase 49C — Vendor Registration Portal
  VendorDashboard:          { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/VendorDashboard')), props: ctx => ({ setPage: ctx.setPage }) },
  VendorApprovalQueue:      { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/VendorApprovalQueue')) },
  VendorRiskDashboard:      { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/VendorRiskDashboard')) },
  VendorRegistration:       { public: true,          component: lazy(() => import('@/features/procurement/pages/VendorRegistration')) },

  // ── Inventory ────────────────────────────────────────────────────────────
  InventoryDashboard:        { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/InventoryDashboard')),        props: ctx => ({ setPage: ctx.setPage }) },
  AdvancedInventoryDashboard:{ module: 'inventory', component: lazy(() => import('@/features/inventory/pages/AdvancedInventoryDashboard')), props: ctx => ({ setPage: ctx.setPage }) },
  BatchTracking:             { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/BatchTracking')),             props: ctx => ({ setPage: ctx.setPage }) },
  InventoryIntelligence:     { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/InventoryIntelligence')) },
  InventoryReport:           { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/InventoryReport')) },
  ItemMaster:                { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/ItemMaster')),                props: ctx => ({ setPage: ctx.setPage }) },
  LogisticsShipping:         { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/LogisticsShipping')) },
  MaterialConsumption:       { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/MaterialConsumption')),       props: ctx => ({ setPage: ctx.setPage }) },
  QualityManagement:         { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/QualityManagement')) },
  StockAlertsAndSuggestions: { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/StockAlertsAndSuggestions')), props: ctx => ({ setPage: ctx.setPage }) },
  StockMovements:            { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/StockMovements')) },
  StockReservations:         { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/StockReservations')),         props: ctx => ({ setPage: ctx.setPage }) },
  StockSummary:              { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/StockSummary')) },
  StoresDashboard:           { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/StoresDashboard')),           props: ctx => ({ setPage: ctx.setPage }) },
  StoresCostAnalysis:        { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/StoresCostAnalysis')) },
  VendorPriceComparison:     { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/VendorPriceComparison')) },
  WarehouseManagement:       { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/WarehouseManagement')) },
  SerialTracking:            { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/SerialTracking')) },
  InventorySettings:         { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/InventorySettings')),  props: ctx => ({ setPage: ctx.setPage }) },

  // ── Production ───────────────────────────────────────────────────────────
  ProductionSettings:    { module: 'production', component: lazy(() => import('@/features/production/pages/ProductionSettings')),  props: ctx => ({ setPage: ctx.setPage }) },
  BOMBuilder:            { module: 'production', component: lazy(() => import('@/features/production/pages/BOMBuilder')),           props: ctx => ({ setPage: ctx.setPage }) },
  ProductionDashboard:   { module: 'production', component: lazy(() => import('@/features/production/pages/ProductionDashboard')),  props: ctx => ({ setPage: ctx.setPage }) },
  ProductionDetail:      { module: 'production', component: lazy(() => import('@/features/production/pages/ProductionDetail')),     props: ctx => ({ order: ctx.selectedProduction, setPage: ctx.setPage, initialTab: ctx.selectedProduction?._initialTab }) },
  ProductionOrders:      { module: 'production', component: lazy(() => import('@/features/production/pages/ProductionOrders')),     props: ctx => ({ setPage: ctx.setPage, setSelectedProduction: ctx.setSelectedProduction }) },
  ProductionModuleRequests: { module: 'production', component: lazy(() => import('@/features/production/pages/ProductionModuleRequests')) },
  WorkCentrePlanning:    { module: 'production', component: lazy(() => import('@/features/production/pages/WorkCentrePlanning')) },
  MRPWorkbench:          { module: 'production', component: lazy(() => import('@/features/production/pages/MRPWorkbench')) },
  CRPWorkbench:          { module: 'production', component: lazy(() => import('@/features/production/pages/CRPWorkbench')) },
  SubcontractOrders:     { module: 'production', component: lazy(() => import('@/features/production/pages/SubcontractOrders')) },
  GenealogyTrace:        { module: 'production', component: lazy(() => import('@/features/production/pages/GenealogyTrace')) },
  BOMModeling:           { module: 'production', component: lazy(() => import('@/features/production/pages/BOMModeling')) },
  SOPPlanning:           { module: 'production', component: lazy(() => import('@/features/production/pages/SOPPlanning')) },
  ShopFloor:             { module: 'production', component: lazy(() => import('@/features/production/pages/ShopFloor')),            props: ctx => ({ setPage: ctx.setPage }) },

  // ── Projects ─────────────────────────────────────────────────────────────
  // Hub pages — merged financial + lifecycle submenus
  ProjectFinancialsHub:     { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectFinancialsHub')), props: ctx => ({ setPage: ctx.setPage }) },
  ProjectLifecycleHub:      { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectLifecycleHub')),  props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams }) },

  ProjectsDashboard:     { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectsDashboard')),  props: ctx => ({ setPage: ctx.setPage }) },
  ProjectDetail:         { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectDetail')),      props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams }) },
  Projects:              { module: 'projects', component: lazy(() => import('@/features/projects/pages/Projects')) },
  KanbanBoard:           { module: 'projects', component: lazy(() => import('@/features/projects/pages/KanbanBoard')) },
  ProjectCosting:        { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectCosting')) },
  ProjectProfitabilityDashboard: { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectProfitabilityDashboard')), props: ctx => ({ setPage: ctx.setPage }) },
  Project360:            { module: 'projects', component: lazy(() => import('@/features/projects/pages/Project360')) },
  GanttChart:            { module: 'projects', component: lazy(() => import('@/features/projects/pages/GanttChart')) },
  ResourceManagement:    { module: 'projects', component: lazy(() => import('@/features/projects/pages/ResourceManagement')), props: ctx => ({ setPage: ctx.setPage }) },
  InstallationDashboard: { module: 'projects', component: lazy(() => import('@/features/projects/pages/InstallationDashboard')) },
  UploadBOM:             { module: 'projects', component: lazy(() => import('@/features/projects/pages/UploadBOM')) },
  ProjectSettings:       { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectSettings')),     props: ctx => ({ setPage: ctx.setPage }) },
  ProductionDeliveryTracker: { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProductionDeliveryTracker')), props: ctx => ({ setPage: ctx.setPage }) },
  ProjectPipelineBoard:  { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectPipelineBoard')), props: ctx => ({ setPage: ctx.setPage }) },
  ProjectWorkflowTracker:{ component: lazy(() => import('@/features/operations/pages/ProjectWorkflowTracker')) },
  IssueManagement:     { module: 'projects', component: lazy(() => import('@/features/projects/pages/IssueManagement')),     props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams }) },
  FATTracker:          { module: 'projects', component: lazy(() => import('@/features/projects/pages/FATTracker')),          props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams }) },
  SATTracker:          { module: 'projects', component: lazy(() => import('@/features/projects/pages/SATTracker')),          props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams }) },
  ProjectAMCManagement:{ module: 'projects', component: lazy(() => import('@/features/projects/pages/AMCManagement')),      props: ctx => ({ setPage: ctx.setPage }) },
  WarrantyManagement:  { module: 'projects', component: lazy(() => import('@/features/projects/pages/WarrantyManagement')), props: ctx => ({ setPage: ctx.setPage }) },
  ProjectReports:      { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectReports')),      props: ctx => ({ setPage: ctx.setPage }) },
  ProjectEVMDashboard: { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectEVMDashboard')),props: ctx => ({ setPage: ctx.setPage }) },
  ProjectProfitability:{ module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectProfitability')) },
  // Phase 46 — Project Cost Engine
  CostTransactions:        { module: 'projects', component: lazy(() => import('@/features/projects/pages/CostTransactions')),        props: ctx => ({ setPage: ctx.setPage }) },
  CostCentreTracking:      { module: 'projects', component: lazy(() => import('@/features/projects/pages/CostCentreTracking')),      props: ctx => ({ setPage: ctx.setPage }) },
  ProjectRevenueSummary:   { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectRevenueSummary')),   props: ctx => ({ setPage: ctx.setPage }) },
  CEOCommandCenter:        { module: 'projects', component: lazy(() => import('@/features/projects/pages/CEOCommandCenter')),        props: ctx => ({ setPage: ctx.setPage }) },

  // ── Timesheets ───────────────────────────────────────────────────────────
  TimesheetSettings:     { module: 'timesheets', component: lazy(() => import('@/features/timesheets/pages/TimesheetSettings')), props: ctx => ({ setPage: ctx.setPage }) },
  MyTimesheet:           { module: 'timesheets', component: lazy(() => import('@/features/timesheets/pages/MyTimesheet')) },
  Timesheets:            { module: 'timesheets', component: lazy(() => import('@/features/timesheets/pages/Timesheets')) },
  TimesheetApprovals:    { module: 'timesheets', component: lazy(() => import('@/features/timesheets/pages/TimesheetApprovals')) },
  UtilizationReport:     { module: 'timesheets', component: lazy(() => import('@/features/timesheets/pages/UtilizationReport')) },
  WeeklyProductionReport:{ module: 'timesheets', component: lazy(() => import('@/features/timesheets/pages/WeeklyProductionReport')) },

  // ── Performance ──────────────────────────────────────────────────────────
  PerformanceDashboard:  { module: 'performance', component: lazy(() => import('@/features/performance/pages/PerformanceDashboard')) },
  PerformanceReviews:    { module: 'performance', component: lazy(() => import('@/features/performance/pages/PerformanceReviews')), props: ctx => ({ setPage: ctx.setPage }) },
  Goals:                 { module: 'performance', component: lazy(() => import('@/features/performance/pages/Goals')) },
  TeamPerformance:       { module: 'performance', component: lazy(() => import('@/features/performance/pages/TeamPerformance')) },
  OKRManagement:         { module: 'performance', component: lazy(() => import('@/features/performance/pages/OKRManagement')) },
  KRAManagement:         { module: 'performance', component: lazy(() => import('@/features/performance/pages/KRAManagement')) },
  ReviewCycleManager:    { module: 'performance', component: lazy(() => import('@/features/performance/pages/ReviewCycleManager')) },
  Feedback360:           { module: 'performance', component: lazy(() => import('@/features/performance/pages/Feedback360')) },
  CalibrationCenter:     { module: 'performance', component: lazy(() => import('@/features/performance/pages/CalibrationCenter')) },
  IncrementPlanning:     { module: 'performance', component: lazy(() => import('@/features/performance/pages/IncrementPlanning')) },
  PromotionPlanning:     { module: 'performance', component: lazy(() => import('@/features/performance/pages/PromotionPlanning')) },
  PerformanceReports:    { module: 'performance', component: lazy(() => import('@/features/performance/pages/PerformanceReports')) },

  // ── CRM ──────────────────────────────────────────────────────────────────
  SalesDashboard:        { component: lazy(() => import('@/features/crm/pages/SalesDashboard')), props: ctx => ({ setPage: ctx.setPage }) },
  Leads:                 { component: lazy(() => import('@/features/crm/pages/Leads')), props: ctx => ({ setPage: ctx.setPage }) },
  Accounts:              { component: lazy(() => import('@/features/crm/pages/Accounts')) },
  AccountDetail:         { component: lazy(() => import('@/features/crm/pages/AccountDetail')) },
  Contacts:              { component: lazy(() => import('@/features/crm/pages/Contacts')) },
  OpportunitiesKanban:   { component: lazy(() => import('@/features/crm/pages/OpportunitiesKanban')), props: ctx => ({ setPage: ctx.setPage }) },
  // MODULE_REGISTRY has offered crm.pursuits -> 'Pursuits' while this key was
  // missing, so the CRM > Pursuits menu item resolved to nothing. The page has
  // existed all along at features/crm/pages/Pursuits.jsx. Distinct from
  // marketing's PursuitList below — different module, different page.
  Pursuits:              { component: lazy(() => import('@/features/crm/pages/Pursuits')) },
  CRMEmail:              { component: lazy(() => import('@/features/crm/pages/CRMEmail')) },
  Customer360:           { component: lazy(() => import('@/features/crm/pages/Customer360')) },
  PipelineAutomation:    { component: lazy(() => import('@/features/crm/pages/PipelineAutomation')) },
  CRMSettings:           { component: lazy(() => import('@/features/crm/pages/CRMSettings')), props: ctx => ({ setPage: ctx.setPage }) },
  CRMActivities:         { component: lazy(() => import('@/features/crm/pages/CRMActivities')) },
  CRMReports:            { component: lazy(() => import('@/features/crm/pages/CRMReports')) },
  WonLostLeads:          { component: lazy(() => import('@/features/crm/pages/WonLostLeads')) },
  CustomerHealthDashboard: { component: lazy(() => import('@/features/crm/pages/CustomerHealthDashboard')), props: ctx => ({ setPage: ctx.setPage }) },
  MarketingSettings:     { component: lazy(() => import('@/features/marketing/pages/MarketingSettings')),   props: ctx => ({ setPage: ctx.setPage }) },
  ProcurementSettings:   { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/ProcurementSettings')), props: ctx => ({ setPage: ctx.setPage }) },
  PerformanceSettings:   { component: lazy(() => import('@/features/performance/pages/PerformanceSettings')), props: ctx => ({ setPage: ctx.setPage }) },

  // ── Sales ─────────────────────────────────────────────────────────────────
  // Hub pages — merged intelligence + market submenus
  SalesIntelligence:        { component: lazy(() => import('@/features/sales/pages/SalesIntelligence')) },
  SalesMarket:              { component: lazy(() => import('@/features/sales/pages/SalesMarket')) },

  Quotations:            { component: lazy(() => import('@/features/sales/pages/Quotations')),    props: ctx => ({ setPage: ctx.setPage }) },
  SalesSettings:         { component: lazy(() => import('@/features/sales/pages/SalesSettings')),          props: ctx => ({ setPage: ctx.setPage }) },
  SalesOrders:           { component: lazy(() => import('@/features/sales/pages/SalesOrders')) },
  SalesTargets:          { component: lazy(() => import('@/features/sales/pages/SalesTargets')) },
  SalesConversionAnalytics: { component: lazy(() => import('@/features/sales/pages/SalesConversionAnalytics')) },
  SalesCommandCenter:    { component: lazy(() => import('@/features/sales/pages/SalesCommandCenter')) },
  SalesFunnel:           { component: lazy(() => import('@/features/sales/pages/SalesFunnel')) },
  SalesForecasts:        { component: lazy(() => import('@/features/sales/pages/SalesForecasts')) },
  SalesPlaybooks:        { component: lazy(() => import('@/features/sales/pages/SalesPlaybooks')),  props: ctx => ({ setPage: ctx.setPage }) },
  PlaybookDetail:        { component: lazy(() => import('@/features/sales/pages/PlaybookDetail')),   props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams }) },
  SalesCalendar:         { component: lazy(() => import('@/features/sales/pages/SalesCalendar')) },
  SalesDocuments:        { component: lazy(() => import('@/features/sales/pages/SalesDocuments')) },
  Subscriptions:         { component: lazy(() => import('@/features/sales/pages/Subscriptions')) },
  SalesPartners:         { component: lazy(() => import('@/features/sales/pages/SalesPartners')) },
  Territories:           { component: lazy(() => import('@/features/sales/pages/Territories')) },
  Competitors:           { component: lazy(() => import('@/features/sales/pages/Competitors')) },
  CommissionManagement:  { component: lazy(() => import('@/features/sales/pages/CommissionManagement')) },
  FulfilmentTracking:    { component: lazy(() => import('@/features/sales/pages/FulfilmentTracking')) },
  PricingEngine:         { component: lazy(() => import('@/features/sales/pages/PricingEngine')) },

  // ── Marketing ────────────────────────────────────────────────────────────
  // Hub page — merged analytics submenus
  MarketingAnalytics:       { component: lazy(() => import('@/features/marketing/pages/MarketingAnalytics')) },

  Campaigns:             { component: lazy(() => import('@/features/marketing/pages/Campaigns')) },
  CampaignAnalytics:     { component: lazy(() => import('@/features/marketing/pages/CampaignAnalytics')) },
  MarketingDashboard:    { component: lazy(() => import('@/features/marketing/pages/MarketingDashboard')) },
  AssignTasks:           { component: lazy(() => import('@/features/marketing/pages/AssignTasks')) },
  DeliveryTracker:       { component: lazy(() => import('@/features/marketing/pages/DeliveryTracker')) },
  OrdersWonLost:         { component: lazy(() => import('@/features/marketing/pages/OrdersWonLost')) },
  PursuitList:           { component: lazy(() => import('@/features/marketing/pages/PursuitList')) },
  TimesheetEntry:        { component: lazy(() => import('@/features/marketing/pages/TimesheetEntry')) },
  UserPerformance:       { component: lazy(() => import('@/features/marketing/pages/UserPerformance')) },

  // ── Recruitment ──────────────────────────────────────────────────────────
  RecruitmentSettings:   { component: lazy(() => import('@/features/recruitment/pages/RecruitmentSettings')), props: ctx => ({ setPage: ctx.setPage }) },
  RecruitmentDashboard:  { component: lazy(() => import('@/features/recruitment/pages/RecruitmentDashboard')), props: ctx => ({ setPage: ctx.setPage }) },
  JobRequisitionPipeline:{ component: lazy(() => import('@/features/recruitment/pages/JobRequisitionPipeline')) },
  JobOpenings:           { component: lazy(() => import('@/features/recruitment/pages/JobOpenings')),           props: ctx => ({ setPage: ctx.setPage }) },
  CandidatePipeline:     { component: lazy(() => import('@/features/recruitment/pages/CandidatePipeline')),     props: ctx => ({ setPage: ctx.setPage }) },
  AllCandidates:         { component: lazy(() => import('@/features/recruitment/pages/AllCandidates')),      props: ctx => ({ setPage: ctx.setPage }) },
  CandidateDetail:       { component: lazy(() => import('@/features/recruitment/pages/CandidateDetail')),    props: ctx => ({ setPage: ctx.setPage }) },
  EmailTemplates:        { component: lazy(() => import('@/features/recruitment/pages/EmailTemplates')),     props: ctx => ({ setPage: ctx.setPage }) },
  HiringForecasts:       { component: lazy(() => import('@/features/recruitment/pages/HiringForecasts')) },
  InterviewScheduler:    { component: lazy(() => import('@/features/recruitment/pages/InterviewScheduler')), props: ctx => ({ setPage: ctx.setPage }) },
  OfferManagement:       { component: lazy(() => import('@/features/recruitment/pages/OfferManagement')) },
  OnboardingChecklist:   { component: lazy(() => import('@/features/recruitment/pages/OnboardingChecklist')) },
  RecruitmentReports:    { component: lazy(() => import('@/features/recruitment/pages/RecruitmentReports')) },

  // ── Talent ───────────────────────────────────────────────────────────────
  ResumeDatabase:        { component: lazy(() => import('@/features/talent/pages/ResumeDatabase')) },
  TalentPools:           { component: lazy(() => import('@/features/talent/pages/TalentPools')),      props: ctx => ({ setPage: ctx.setPage }) },
  TalentPoolDetail:      { component: lazy(() => import('@/features/talent/pages/TalentPoolDetail')), props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams }) },
  InterviewQuestionBank: { component: lazy(() => import('@/features/talent/pages/InterviewQuestionBank')) },
  RecruitmentAgencies:   { component: lazy(() => import('@/features/talent/pages/RecruitmentAgencies')) },
  RecruiterDashboard:    { component: lazy(() => import('@/features/talent/pages/RecruiterDashboard')), props: ctx => ({ setPage: ctx.setPage }) },

  // ── Service Desk ─────────────────────────────────────────────────────────
  // Hub pages — merged reviews + intelligence submenus
  ServiceReviews:           { component: lazy(() => import('@/features/servicedesk/pages/ServiceReviews')), props: ctx => ({ setPage: ctx.setPage }) },
  ServiceIntelligence:      { component: lazy(() => import('@/features/servicedesk/pages/ServiceIntelligence')) },

  ServiceDeskSettings:   { component: lazy(() => import('@/features/servicedesk/pages/ServiceDeskSettings')), props: ctx => ({ setPage: ctx.setPage }) },
  SupportDashboard:      { component: lazy(() => import('@/features/servicedesk/pages/SupportDashboard')) },
  AllTickets:            { component: lazy(() => import('@/features/servicedesk/pages/AllTickets')) },
  MyTickets:             { component: lazy(() => import('@/features/servicedesk/pages/MyTickets')) },
  FieldService:          { component: lazy(() => import('@/features/servicedesk/pages/FieldVisitScheduler')) },
  FieldVisitScheduler:   { component: lazy(() => import('@/features/servicedesk/pages/FieldVisitScheduler')) },
  ServiceEngineers:      { component: lazy(() => import('@/features/servicedesk/pages/ServiceEngineers')) },
  KnowledgeBase:         { component: lazy(() => import('@/features/servicedesk/pages/KnowledgeBase')) },
  ServiceContracts:      { component: lazy(() => import('@/features/servicedesk/pages/ServiceContracts')) },
  AgentWorkload:         { component: lazy(() => import('@/features/servicedesk/pages/AgentWorkload')) },
  SLAManagement:         { component: lazy(() => import('@/features/servicedesk/pages/SLAManagement')) },
  DeliveryNote:          { component: lazy(() => import('@/features/servicedesk/pages/DeliveryNote')) },
  ReviewCustomers:       { component: lazy(() => import('@/features/servicedesk/pages/ReviewCustomers')) },
  ReviewFeedback:        { component: lazy(() => import('@/features/servicedesk/pages/ReviewFeedback')) },
  ReviewSites:           { component: lazy(() => import('@/features/servicedesk/pages/ReviewSites')) },
  // The IPS field-service grid. ServiceMaster (below) is the service *catalog* /
  // rate card that used to hold this name — see SERVICE_MASTER_IPS_AUDIT.md.
  ServiceMasterIPS:      { component: lazy(() => import('@/features/servicedesk/pages/ServiceMasterIPS')) },
  // Registered manually (not left to autoRouter) purely so it receives a navigate
  // fn: auto-discovered routes get no props, and the grid links each row through
  // to ComplaintDetail for status/history/comments. Mapped to `navigateTo`, not
  // the usual `setPage` — that name is already the grid's pagination setter.
  CustomerComplaintsIPCS:{ component: lazy(() => import('@/features/servicedesk/pages/CustomerComplaintsIPCS')), props: ctx => ({ navigateTo: ctx.setPage }) },
  ServiceMaster:         { component: lazy(() => import('@/features/servicedesk/pages/ServiceMaster')) },

  // ── Travel & Reimbursement (Phase 47) ────────────────────────────────────
  TravelDashboard:        { component: lazy(() => import('@/features/travel/pages/TravelDashboard')), props: ctx => ({ setPage: ctx.setPage }) },
  TravelRequests:         { component: lazy(() => import('@/features/travel/pages/TravelRequests')) },
  TravelCalendar:         { component: lazy(() => import('@/features/travel/pages/TravelCalendar')) },
  TravelBookings:         { component: lazy(() => import('@/features/travel/pages/TravelBookings')) },
  TravelAdvances:         { component: lazy(() => import('@/features/travel/pages/TravelAdvances')) },
  TravelExpenses:         { component: lazy(() => import('@/features/travel/pages/TravelExpenses')) },
  TravelApprovals:        { component: lazy(() => import('@/features/travel/pages/TravelApprovals')) },
  TravelAnalytics:        { component: lazy(() => import('@/features/travel/pages/TravelAnalytics')) },
  TravelEntry:            { component: lazy(() => import('@/features/travel/pages/TravelEntry')) },
  TravelPayment:          { component: lazy(() => import('@/features/travel/pages/TravelPayment')) },
  TravelAudit:            { component: lazy(() => import('@/features/travel/pages/TravelAudit')) },
  ExpenseReview:          { component: lazy(() => import('@/features/travel/pages/ExpenseReview')) },
  CustomerVisits:         { component: lazy(() => import('@/features/travel/pages/CustomerVisits')) },
  ExpenseClaims:          { component: lazy(() => import('@/features/travel/pages/ExpenseClaims')) },
  TravelPolicyEngine:     { component: lazy(() => import('@/features/travel/pages/TravelPolicyEngine')) },
  VisitReports:           { component: lazy(() => import('@/features/travel/pages/VisitReports')) },
  TravelReports:          { component: lazy(() => import('@/features/travel/pages/TravelReports')) },
  TravelCommandCenter:    { component: lazy(() => import('@/features/travel/pages/TravelCommandCenter')) },

  // ── Operations ───────────────────────────────────────────────────────────
  // Hub pages — merged workflow + lifecycle submenus
  WorkflowCenter:           { component: lazy(() => import('@/features/operations/pages/WorkflowCenter')),          props: ctx => ({ setPage: ctx.setPage }) },
  OperationsLifecycleHub:   { component: lazy(() => import('@/features/operations/pages/OperationsLifecycleHub')) },

  WorkflowVisualizer:     { component: lazy(() => import('@/features/operations/pages/WorkflowVisualizer')), props: ctx => ({ setPage: ctx.setPage }) },
  WorkflowConfiguration:  { component: lazy(() => import('@/features/operations/pages/WorkflowConfiguration')), props: ctx => ({ setPage: ctx.setPage }) },
  DepartmentWorkload:     { component: lazy(() => import('@/features/operations/pages/DepartmentWorkload')) },
  BottleneckAnalytics:    { component: lazy(() => import('@/features/operations/pages/BottleneckAnalytics')) },

  // ── Lifecycle Engine ─────────────────────────────────────────────────────
  LifecycleTracker:       { component: lazy(() => import('@/features/operations/pages/LifecycleTracker')) },
  CommissioningReports:   { component: lazy(() => import('@/features/operations/pages/CommissioningReports')) },
  AMCManagement:          { component: lazy(() => import('@/features/operations/pages/AMCManagement')) },
  OperationsWarranty:     { component: lazy(() => import('@/features/operations/pages/WarrantyManagement')) },
  ServiceStockManagement: { component: lazy(() => import('@/features/servicedesk/pages/StockManagement')) },

  // ── Phase 51 — Customer Portal, Commissioning, Service Analytics ──────────
  CustomerPortalManagement: { component: lazy(() => import('@/features/servicedesk/pages/CustomerPortalManagement')) },
  CustomerPortalDashboard:  { component: lazy(() => import('@/features/servicedesk/pages/CustomerPortalDashboard')) },
  CommissioningWorkflow:    { component: lazy(() => import('@/features/servicedesk/pages/CommissioningWorkflow')) },
  ServiceAnalytics:         { component: lazy(() => import('@/features/servicedesk/pages/ServiceAnalytics')) },
  FailureAnalytics:         { component: lazy(() => import('@/features/servicedesk/pages/FailureAnalytics')) },
  VoiceOfCustomer:          { component: lazy(() => import('@/features/servicedesk/pages/VoiceOfCustomer')) },
  EmployeeAutoCreation:     { component: lazy(() => import('@/features/recruitment/pages/EmployeeAutoCreation')) },

  // ── Company & Branch Admin ────────────────────────────────────────────────
  CompanyProfile:         { component: lazy(() => import('@/features/settings/pages/CompanyProfile')) },
  BranchManagement:       { component: lazy(() => import('@/features/admin/pages/BranchManagement')) },

  // ── Reports / Org / Audit ────────────────────────────────────────────────
  Reports:               { module: 'reports', component: lazy(() => import('@/features/reports/pages/Reports')) },
  SavedReports:          { module: 'reports', component: lazy(() => import('@/features/reports/pages/SavedReports')) },
  OrgChart:              { component: lazy(() => import('@/features/orgchart/pages/OrgChart')), props: ctx => ({ setPage: ctx.setPage, setSelectedEmployee: ctx.setSelectedEmployee }) },
  OrganizationSetup:     { component: lazy(() => import('@/features/orgchart/pages/OrganizationSetup')) },
  AuditLogs:             { component: lazy(() => import('@/features/audit/pages/AuditLogs')) },
  EngineeringDev:        { component: lazy(() => import('@/features/engineering/pages/EngineeringDev')) },

  // ── Engineering ──────────────────────────────────────────────────────────
  EngineeringDashboard:     { module: 'engineering', component: lazy(() => import('@/features/engineering/pages/EngineeringDashboard')) },
  RDProjects:               { module: 'engineering', component: lazy(() => import('@/features/engineering/pages/RDProjects')),          props: ctx => ({ setPage: ctx.setPage }) },
  DesignPhases:             { module: 'engineering', component: lazy(() => import('@/features/engineering/pages/DesignPhases')),         props: ctx => ({ setPage: ctx.setPage, pageParams: ctx.pageParams }) },
  PrototypeTracker:         { module: 'engineering', component: lazy(() => import('@/features/engineering/pages/PrototypeTracker')),     props: ctx => ({ setPage: ctx.setPage, pageParams: ctx.pageParams }) },
  TestPlans:                { module: 'engineering', component: lazy(() => import('@/features/engineering/pages/TestPlans')),            props: ctx => ({ setPage: ctx.setPage, pageParams: ctx.pageParams }) },
  ECNManagement:            { module: 'engineering', component: lazy(() => import('@/features/engineering/pages/ECNManagement')) },

  // ── Quality Center ───────────────────────────────────────────────────────
  QualityDashboard:       { module: 'quality', component: lazy(() => import('@/features/quality/pages/QualityDashboard')) },
  NCRManagement:          { module: 'quality', component: lazy(() => import('@/features/quality/pages/NCRManagement')) },
  CAPAManagement:         { module: 'quality', component: lazy(() => import('@/features/quality/pages/CAPAManagement')) },
  InspectionCenter:       { module: 'quality', component: lazy(() => import('@/features/quality/pages/InspectionCenter')) },
  FATManagement:          { module: 'quality', component: lazy(() => import('@/features/quality/pages/FATManagement')) },
  EquipmentCalibration:   { module: 'quality', component: lazy(() => import('@/features/quality/pages/EquipmentCalibration')) },
  SupplierQuality:        { module: 'quality', component: lazy(() => import('@/features/quality/pages/SupplierQuality')) },
  QualityReports:         { module: 'quality', component: lazy(() => import('@/features/quality/pages/QualityReports')) },
  QualitySettings:        { module: 'quality', component: lazy(() => import('@/features/quality/pages/QualitySettings')), props: ctx => ({ setPage: ctx.setPage }) },
};

// ── NAV_ITEMS ──────────────────────────────────────────────────────────────
import {
  FaHome, FaUsers, FaChartLine, FaBullhorn, FaProjectDiagram,
  FaBox, FaFileAlt, FaCog, FaClock, FaStar, FaHandshake,
  FaShoppingCart, FaBell, FaSitemap, FaHistory, FaCalendarCheck,
  FaUmbrellaBeach, FaBriefcase, FaHeadset, FaPlane, FaCogs,
  FaExclamationCircle, FaWrench, FaRobot,
  FaFlask, FaGraduationCap, FaShieldAlt, FaFileSignature,
  FaClipboardCheck, FaUserTie, FaTrophy, FaTruck, FaQrcode,
  FaUserShield,
} from 'react-icons/fa';

export const NAV_ITEMS = [
  { name: 'Home',               icon: <FaHome />,              page: 'Home' },
  { name: 'Approvals',          icon: <FaClipboardCheck />,    page: 'ApprovalCenter', module: 'approvals' },

  { name: 'Analytics & AI', icon: <FaRobot />, submenu: [
    { name: 'CEO Intelligence',    page: 'CEOIntelligenceDashboard' },
    { name: 'CEO Dashboard',       page: 'CeoDashboard' },
    { name: 'CFO Dashboard',       page: 'CFODashboard' },
    { name: 'Ops Command Center',  page: 'AdminDashboard' },
    { name: 'Executive Dashboard', page: 'ExecutiveDashboard' },
    { name: 'HR Dashboard',        page: 'HRDashboard' },
    { name: 'HR Benchmarking',     page: 'HRBenchmarkingDashboard' },
    { name: 'ERP Intelligence',    page: 'ERPIntelligence' },
    { name: 'System Health',       page: 'SystemHealth' },
  ]},

  { name: 'Employees', icon: <FaUsers />, module: 'employees', submenu: [
    { name: 'Dashboard',           page: 'EmployeesDashboard' },
    { name: 'All Employees',       page: 'EmployeesData' },
    { name: 'Ex-Employees',        page: 'ExEmployees' },
    { name: 'Employee Reports',    page: 'EmployeeReports' },
  ]},

  { name: 'HR', icon: <FaUserTie />, module: 'hr', submenu: [
    { name: 'Announcements',       page: 'Announcements' },
    { name: 'Payroll Center',      page: 'PayrollCenter' },      // Settings·Run·Structure·Generate·View
    { name: 'Employee Directory',  page: 'EmployeeDirectory' },
    { name: 'Probation',           page: 'Probation' },
    { name: 'Policies',            page: 'Policies' },
    { name: 'HR Documents',        page: 'Downloads' },
    { name: 'Offboarding',         page: 'Offboarding' },
    { name: 'Exit Management',     page: 'ExitManagement' },
    { name: 'Employee Documents',  page: 'EmployeeDocuments' },
    { name: 'Self Service',        page: 'EmployeeSelfService' },
    { name: 'Succession Center',   page: 'SuccessionCenter' },   // Planning·Pipeline·Plans·Pools·Reports·Settings
    { name: 'Asset Management',    page: 'EmployeeAssets' },
  ]},

  { name: 'Learning Center', icon: <FaGraduationCap />, submenu: [
    { name: 'L&D Command Centre',   page: 'LearningDashboard' },
    { name: 'Training Calendar',   page: 'LearningDevelopment' },
    { name: 'Learning Paths',      page: 'LearningPaths' },
    { name: 'Assessments',         page: 'AssessmentCenter' },
    { name: 'Certifications',      page: 'CertificationManagement' },
    { name: 'Skill Matrix',        page: 'SkillMatrix' },
    { name: 'Competency Framework',page: 'CompetencyFramework' },
    { name: 'Trainer Management',  page: 'TrainerManagement' },
    { name: 'Training Reports',    page: 'TrainingReports' },
    { name: 'Settings',            page: 'LNDSettings' },
  ]},

  { name: 'Attendance', icon: <FaCalendarCheck />, module: 'attendance', submenu: [
    { name: 'Live Workforce',      page: 'LiveWorkforceDashboard' },
    { name: 'My Attendance',       page: 'AttendanceDashboard' },
    { name: 'QR Attendance',       page: 'QRAttendance' },
    { name: 'Team Attendance',     page: 'TeamAttendance' },
    { name: 'Shift Calendar',      page: 'ShiftCalendar' },
    { name: 'Regularization',      page: 'RegularizationApprovals' },
    { name: 'Overtime',            page: 'OvertimeApprovals' },
    { name: 'Approval Delegation', page: 'ApprovalDelegation' },
    { name: 'Reports',             page: 'AttendanceReportsHub' }, // Analytics·Monthly·Late·Geo·All
    { name: 'Work Centres',        page: 'WorkCentres' },
    { name: 'Contract Labour',     page: 'ContractLabour' },
    { name: 'Payroll Sync',        page: 'PayrollSync' },
    { name: 'Settings',            page: 'AttendanceSettings' },
    { name: 'Audit Logs',          page: 'AttendanceAuditLogs' },
  ]},

  { name: 'Leaves', icon: <FaUmbrellaBeach />, module: 'leaves', submenu: [
    { name: 'My Leaves',         page: 'MyLeaves' },
    { name: 'Apply Leave',       page: 'ApplyLeave' },
    { name: 'Leave Approvals',   page: 'LeaveApprovals' },
    { name: 'Team Leaves',       page: 'TeamLeaves' },
    { name: 'Leave Calendar',    page: 'LeaveCalendar' },
    { name: 'Holiday Calendar',  page: 'HolidayCalendar' },
    { name: 'Comp Off',          page: 'CompOff' },
    { name: 'All Leaves',        page: 'AllLeaves' },
    { name: 'Leave Reports',     page: 'LeaveReports' },
    { name: 'Encashment',        page: 'LeaveEncashment' },
    { name: 'Leave Settings',    page: 'LeaveSettings' },
  ]},

  { name: 'Finance', icon: <FaChartLine />, module: 'finance', submenu: [
    { name: 'Finance Dashboard',     page: 'FinanceDashboardNew' },
    { name: 'Accounting Engine',     page: 'AccountingEngine' },
    { name: 'Receivables',           page: 'ReceivablesPage' },
    { name: 'Payables',              page: 'PayablesPage' },
    { name: 'Payments',              page: 'PaymentBatch' },
    { name: 'Tax & Compliance',      page: 'TaxManagement' },
    { name: 'Budget Management',     page: 'BudgetManagement' },
    { name: 'Fixed Assets',          page: 'FixedAssets' },
    { name: 'Financial Reports',     page: 'FinanceReports' },
    { name: 'Customers & Suppliers', page: 'Parties' },
    { name: 'Settings',              page: 'FinanceSettings' },
    { name: 'Self Service',          separator: true },
    { name: 'My Payslip',            page: 'PayslipViewer' },
  ]},

  { name: 'Recruitment', icon: <FaBriefcase />, module: 'recruitment', submenu: [
    { name: 'Dashboard',           page: 'RecruitmentDashboard' },
    // Recruiter's personal "my day" view (today's interviews, action-required,
    // recent applications) — the individual-contributor counterpart to the
    // org-wide Dashboard above. Moved from 'Talent' 2026-07-22: it was grouped
    // with the sourcing-database tools (Resume Database/Pools/Agencies) even
    // though nothing about it is sourcing-related, which also meant manager/
    // department_head — who hold 'Recruitment' but not 'Talent' — could never
    // reach it. No backend change needed: GET /talent/recruiter-dashboard
    // carries no allowRoles restriction of its own.
    { name: 'Recruiter Dashboard', page: 'RecruiterDashboard' },
    { name: 'Job Requisitions',    page: 'JobRequisitionPipeline' },
    { name: 'Job Openings',        page: 'JobOpenings' },
    { name: 'All Candidates',      page: 'AllCandidates' },
    { name: 'Candidate Pipeline',  page: 'CandidatePipeline' },
    { name: 'Interview Scheduler', page: 'InterviewScheduler' },
    { name: 'Offer Management',    page: 'OfferManagement' },
    { name: 'Onboarding',          page: 'OnboardingChecklist' },
    { name: 'Email Templates',     page: 'EmailTemplates' },
    { name: 'Hiring Forecasts',    page: 'HiringForecasts' },
    { name: 'Employee Auto-Creation', page: 'EmployeeAutoCreation' },
    { name: 'Settings',            page: 'RecruitmentSettings' },
  ]},

  // Sourcing/backstage tools, distinct from Recruitment's active-requisition
  // pipeline: these run on /talent/* against `resumes`/`pools`/`agencies`,
  // not the `candidates` tied to a specific job opening.
  { name: 'Talent', icon: <FaStar />, submenu: [
    { name: 'Resume Database',     page: 'ResumeDatabase' },
    { name: 'Talent Pools',        page: 'TalentPools' },
    { name: 'Question Bank',       page: 'InterviewQuestionBank' },
    { name: 'Agencies',            page: 'RecruitmentAgencies' },
  ]},

  { name: 'CRM', icon: <FaHandshake />, submenu: [
    { name: 'Dashboard',           page: 'SalesDashboard' },
    { name: 'IEM — Enquiries',     page: 'Leads' },
    { name: 'Accounts',            page: 'Accounts' },
    { name: 'Contacts',            page: 'Contacts' },
    { name: 'Opportunities',       page: 'OpportunitiesKanban' },
    { name: 'Won / Lost Leads',    page: 'WonLostLeads' },
    { name: 'CRM Email',           page: 'CRMEmail' },
    { name: 'Customer 360',        page: 'Customer360' },
    { name: 'Health Engine',       page: 'CustomerHealthDashboard' },
    { name: 'Activities',          page: 'CRMActivities' },
    { name: 'Reports',             page: 'CRMReports' },
    { name: 'Pipeline Automation', page: 'PipelineAutomation' },
    { name: 'Settings',            page: 'CRMSettings' },
  ]},

  { name: 'Sales', icon: <FaShoppingCart />, submenu: [
    { name: 'Command Center',   page: 'SalesCommandCenter' },
    { name: 'Quotations',       page: 'Quotations' },
    { name: 'Sales Orders',     page: 'SalesOrders' },
    { name: 'Sales Targets',    page: 'SalesTargets' },
    { name: 'Intelligence',     page: 'SalesIntelligence' },   // Conversion·Funnel·Forecasts
    { name: 'Pricing Engine',   page: 'PricingEngine' },
    { name: 'Commission',       page: 'CommissionManagement' },
    { name: 'Fulfilment',       page: 'FulfilmentTracking' },
    { name: 'Playbooks',        page: 'SalesPlaybooks' },
    { name: 'Calendar',         page: 'SalesCalendar' },
    { name: 'Documents',        page: 'SalesDocuments' },
    { name: 'Subscriptions',    page: 'Subscriptions' },
    { name: 'Market Presence',  page: 'SalesMarket' },         // Partners·Territories·Competitors
    { name: 'Settings',         page: 'SalesSettings' },
  ]},

  { name: 'Marketing', icon: <FaBullhorn />, submenu: [
    { name: 'Dashboard',       page: 'MarketingDashboard' },
    { name: 'Campaigns',       page: 'Campaigns' },
    { name: 'Analytics',       page: 'MarketingAnalytics' },  // Campaign·Won/Lost·Performance
    { name: 'Assign Tasks',    page: 'AssignTasks' },
    { name: 'Delivery Tracker',page: 'DeliveryTracker' },
    { name: 'Pursuit List',    page: 'PursuitList' },
    { name: 'Timesheet Entry', page: 'TimesheetEntry' },
    { name: 'Settings',        page: 'MarketingSettings' },
  ]},

  { name: 'Procurement', icon: <FaTruck />, module: 'procurement', submenu: [
    { name: 'Purchase Requests',  page: 'PurchaseRequestDashboard' },
    { name: 'PO Management',      page: 'PurchaseOrderManagement' },
    { name: 'Purchase Orders',    page: 'PurchaseOrders' },
    { name: 'Goods Receipt',      page: 'GoodsReceipt' },
    { name: 'Vendor Center',      page: 'VendorCenter' },     // Overview·Master·Approvals·Risk·360°·Portal·Scorecard·Pricing·Compare
    { name: 'MRP Planning',       page: 'MRPPlanning' },
    { name: 'Quality Inspection', page: 'QualityInspection' },
    { name: 'Reports',            page: 'ProcurementReports' },
    { name: 'Settings',           page: 'ProcurementSettings' },
  ]},

  { name: 'Inventory', icon: <FaBox />, module: 'inventory', submenu: [
    { name: 'Dashboard',           page: 'InventoryDashboard' },
    { name: 'Advanced Dashboard',  page: 'AdvancedInventoryDashboard' },
    { name: 'Item Master',         page: 'ItemMaster' },
    { name: 'Stock Summary',       page: 'StockSummary' },
    { name: 'Stock Movements',     page: 'StockMovements' },
    { name: 'Batch Tracking',      page: 'BatchTracking' },
    { name: 'Stock Alerts',        page: 'StockAlertsAndSuggestions' },
    { name: 'Reservations',        page: 'StockReservations' },
    { name: 'Material Consumption',page: 'MaterialConsumption' },
    { name: 'Inventory Intel',     page: 'InventoryIntelligence' },
    { name: 'Inventory Report',    page: 'InventoryReport' },
    { name: 'Warehouse',           page: 'WarehouseManagement' },
    { name: 'Quality',             page: 'QualityManagement' },
    { name: 'Logistics',           page: 'LogisticsShipping' },
    { name: 'Stores Dashboard',    page: 'StoresDashboard' },
    { name: 'Stores Cost Analysis',page: 'StoresCostAnalysis' },
    { name: 'Component Pricing',   page: 'VendorPriceComparison' },
    { name: 'Settings',            page: 'InventorySettings' },
  ]},

  { name: 'Production', icon: <FaFlask />, module: 'production', submenu: [
    { name: 'Production Dashboard',page: 'ProductionDashboard' },
    { name: 'Module Production Batches', page: 'ProductionOrders' },
    { name: 'Module Batch Requests', page: 'ProductionModuleRequests' },
    { name: 'BOM Builder',         page: 'BOMBuilder' },
    { name: 'BOM Modeling',        page: 'BOMModeling' },
    { name: 'MRP Workbench',       page: 'MRPWorkbench' },
    { name: 'Capacity Planning (CRP)', page: 'CRPWorkbench' },
    { name: 'S&OP / RCCP',         page: 'SOPPlanning' },
    { name: 'Subcontracting',      page: 'SubcontractOrders' },
    { name: 'Batch Genealogy',     page: 'GenealogyTrace' },
    { name: 'Work Centre Planning',page: 'WorkCentrePlanning' },
    { name: 'Shop Floor',          page: 'ShopFloor' },
    { name: 'Upload BOM',          page: 'UploadBOM' },
    { name: 'Settings',            page: 'ProductionSettings' },
  ]},

  { name: 'Quality', icon: <FaShieldAlt />, module: 'quality', submenu: [
    { name: 'Dashboard',             page: 'QualityDashboard' },
    { name: 'NCR Management',        page: 'NCRManagement' },
    { name: 'CAPA Management',       page: 'CAPAManagement' },
    { name: 'Inspection Center',     page: 'InspectionCenter' },
    { name: 'FAT / SAT',             page: 'FATManagement' },
    { name: 'Equipment Calibration', page: 'EquipmentCalibration' },
    { name: 'Supplier Quality',      page: 'SupplierQuality' },
    { name: 'Reports',               page: 'QualityReports' },
    { name: 'Settings',              page: 'QualitySettings' },
  ]},

  { name: 'Engineering', icon: <FaWrench />, module: 'engineering', submenu: [
    { name: 'Dashboard',           page: 'EngineeringDashboard' },
    { name: 'Power Quality',       page: 'PowerQualityAnalytics' },
    { name: 'R&D Projects',        page: 'RDProjects' },
    { name: 'Prototype Tracker',   page: 'PrototypeTracker' },
    { name: 'Test Plans',          page: 'TestPlans' },
    { name: 'Change Notices (ECN)',page: 'ECNManagement' },
  ]},

  { name: 'Projects', icon: <FaProjectDiagram />, module: 'projects', submenu: [
    { name: 'Dashboard',           page: 'ProjectsDashboard' },
    { name: 'Projects',            page: 'Projects' },
    { name: 'Project Master',      page: 'ProductionDeliveryTracker' }, // IPM→IPP production/delivery record grid (single source of truth)
    { name: 'Project Pipeline',    page: 'ProjectPipelineBoard' }, // kanban of IPP projects by production stage (same source as Project Master)
    { name: 'Task Board',          page: 'KanbanBoard' },
    { name: 'Gantt Chart',         page: 'GanttChart' },
    { name: 'Resource Management', page: 'ResourceManagement' },
    { name: 'Financials',          page: 'ProjectFinancialsHub' }, // Costing·EVM·Profitability·Transactions·Cost Centres·Revenue
    { name: 'CEO Command Center',  page: 'CEOCommandCenter' },
    { name: 'Project 360°',        page: 'Project360' },
    { name: 'Issue Management',    page: 'IssueManagement' },
    { name: 'Lifecycle',           page: 'ProjectLifecycleHub' },  // FAT·SAT·AMC·Warranty
    { name: 'Project Reports',     page: 'ProjectReports' },
    { name: 'Installation',        page: 'InstallationDashboard' },
    { name: 'Settings',            page: 'ProjectSettings' },
  ]},

  { name: 'Operations', icon: <FaCogs />, submenu: [
    { name: 'Workflow Center',   page: 'WorkflowCenter' },          // Board·Configuration
    { name: 'Project Tracker',   page: 'ProjectWorkflowTracker' },
    { name: 'Dept Workload',     page: 'DepartmentWorkload' },
    { name: 'Bottlenecks',       page: 'BottleneckAnalytics' },
    { name: 'Lifecycle Tracker', page: 'LifecycleTracker' },
    { name: 'Post-Delivery',     page: 'OperationsLifecycleHub' },  // Commissioning·AMC·Warranty
  ]},

  { name: 'Timesheets', icon: <FaClock />, module: 'timesheets', submenu: [
    { name: 'My Timesheet',        page: 'MyTimesheet' },
    { name: 'My Analytics',        page: 'MyAnalytics' },
    { name: 'All Timesheets',      page: 'Timesheets' },
    { name: 'Approvals',           page: 'TimesheetApprovals' },
    { name: 'Utilization Report',  page: 'UtilizationReport' },
    { name: 'Weekly Report',       page: 'WeeklyProductionReport' },
    { name: 'Settings',            page: 'TimesheetSettings' },
  ]},

  { name: 'Performance', icon: <FaTrophy />, module: 'performance', submenu: [
    { name: 'My Reviews',          page: 'PerformanceReviews' },
    { name: 'Goals & KPIs',        page: 'Goals' },
    { name: '360° Feedback',       page: 'Feedback360' },
    { name: 'Team Performance',    page: 'TeamPerformance' },
    { name: 'Settings',            page: 'PerformanceSettings' },
  ]},

  // Complaints folded into Service Desk 2026-07-17 (IPCS is one half of the
  // complaint -> service-ticket loop). Only the dashboard keeps a top-level home;
  // the register itself lives at Service Desk > Customer Complaints.
  { name: 'Complaints', icon: <FaExclamationCircle />, submenu: [
    { name: 'Dashboard',           page: 'ComplaintsDashboard' },
    { name: 'Complaint Register',  page: 'CustomerComplaintsIPCS' },
  ]},

  { name: 'Service Desk', icon: <FaHeadset />, module: 'servicedesk', submenu: [
    { name: 'Dashboard',         page: 'SupportDashboard' },
    { name: 'All Tickets',       page: 'AllTickets' },
    { name: 'My Tickets',        page: 'MyTickets' },
    { name: 'SLA Management',    page: 'SLAManagement' },
    { name: 'Field Service',     page: 'FieldVisitScheduler' },
    { name: 'Service Engineers', page: 'ServiceEngineers' },
    { name: 'Knowledge Base',    page: 'KnowledgeBase' },
    { name: 'Contracts',         page: 'ServiceContracts' },
    { name: 'Warranty',          page: 'OperationsWarranty' },
    { name: 'Spare Parts Stock', page: 'ServiceStockManagement' },
    { name: 'Agent Workload',    page: 'AgentWorkload' },
    { name: 'Delivery Note',     page: 'DeliveryNote' },
    { name: 'Reviews',           page: 'ServiceReviews' },        // Customers·Feedback·Sites
    { name: 'Service Master',    page: 'ServiceMasterIPS' },   // IPS field-service grid
    { name: 'Customer Complaints', page: 'CustomerComplaintsIPCS' }, // IPCS register
    { name: 'Service Catalog',   page: 'ServiceMaster' },      // rate card (was 'Service Master')
    { name: 'Customer Portal',   page: 'CustomerPortalManagement' },
    { name: 'Commissioning',     page: 'CommissioningWorkflow' },
    { name: 'Intelligence',      page: 'ServiceIntelligence' },   // Analytics·Failure·VoC
    { name: 'Settings',          page: 'ServiceDeskSettings' },
  ]},

  { name: 'Travel Desk', icon: <FaPlane />, submenu: [
    { name: 'Dashboard',           page: 'TravelDashboard' },
    { name: 'Travel Entry',        page: 'TravelEntry' },
    { name: 'Travel Requests',     page: 'TravelRequests' },
    { name: 'Expense Claims',      page: 'ExpenseClaims' },
    { name: 'Visit Reports',       page: 'VisitReports' },
    { name: 'Customer Visits',     page: 'CustomerVisits' },
    { name: 'Travel Approvals',    page: 'TravelApprovals' },
    { name: 'Expense Review',      page: 'ExpenseReview' },
    { name: 'Travel Calendar',     page: 'TravelCalendar' },
    { name: 'Advances',            page: 'TravelAdvances' },
    { name: 'Payment',             page: 'TravelPayment' },
    { name: 'Travel Audit',        page: 'TravelAudit' },
    { name: 'Bookings',            page: 'TravelBookings' },
    { name: 'Policy Engine',       page: 'TravelPolicyEngine' },
    { name: 'Travel Reports',      page: 'TravelReports' },
    { name: 'Command Center',      page: 'TravelCommandCenter' },
    { name: 'Analytics',           page: 'TravelAnalytics' },
  ]},

  { name: 'e-Signatures', icon: <FaFileSignature />, submenu: [
    { name: 'Sign & Send',         page: 'DocumentSigning' },
    { name: 'Document Vault',      page: 'DocumentMaster' },
  ]},

  // Standalone item (no submenu) — visible to every role incl. employees;
  // admin-only tabs are gated inside the page itself.
  { name: 'QR Codes', icon: <FaQrcode />, page: 'QRCodeStudio' },

  { name: 'Reports', icon: <FaFileAlt />, module: 'reports', submenu: [
    { name: 'Report Builder',      page: 'Reports' },
    { name: 'Saved Reports',       page: 'SavedReports' },
  ]},

  // Direct access to the account/role/approval screens, which otherwise exist
  // only as tabs inside Settings → Access Control. Users and Roles are in
  // SUPER_ADMIN_ONLY_PAGES, so the Sidebar filters them out for every role
  // except super_admin — for admin, Sidebar.jsx collapses this group down to
  // a flat "Approver" link instead of a one-item folder.
  { name: 'User Management', icon: <FaUserShield />, submenu: [
    { name: 'Users',               page: 'UserSetup' },
    { name: 'Roles',               page: 'RolesSetup' },
    { name: 'Approver',            page: 'ApproverSetup' },
  ]},

  { name: 'Settings', icon: <FaCog />, page: 'SettingsCenter', submenu: [
    { name: '⚙ Settings Center',   page: 'SettingsCenter' },
    { name: 'User Preferences',    page: 'UserPreferences' },
    { name: 'Setup Wizards',       separator: true },
    { name: 'Setup Center',        page: 'SetupCenter' },          // Overview·First-Time·Attendance·Inventory·Engineering·Payroll
    { name: 'Company & Admin',     separator: true },
    { name: 'Company Profile',     page: 'CompanyProfile' },
    { name: 'Branch Management',   page: 'BranchManagement' },
    { name: 'Administration',      separator: true },
    { name: 'Access Control',      page: 'AccessControl' },        // Users·Roles·Approvers·Security
    { name: 'Workflow Builder',    page: 'WorkflowBuilder' },
    { name: 'Integrations',        page: 'IntegrationsHub' },
    { name: 'Zoho Sign',           page: 'ZohoSignIntegration' },
    { name: 'API Documentation',   page: 'APIDocumentation' },
    { name: 'System Settings',     page: 'SystemSettings' },
    { name: 'Document Setup',      page: 'DocumentSetup' },
    { name: 'Product Setup',       page: 'ProductSetup' },
    { name: 'Master Setup',        page: 'MasterSetup' },
    { name: 'Order Policy',        page: 'OrderPolicy' },
    { name: 'Asset Maintenance',   page: 'AssetMaintenance' },
    { name: 'Setup Notifications', page: 'SetupNotifications' },
    { name: 'Org Setup',           page: 'OrganizationSetup' },
  ]},

  { name: 'Notifications', icon: <FaBell />, page: 'NotificationCenter', module: 'notifications' },
  { name: 'Org Chart',     icon: <FaSitemap />, page: 'OrgChart' },
  { name: 'Audit Logs',    icon: <FaHistory />, page: 'AuditLogs' },
];