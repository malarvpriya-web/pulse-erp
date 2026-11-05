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
  BrandVault:            { component: lazy(() => import('@/features/admin/pages/BrandVault')) },
  DatabaseTest:          { component: lazy(() => import('@/features/admin/pages/DatabaseTest')) },
  DocumentSetup:         { component: lazy(() => import('@/features/admin/pages/DocumentSetup')) },
  IntegrationsHub:       { component: lazy(() => import('@/features/admin/pages/IntegrationsHub')), props: ctx => ({ setPage: ctx.setPage }) },
  OrderPolicy:           { component: lazy(() => import('@/features/admin/pages/OrderPolicy')) },
  ProductSetup:          { component: lazy(() => import('@/features/admin/pages/ProductSetup')) },
  RolesSetup:            { component: lazy(() => import('@/features/admin/pages/RolesSetup')) },
  SecurityCenter:        { component: lazy(() => import('@/features/admin/pages/SecurityCenter')) },
  SettingsCenter:        { component: lazy(() => import('@/features/admin/pages/SettingsCenter')), props: ctx => ({ setPage: ctx.setPage }) },
  SetupNotifications:    { component: lazy(() => import('@/features/admin/pages/SetupNotifications')) },
  MasterSetup:           { component: lazy(() => import('@/features/admin/views/SettingsMasterSetup')), props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams }) },
  SetupWizard:           { component: lazy(() => import('@/features/settings/pages/SetupWizard')),     props: ctx => ({ setPage: ctx.setPage }) },
  SetupDashboard:        { component: lazy(() => import('@/features/settings/pages/SetupDashboard')),  props: ctx => ({ setPage: ctx.setPage }) },
  MasterConfig:          { component: lazy(() => import('@/features/admin/pages/MasterConfig')) },
  SystemHealth:          { component: lazy(() => import('@/features/admin/pages/SystemHealth')) },
  TallyIntegration:      { component: lazy(() => import('@/features/admin/pages/TallyIntegration')) },
  ZohoSignIntegration:   { component: lazy(() => import('@/features/admin/pages/ZohoSignIntegration')), props: ctx => ({ setPage: ctx.setPage }) },
  UserSetup:             { component: lazy(() => import('@/features/admin/pages/UserSetup')) },
  WorkflowBuilder:       { component: lazy(() => import('@/features/admin/pages/WorkflowBuilder')), props: ctx => ({ setPage: ctx.setPage }) },

  // NOTE: nine of these carry NO `module` on purpose. A hub must be no
  // stricter than the pages it absorbs, and those nine each hold at least one
  // child that was routed without a module gate — EmployeeRecords with
  // module:'hr' locked an employee out of Documents/Assets/Policies/Downloads,
  // all four of which they could open individually (caught in the browser
  // pass, not by any unit test). TabHub applies each TAB's own module gate,
  // so the per-page protection is unchanged.
  // ── IA consolidation hubs (2026-09-16) ─────────────────────────
  // Tabbed hub pages that collapsed ~136 sidebar rows into 34 destinations.
  // Registered manually (rather than left to autoRouter) so each carries its
  // module key: an auto-discovered route has `route.module` undefined, and
  // Layout.jsx's module gate would then never fire for the hub, leaving it
  // open by direct URL to any role outside ROLE_SECTION_ALLOWLIST.
  StockControl:             { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/StockControl')), props: ctx => ({ setPage: ctx.setPage }) },
  InventoryPlanning:        { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/InventoryPlanning')), props: ctx => ({ setPage: ctx.setPage }) },
  WarehouseCenter:          { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/WarehouseCenter')), props: ctx => ({ setPage: ctx.setPage }) },
  LogisticsCenter:          { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/LogisticsCenter')), props: ctx => ({ setPage: ctx.setPage }) },
  InventoryInsights:        { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/InventoryInsights')), props: ctx => ({ setPage: ctx.setPage }) },
  ServiceFieldCenter:       { component: lazy(() => import('@/features/servicedesk/pages/ServiceFieldCenter')), props: ctx => ({ setPage: ctx.setPage }) },
  ServiceCustomerCenter:    { component: lazy(() => import('@/features/servicedesk/pages/ServiceCustomerCenter')), props: ctx => ({ setPage: ctx.setPage }) },
  ServiceCatalogCenter:     { component: lazy(() => import('@/features/servicedesk/pages/ServiceCatalogCenter')), props: ctx => ({ setPage: ctx.setPage }) },
  CompanySetup:             { component: lazy(() => import('@/features/admin/pages/CompanySetup')), props: ctx => ({ setPage: ctx.setPage }) },
  MasterDataCenter:         { component: lazy(() => import('@/features/admin/pages/MasterDataCenter')), props: ctx => ({ setPage: ctx.setPage }) },
  PlatformCenter:           { component: lazy(() => import('@/features/admin/pages/PlatformCenter')), props: ctx => ({ setPage: ctx.setPage }) },
  MyTravel:                 { component: lazy(() => import('@/features/travel/pages/MyTravel')), props: ctx => ({ setPage: ctx.setPage }) },
  TravelExpenseCenter:      { component: lazy(() => import('@/features/travel/pages/TravelExpenseCenter')), props: ctx => ({ setPage: ctx.setPage }) },
  TravelVisits:             { component: lazy(() => import('@/features/travel/pages/TravelVisits')), props: ctx => ({ setPage: ctx.setPage }) },
  TravelInsights:           { component: lazy(() => import('@/features/travel/pages/TravelInsights')), props: ctx => ({ setPage: ctx.setPage }) },
  CRMCustomers:             { component: lazy(() => import('@/features/crm/pages/CRMCustomers')), props: ctx => ({ setPage: ctx.setPage }) },
  CRMInsights:              { component: lazy(() => import('@/features/crm/pages/CRMInsights')), props: ctx => ({ setPage: ctx.setPage }) },
  SalesEnablement:          { component: lazy(() => import('@/features/sales/pages/SalesEnablement')), props: ctx => ({ setPage: ctx.setPage }) },
  SalesPerformance:         { component: lazy(() => import('@/features/sales/pages/SalesPerformance')), props: ctx => ({ setPage: ctx.setPage }) },
  FinanceAccounting:        { module: 'finance', component: lazy(() => import('@/features/finance/pages/FinanceAccounting')), props: ctx => ({ setPage: ctx.setPage }) },
  EmployeeRecords:          { component: lazy(() => import('@/features/hr/pages/EmployeeRecords')), props: ctx => ({ setPage: ctx.setPage }) },
  ExitCenter:               { component: lazy(() => import('@/features/hr/pages/ExitCenter')), props: ctx => ({ setPage: ctx.setPage }) },
  InterviewCenter:          { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/InterviewCenter')), props: ctx => ({ setPage: ctx.setPage }) },
  HiringAdmin:              { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/HiringAdmin')), props: ctx => ({ setPage: ctx.setPage }) },
  OnboardingCenter:         { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/OnboardingCenter')), props: ctx => ({ setPage: ctx.setPage }) },
  ProductionPlanningHub:    { module: 'production', component: lazy(() => import('@/features/production/pages/ProductionPlanningHub')), props: ctx => ({ setPage: ctx.setPage }) },
  BOMCenter:                { component: lazy(() => import('@/features/production/pages/BOMCenter')), props: ctx => ({ setPage: ctx.setPage }) },
  ProjectBoards:            { module: 'projects', component: lazy(() => import('@/features/projects/pages/ProjectBoards')), props: ctx => ({ setPage: ctx.setPage }) },
  AttendanceConfig:         { component: lazy(() => import('@/features/attendance/pages/AttendanceConfig')), props: ctx => ({ setPage: ctx.setPage }) },
  AttendanceApprovals:      { module: 'attendance', component: lazy(() => import('@/features/attendance/pages/AttendanceApprovals')), props: ctx => ({ setPage: ctx.setPage }) },
  SourcingCenter:           { component: lazy(() => import('@/features/procurement/pages/SourcingCenter')), props: ctx => ({ setPage: ctx.setPage }) },
  PerformanceManage:        { module: 'performance', component: lazy(() => import('@/features/performance/pages/PerformanceManage')), props: ctx => ({ setPage: ctx.setPage }) },
  TalentDecisions:          { module: 'performance', component: lazy(() => import('@/features/performance/pages/TalentDecisions')), props: ctx => ({ setPage: ctx.setPage }) },
  PerformanceInsights:      { component: lazy(() => import('@/features/performance/pages/PerformanceInsights')), props: ctx => ({ setPage: ctx.setPage }) },

  // ── AI ────────────────────────────────────────────────────────────────────
  ERPIntelligence:       { component: lazy(() => import('@/features/ai/pages/ERPIntelligence')), props: ctx => ({ setPage: ctx.setPage }) },

  // ── Analytics ────────────────────────────────────────────────────────────
  // The single executive hub. `CeoDashboard` was retired 2026-08-17 once this page
  // reached feature parity with it — see manual §108/§108.1/§108.2.
  CEOIntelligenceDashboard: { component: lazy(() => import('@/features/analytics/pages/CEOIntelligenceDashboard')), props: ctx => ({ setPage: ctx.setPage }) },
  // Self-service authoring over the metric registry. The backend for this
  // existed as four CRUD routes behind a 501 with no table and no callers; the
  // page was the missing half. See shared/metricRegistry.js.
  DashboardBuilder:         { component: lazy(() => import('@/features/analytics/pages/DashboardBuilder')) },
  PowerQualityAnalytics:    { module: 'engineering', component: lazy(() => import('@/features/engineering/pages/PowerQualityAnalytics')) },

  // ── Documents ────────────────────────────────────────────────────────────
  // NativeSignature re-exports DocumentSigning — both names render the unified page
  DocumentSigning:       { component: lazy(() => import('@/features/documents/pages/DocumentSigning')) },
  NativeSignature:       { component: lazy(() => import('@/features/documents/pages/DocumentSigning')) },
  DocumentMaster:        { component: lazy(() => import('@/features/documents/pages/DocumentMaster')) },
  QRCodeStudio:          { component: lazy(() => import('@/features/tools/pages/QRCodeStudio')) },

  // ── Approvals / Notifications ────────────────────────────────────────────
  // One page, three tabs (My Pending Approvals / My Requests / Approval
  // History). Every role may open it (PERSONAL_PAGES): the approver tabs only
  // appear for people who approve something, and every decision runs the
  // originating module's own endpoint. `MyRequests` is kept as a page key —
  // the account menu, notifications and old links use it — and opens the same
  // page on the My Requests tab.
  ApprovalCenter:        { component: lazy(() => import('@/features/approvals/pages/ApprovalCenter')) },
  MyRequests:            { component: lazy(() => import('@/features/approvals/pages/ApprovalCenter')), props: () => ({ initialTab: 'my-requests' }) },
  NotificationCenter:    { component: lazy(() => import('@/features/notifications/pages/NotificationCenter')) },

  // ── Employees ────────────────────────────────────────────────────────────
  // module: 'employees' to match EmployeesData below. Without it Layout.jsx's
  // `if (route.module)` gate never fires for this page, so a role inside the
  // People section allowlist but holding no employees:view grant could open
  // the dashboard — including its headcount, department and salary-adjacent
  // breakdowns — while being correctly blocked from the list it links to.
  EmployeesDashboard:    { module: 'employees', component: lazy(() => import('@/features/employees/pages/EmployeesDashboard')), props: ctx => ({ setPage: ctx.setPage, setSelectedEmployee: ctx.setSelectedEmployee }) },
  EmployeesData:         { module: 'employees', component: lazy(() => import('@/features/employees/pages/EmployeesData')),      props: ctx => ({ setPage: ctx.setPage, setSelectedEmployee: ctx.setSelectedEmployee }) },
  ExEmployees:           { module: 'employees', component: lazy(() => import('@/features/employees/pages/ExEmployees')),        props: ctx => ({ setPage: ctx.setPage, setSelectedEmployee: ctx.setSelectedEmployee }) },
  EmployeeProfile:       { module: 'employees', component: lazy(() => import('@/features/employees/pages/EmployeeProfile')),    props: ctx => ({ employee: ctx.selectedEmployee, setPage: ctx.setPage, setSelectedEmployee: ctx.setSelectedEmployee, urlParams: ctx.urlParams }) },
  // ── Background Verification ───────────────────────────────────────────────
  // `module: 'bgv'` deliberately, NOT 'employees'. Layout.jsx's route gate is
  // `hasPermission(route.module, 'view')`, so gating these on 'employees' would
  // open them to every role that can see the employee register — an `employee`
  // and a `manager` both hold employees:can_view. BGV holds criminal-record and
  // reference-check findings; its own permission row is the whole point.
  //
  // ⚠ Registered by hand even though autoRouter would discover both files.
  // AUTO_ROUTES infers `module` from FOLDER_CONFIG, which maps this folder to
  // 'employees' — i.e. auto-discovery would silently apply the WRONG (looser)
  // gate. A manual entry wins because MERGED_ROUTES spreads it last.
  BackgroundVerification: { module: 'bgv', component: lazy(() => import('@/features/employees/pages/BackgroundVerification')), props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams }) },
  EmployeeBGV:            { module: 'bgv', component: lazy(() => import('@/features/employees/pages/EmployeeBGV')),            props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams, employee: ctx.selectedEmployee }) },
  EmployeeMasters:       { module: 'employees', component: lazy(() => import('@/features/employees/pages/EmployeeMasters')), props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams }) },
  AddEmployee:           { module: 'employees', component: lazy(() => import('@/features/employees/pages/AddEmployee')),        props: ctx => ({ setPage: ctx.setPage, employee: null, setSelectedEmployee: ctx.setSelectedEmployee, urlParams: ctx.urlParams }) },  // always a NEW hire — editing goes through EditEmployee, which loads the full record; ?fromIntern=<id> = Convert to Employee
  EditEmployee:          { module: 'employees', component: lazy(() => import('@/features/employees/pages/EditEmployee')),       props: ctx => ({ employee: ctx.selectedEmployee, setPage: ctx.setPage, setSelectedEmployee: ctx.setSelectedEmployee }) },

  // ── Internships ─────────────────────────────────────────────────────────
  // A separate workforce population (own table, INTxxx codes). `module:
  // 'internships'` — NOT 'employees', which `employee` and `manager` both hold:
  // gating on it would open every intern's personal data to them. Registered by
  // hand so the gate is explicit rather than inferred from the folder. The
  // selected intern travels as `?id=` in the URL, so View/Edit survive refresh.
  Internships:           { module: 'internships', component: lazy(() => import('@/features/internships/pages/Internships')), props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams }) },
  AddIntern:             { module: 'internships', component: lazy(() => import('@/features/internships/pages/AddIntern')),   props: ctx => ({ setPage: ctx.setPage }) },
  EditIntern:            { module: 'internships', component: lazy(() => import('@/features/internships/pages/EditIntern')),  props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams }) },
  ViewIntern:            { module: 'internships', component: lazy(() => import('@/features/internships/pages/ViewIntern')),  props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams }) },
  // The MENTOR's page. Deliberately NO `module`: a mentor holds no internships
  // permission and must not be given one. The API decides access by identity
  // (the intern's current mentor), and the page shows a non-mentor a notice, no
  // data. Listed in PERSONAL_PAGES so a mentor in ANY role can open it; the menu
  // entry is `mentorOnly` (see NAV_ITEMS).
  MyInternEvaluations:   { component: lazy(() => import('@/features/internships/pages/MyInternEvaluations')) },
  // Department heads' probation reviews. Registered manually WITHOUT a module so
  // the auto-router's folder default (features/hr → module 'hr') cannot apply:
  // department heads hold no hr permission and must still reach it. The entry
  // is `probationReviewerOnly` (see NAV_ITEMS); the API decides what is shown.
  MyProbationReviews:    { component: lazy(() => import('@/features/hr/pages/MyProbationReviews')) },
  // Open to every role (PERSONAL_PAGES, no module): the bell's destination for
  // an announcement. The API returns only what is addressed to the caller.
  MyAnnouncements:       { component: lazy(() => import('@/features/hr/pages/MyAnnouncements')) },

  // ── HR ────────────────────────────────────────────────────────────────────
  // Hub pages — merged submenus
  // PC-01 closure: the payroll pages are payroll:view, as their APIs are (Form 24Q:
  // payroll_tds_extract:export). Layout refuses the URL and Sidebar drops the row.
  PayrollCenter:            { module: 'payroll', component: lazy(() => import('@/features/hr/pages/PayrollCenter')),              props: ctx => ({ setPage: ctx.setPage }) },
  SuccessionCenter:         { module: 'succession', component: lazy(() => import('@/features/hr/pages/SuccessionCenter')) },

  PayrollSettings:       { module: 'payroll', component: lazy(() => import('@/features/hr/pages/PayrollSettings')),           props: ctx => ({ setPage: ctx.setPage }) },
  PayrollForm16:         { module: 'payroll', component: lazy(() => import('@/features/hr/pages/PayrollForm16')),              props: ctx => ({ setPage: ctx.setPage }) },
  PayrollForm24Q:        { module: 'payroll_tds_extract', moduleActions: ['export'], component: lazy(() => import('@/features/hr/pages/PayrollForm24Q')),             props: ctx => ({ setPage: ctx.setPage }) },
  Announcements:         { component: lazy(() => import('@/features/hr/pages/Announcements')) },
  BiometricAccess:       { component: lazy(() => import('@/features/hr/pages/BiometricAccess')) },
  Downloads:             { component: lazy(() => import('@/features/hr/pages/Downloads')) },
  EmployeeDirectory:     { component: lazy(() => import('@/features/hr/pages/EmployeeDirectory')) },
  // The HR register across employees (§207). Everyone's OWN documents live in
  // Self Service → Document Vault, so the register is for employee_documents
  // holders only — the gate also hides the Employee Records tab (TabHub).
  EmployeeDocuments:     { component: lazy(() => import('@/features/hr/pages/EmployeeDocuments')), module: 'employee_documents' },
  EmployeeSelfService:   { component: lazy(() => import('@/features/hr/pages/EmployeeSelfService')), props: ctx => ({ setPage: ctx.setPage }) },
  // Reviewer side of Self-Service IT declarations (§203); the matrix grant decides.
  ITDeclarationReview:   { component: lazy(() => import('@/features/hr/pages/ITDeclarationReview')), module: 'it_declarations' },
  // Checker side of the bank-detail maker-checker (§204); the matrix grant decides.
  BankChangeApprovals:   { component: lazy(() => import('@/features/hr/pages/BankChangeApprovals')), module: 'employee_bank', moduleActions: ['view', 'add'] },
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
  Payroll:               { module: 'payroll', component: lazy(() => import('@/features/hr/pages/Payroll')), props: ctx => ({ setPage: ctx.setPage }) },
  PayslipGenerator:      { module: 'payroll', component: lazy(() => import('@/features/hr/pages/PayslipGenerator')) },
  PayslipViewer:         { component: lazy(() => import('@/features/hr/pages/PayslipViewer')) },
  Policies:              { component: lazy(() => import('@/features/hr/pages/Policies')) },
  Probation:             { component: lazy(() => import('@/features/hr/pages/Probation')) },
  SalaryStructure:       { module: 'payroll', component: lazy(() => import('@/features/hr/pages/SalaryStructure')) },
  SuccessionPlanning:        { module: 'succession', component: lazy(() => import('@/features/hr/pages/SuccessionPlanning')) },
  LeadershipPipeline:        { module: 'succession', component: lazy(() => import('@/features/hr/pages/LeadershipPipeline')) },
  DevelopmentPlans:          { module: 'succession', component: lazy(() => import('@/features/hr/pages/DevelopmentPlans')) },
  EmployeeSuccessionPools:   { module: 'succession', component: lazy(() => import('@/features/hr/pages/EmployeeSuccessionPools')) },
  SuccessionReports:         { module: 'succession', component: lazy(() => import('@/features/hr/pages/SuccessionReports')) },
  SuccessionSettings:        { module: 'succession', component: lazy(() => import('@/features/hr/pages/SuccessionSettings')), props: ctx => ({ setPage: ctx.setPage }) },
  SkillMatrix:               { component: lazy(() => import('@/features/hr/pages/SkillMatrix')), props: ctx => ({ setPage: ctx.setPage }) },
  // hr:view — every number on the page comes from GET /analytics/workforce, which
  // requires it. Drill-through additionally checks employees:view in the page.
  EmployeeReports:       { module: 'hr', component: lazy(() => import('@/features/hr/pages/EmployeeReports')), props: ctx => ({ setPage: ctx.setPage }) },
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
  // Needs setPage: its header has a "Financial Reports" button. Without the
  // prop the optional call silently no-ops and the click does nothing at all,
  // with a clean console — the page looks fine and the link is simply dead.
  FinancialStatements:   { module: 'finance', component: lazy(() => import('@/features/finance/pages/FinancialStatements')),  props: ctx => ({ setPage: ctx.setPage }) },
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
  SupplierPerformanceIndex: { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/SupplierPerformanceIndex')) },
  SourcingStrategy:         { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/SourcingStrategy')) },
  RfxEvaluation:            { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/RfxEvaluation')) },
  SupplierCapacity:         { module: 'procurement', component: lazy(() => import('@/features/procurement/pages/SupplierCapacity')) },
  VendorRegistration:       { public: true,          component: lazy(() => import('@/features/procurement/pages/VendorRegistration')) },

  // ── Inventory ────────────────────────────────────────────────────────────
  InventoryDashboard:        { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/InventoryDashboard')),        props: ctx => ({ setPage: ctx.setPage }) },
  AdvancedInventoryDashboard:{ module: 'inventory', component: lazy(() => import('@/features/inventory/pages/AdvancedInventoryDashboard')), props: ctx => ({ setPage: ctx.setPage }) },
  BatchTracking:             { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/BatchTracking')),             props: ctx => ({ setPage: ctx.setPage }) },
  InventoryIntelligence:     { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/InventoryIntelligence')) },
  InventoryReport:           { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/InventoryReport')) },
  ItemMaster:                { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/ItemMaster')),                props: ctx => ({ setPage: ctx.setPage }) },
  // Component 360 — reached by clicking a row in Item Master (/ItemDetail?id=).
  // Detail page, deliberately not in NAV_ITEMS: being a manual ROUTES key keeps
  // it out of the orphan-nav group too (see autoRouter.js).
  ItemDetail:                { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/ItemDetail')) },
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
  // Supply-chain planning workspace. Every one of these drove a backend
  // capability that was built, mounted and unreachable — the forecast could not
  // be approved, the planning parameters could not be inspected, and the service
  // level nobody could see was computed on every request.
  DemandPlanning:            { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/DemandPlanning')) },
  InventoryPlanningParameters:{ module: 'inventory', component: lazy(() => import('@/features/inventory/pages/InventoryPlanningParameters')) },
  InventoryHealth:           { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/InventoryHealth')) },
  KanbanLoops:               { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/KanbanLoops')) },
  WarehouseOperations:       { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/WarehouseOperations')) },
  ServiceLevelDashboard:     { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/ServiceLevelDashboard')) },
  ReturnsRMA:                { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/ReturnsRMA')) },
  RoutePlanning:             { module: 'inventory', component: lazy(() => import('@/features/inventory/pages/RoutePlanning')) },

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
  ComponentTrace:        { module: 'production', component: lazy(() => import('@/features/production/pages/ComponentTrace')) },
  BOMModeling:           { module: 'production', component: lazy(() => import('@/features/production/pages/BOMModeling')) },
  SOPPlanning:           { module: 'production', component: lazy(() => import('@/features/production/pages/SOPPlanning')) },
  ScenarioPlanning:      { module: 'production', component: lazy(() => import('@/features/production/pages/ScenarioPlanning')) },
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
  WebLeadForms:          { component: lazy(() => import('@/features/crm/pages/WebLeadForms')) },
  MarketingJourneys:     { component: lazy(() => import('@/features/crm/pages/MarketingJourneys')) },
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
  ForecastCommit:        { component: lazy(() => import('@/features/sales/pages/ForecastCommit')) },
  DealRegistrations:     { component: lazy(() => import('@/features/sales/pages/DealRegistrations')) },
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

  // ── Recruitment (merged with former Talent module 2026-07-28) ─────────────
  // Every entry below carries `module: 'recruitment'`. None of them used to.
  // Layout.jsx applies two route-level gates: the NAV-section allowlist, which
  // returns TRUE for any page that appears in no NAV_ITEMS row, and
  // `if (route.module)`, which is skipped entirely when the route declares no
  // module. Nine of these pages (ResumeDatabase, AllCandidates, CandidateDetail,
  // CandidatePipeline, TalentPools, TalentPoolDetail, RecruitmentAgencies,
  // JobOpenings, JobRequisitionPipeline) are reachable only as hub tabs and so
  // have no NAV row — which meant BOTH gates passed and any authenticated role
  // could open the candidate database by direct navigation. The module key is
  // the gate that does not depend on a page having a sidebar entry.
  RecruitmentSettings:   { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/RecruitmentSettings')), props: ctx => ({ setPage: ctx.setPage }) },
  CareersPageAdmin:      { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/CareersPageAdmin')), props: ctx => ({ setPage: ctx.setPage }) },
  RecruitmentDashboard:  { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/RecruitmentDashboard')), props: ctx => ({ setPage: ctx.setPage }) },
  // Jobs/Sourcing are tab containers (see Candidates below for the same
  // pattern). The pages they wrap keep their own route entries so existing
  // setPage('JobOpenings')-style calls and deep links stay valid.
  Jobs:                  { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/Jobs')),                  props: ctx => ({ setPage: ctx.setPage }) },
  Sourcing:              { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/Sourcing')),              props: ctx => ({ setPage: ctx.setPage }) },
  JobRequisitionPipeline:{ module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/JobRequisitionPipeline')) },
  JobOpenings:           { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/JobOpenings')),           props: ctx => ({ setPage: ctx.setPage }) },
  Candidates:            { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/Candidates')),         props: ctx => ({ setPage: ctx.setPage }) },
  CandidatePipeline:     { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/CandidatePipeline')),     props: ctx => ({ setPage: ctx.setPage }) },
  AllCandidates:         { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/AllCandidates')),      props: ctx => ({ setPage: ctx.setPage }) },
  // ── 2026-09-27 Recruitment redesign ──────────────────────────────────────
  // CandidateWorkbench replaces AllCandidates as the Candidates hub's list tab.
  // AllCandidates stays registered rather than being deleted: it is still a
  // working page, several audit/Playwright fixtures address it by name, and
  // keeping it means the rollout is reversible by changing one line in
  // Candidates.jsx instead of restoring a file.
  CandidateWorkbench:    { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/CandidateWorkbench')),  props: ctx => ({ setPage: ctx.setPage }) },
  CandidateScreening:    { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/CandidateScreening')),  props: ctx => ({ setPage: ctx.setPage }) },
  TalentBank:            { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/TalentBank')),          props: ctx => ({ setPage: ctx.setPage }) },
  RecruitmentWorkQueue:  { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/RecruitmentWorkQueue')), props: ctx => ({ setPage: ctx.setPage }) },
  CandidateDetail:       { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/CandidateDetail')),    props: ctx => ({ setPage: ctx.setPage }) },
  EmailTemplates:        { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/EmailTemplates')),     props: ctx => ({ setPage: ctx.setPage }) },
  HiringForecasts:       { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/HiringForecasts')) },
  InterviewScheduler:    { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/InterviewScheduler')), props: ctx => ({ setPage: ctx.setPage }) },
  InterviewQuestionBank: { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/InterviewQuestionBank')) },
  OfferManagement:       { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/OfferManagement')) },
  RecruitmentReports:    { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/RecruitmentReports')) },
  ResumeDatabase:        { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/ResumeDatabase')) },
  TalentPools:           { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/TalentPools')),      props: ctx => ({ setPage: ctx.setPage }) },
  TalentPoolDetail:      { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/TalentPoolDetail')), props: ctx => ({ setPage: ctx.setPage, urlParams: ctx.urlParams }) },
  RecruitmentAgencies:   { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/RecruitmentAgencies')) },
  RecruiterDashboard:    { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/RecruiterDashboard')), props: ctx => ({ setPage: ctx.setPage }) },
  // Registered manually rather than left to autoRouter. AUTO_ROUTES now derives
  // `module` from its folder config, so these would be gated either way — but
  // explicit beats inherited for the two pages that hold candidate feedback and
  // onboarding data, and it keeps them visible in this list beside their 25
  // siblings instead of only existing as a glob match.
  InterviewFeedback:     { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/InterviewFeedback')),  props: ctx => ({ setPage: ctx.setPage }) },
  OnboardingChecklist:   { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/OnboardingChecklist')), props: ctx => ({ setPage: ctx.setPage }) },

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
  SupportMailbox:        { component: lazy(() => import('@/features/servicedesk/pages/SupportMailbox')) },
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
  // servicedesk:view — the same grant the /lifecycle API requires, so a role
  // without it gets Access Denied here instead of an empty list.
  LifecycleTracker:       { module: 'servicedesk', component: lazy(() => import('@/features/operations/pages/LifecycleTracker')), props: ctx => ({ setPage: ctx.setPage, pageParams: ctx.pageParams }) },
  CommissioningReports:   { component: lazy(() => import('@/features/operations/pages/CommissioningReports')) },
  AMCManagement:          { component: lazy(() => import('@/features/operations/pages/AMCManagement')) },
  OperationsWarranty:     { component: lazy(() => import('@/features/operations/pages/WarrantyManagement')) },
  ServiceStockManagement: { component: lazy(() => import('@/features/servicedesk/pages/StockManagement')) },

  // ── Phase 51 — Customer Portal, Commissioning, Service Analytics ──────────
  CustomerPortalManagement: { component: lazy(() => import('@/features/servicedesk/pages/CustomerPortalManagement')) },
  CustomerPortalDashboard:  { component: lazy(() => import('@/features/servicedesk/pages/CustomerPortalDashboard')) },
  CommissioningWorkflow:    { component: lazy(() => import('@/features/servicedesk/pages/CommissioningWorkflow')) },
  InstallationRequests:     { component: lazy(() => import('@/features/servicedesk/pages/InstallationRequests')) },
  ServiceAnalytics:         { component: lazy(() => import('@/features/servicedesk/pages/ServiceAnalytics')) },
  FailureAnalytics:         { component: lazy(() => import('@/features/servicedesk/pages/FailureAnalytics')) },
  VoiceOfCustomer:          { component: lazy(() => import('@/features/servicedesk/pages/VoiceOfCustomer')) },
  EmployeeAutoCreation:     { module: 'recruitment', component: lazy(() => import('@/features/recruitment/pages/EmployeeAutoCreation')) },

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
// Icons are the ONLY thing distinguishing menus in the 70px collapsed rail —
// the label is invisible until hover. So they have to survive at 17px with no
// text: no two top-level icons may be near-identical silhouettes (FaCog vs
// FaCogs was exactly that, on Settings vs Operations), and each should read as
// its domain rather than a neighbouring one (FaFlask reads laboratory, not
// factory; FaChartLine on Finance reads analytics, which is a different band).
import {
  FaHome, FaClipboardCheck,
  FaRobot, FaFileAlt,
  FaHandshake, FaFileInvoiceDollar, FaBullhorn,
  FaProjectDiagram, FaStream, FaExclamationCircle, FaHeadset,
  FaShoppingCart, FaBox, FaIndustry, FaShieldAlt, FaWrench,
  FaBroadcastTower, FaFlask, FaBalanceScale, FaTags,
  FaRupeeSign,
  FaUsers, FaUserTie, FaBriefcase, FaGraduationCap, FaCalendarCheck,
  FaUmbrellaBeach, FaClock, FaTrophy, FaPlane, FaSitemap, FaAddressBook,
  FaFileSignature, FaQrcode,
  FaCog, FaHistory,
} from 'react-icons/fa';

// Top-level items are ordered by business domain and separated by `divider`
// band labels (Sidebar.jsx renders them as a hairline when collapsed and a
// small caps heading when expanded; a band whose every menu is hidden for the
// viewer's role is dropped, so no role ever sees an empty heading).
//
// IMPORTANT — two ordering constraints that are load-bearing, not cosmetic:
//  1. Group `name` values are permission keys. They are matched verbatim by
//     ROLE_SECTION_ALLOWLIST (menuCatalog.js) and stored as `module_id` in the
//     menu_permissions / user_menu_permissions tables that back the admin's
//     Page Access screen. Reorder freely; renaming one silently orphans every
//     saved override for it.
//  2. 'Complaints' should stay immediately BEFORE 'Service Desk' — they are
//     two halves of one loop and read as a pair in the rail.
//     CustomerComplaintsIPCS used to be registered under BOTH groups (the only
//     duplicate row in this file), which made its permission section depend on
//     that array order. The Service Desk copy was removed 2026-09-16: the page
//     now lives only under 'Complaints', so getSectionForPage() is unambiguous
//     and ROLE_SECTION_ALLOWLIST no longer rides on the ordering. Every role
//     holding 'Service Desk' (department_head, service_manager,
//     service_engineer) also holds 'Complaints', so nobody lost the register.
//
// Within a submenu the house order is: overview → daily transactions →
// approvals/queues → analysis & reports → masters/settings, with `separator`
// rows breaking up anything past ~8 items and self-service ("My …") pages
// grouped at the top of the shared HR/Attendance/Leaves/Timesheets menus.
export const NAV_ITEMS = [
  // ── Workspace ─────────────────────────────────────────────────────────────
  { name: 'Home',               icon: <FaHome />,              page: 'Home' },
  // ONE entry for everyone (ALWAYS_VISIBLE, menuCatalog.js): every user has
  // "My Requests", and the page shows the approver tabs only to people who
  // approve something. My Requests / Approval History are tabs, not rows.
  { name: 'Approvals', icon: <FaClipboardCheck />, page: 'ApprovalCenter', module: 'approvals' },
  // No 'Notifications' row: the Topbar bell is the entry point ("View all
  // notifications →" opens NotificationCenter, which is ALWAYS_VISIBLE in
  // menuCatalog.js, so access is unchanged).
  // No 'My Intern Evaluations' / 'My Probation Reviews' rows: they sit under
  // Home's My Pending Approvals card ("My reviews"), drawn for a current
  // mentor / department head (and admins) from the /mine/summary endpoints.
  // Both stay in PERSONAL_PAGES (menuCatalog.js), so the bell and direct URLs
  // still open them. Sidebar.jsx still honours `mentorOnly` /
  // `probationReviewerOnly` should a row ever come back.

  { divider: true, section: 'Insights' },

  { name: 'Analytics & AI', icon: <FaRobot />, submenu: [
    { name: 'Executive',           separator: true },
    { name: 'CEO Intelligence',    page: 'CEOIntelligenceDashboard' },
    { name: 'Executive Dashboard', page: 'ExecutiveDashboard' },
    { name: 'Ops Command Center',  page: 'AdminDashboard' },
    { name: 'Functional',          separator: true },
    { name: 'CFO Dashboard',       page: 'CFODashboard' },
    { name: 'HR Dashboard',        page: 'HRDashboard' },
    { name: 'HR Benchmarking',     page: 'HRBenchmarkingDashboard' },
    { name: 'Platform',            separator: true },
    { name: 'Dashboard Builder',   page: 'DashboardBuilder' },
    { name: 'ERP Intelligence',    page: 'ERPIntelligence' },
    { name: 'System Health',       page: 'SystemHealth' },
  ]},

  { name: 'Reports', icon: <FaFileAlt />, module: 'reports', submenu: [
    { name: 'Report Builder',      page: 'Reports' },
    { name: 'Saved Reports',       page: 'SavedReports' },
  ]},

  { divider: true, section: 'Revenue' },

  { name: 'CRM', icon: <FaHandshake />, submenu: [
    { name: 'Dashboard',                 page: 'SalesDashboard' },
    { name: 'IEM — Enquiries',           page: 'Leads' },
    { name: 'Opportunities',             page: 'OpportunitiesKanban' },
    { name: 'Pursuits',                  page: 'Pursuits' },
    { name: 'Tenders',                   page: 'TenderWorkspace' },
    { name: 'Customers',                 separator: true },
    { name: 'Customers',                 page: 'CRMCustomers' },   // Accounts·Contacts·Customer 360·Health Engine
    { name: 'Engagement',                separator: true },
    { name: 'Activities',                page: 'CRMActivities' },
    { name: 'CRM Email',                 page: 'CRMEmail' },
    { name: 'Analysis & Setup',          separator: true },
    { name: 'Analysis & Automation',     page: 'CRMInsights' },   // Won/Lost·Web forms·Reports·Pipeline automation
    { name: 'Settings',                  page: 'CRMSettings' },

    // ── Consolidated into the hubs above (2026-09-16 IA pass) ──────────
    // These rows are NOT drawn in the sidebar — Sidebar.jsx skips any entry
    // carrying `inHub`. They stay here because getSectionForPage() walks
    // NAV_ITEMS: drop them and each page silently becomes section-less,
    // which makes canRoleAccessPageBySection wave it through for every
    // role. Keeping them preserves the section gate exactly, and TabHub
    // re-checks each tab with canRoleOpenPage() before drawing it.
    { name: 'Accounts',                  page: 'Accounts', inHub: 'CRMCustomers' },
    { name: 'Contacts',                  page: 'Contacts', inHub: 'CRMCustomers' },
    { name: 'Customer360',               page: 'Customer360', inHub: 'CRMCustomers' },
    { name: 'CustomerHealthDashboard',   page: 'CustomerHealthDashboard', inHub: 'CRMCustomers' },
    { name: 'WonLostLeads',              page: 'WonLostLeads', inHub: 'CRMInsights' },
    { name: 'WebLeadForms',              page: 'WebLeadForms', inHub: 'CRMInsights' },
    { name: 'CRMReports',                page: 'CRMReports', inHub: 'CRMInsights' },
    { name: 'PipelineAutomation',        page: 'PipelineAutomation', inHub: 'CRMInsights' },
  ]},

  { name: 'Sales', icon: <FaFileInvoiceDollar />, submenu: [
    { name: 'Command Center',            page: 'SalesCommandCenter' },
    { name: 'Sell',                      separator: true },
    { name: 'Quotations',                page: 'Quotations' },
    { name: 'Sales Orders',              page: 'SalesOrders' },
    { name: 'Pricing Engine',            page: 'PricingEngine' },
    { name: 'Fulfilment',                page: 'FulfilmentTracking' },
    { name: 'Subscriptions',             page: 'Subscriptions' },
    { name: 'Plan & Perform',            separator: true },
    { name: 'Targets & Commission',      page: 'SalesPerformance' },   // Targets·Commission
    { name: 'Intelligence',              page: 'SalesIntelligence' },
    { name: 'Market Presence',           page: 'SalesMarket' },
    { name: 'Deal Registration',         page: 'DealRegistrations' },
    { name: 'Enablement & Setup',        separator: true },
    { name: 'Enablement',                page: 'SalesEnablement' },   // Playbooks·Calendar·Documents
    { name: 'Settings',                  page: 'SalesSettings' },

    // ── Consolidated into the hubs above (2026-09-16 IA pass) ──────────
    // These rows are NOT drawn in the sidebar — Sidebar.jsx skips any entry
    // carrying `inHub`. They stay here because getSectionForPage() walks
    // NAV_ITEMS: drop them and each page silently becomes section-less,
    // which makes canRoleAccessPageBySection wave it through for every
    // role. Keeping them preserves the section gate exactly, and TabHub
    // re-checks each tab with canRoleOpenPage() before drawing it.
    { name: 'SalesTargets',              page: 'SalesTargets', inHub: 'SalesPerformance' },
    { name: 'CommissionManagement',      page: 'CommissionManagement', inHub: 'SalesPerformance' },
    { name: 'SalesPlaybooks',            page: 'SalesPlaybooks', inHub: 'SalesEnablement' },
    { name: 'SalesCalendar',             page: 'SalesCalendar', inHub: 'SalesEnablement' },
    { name: 'SalesDocuments',            page: 'SalesDocuments', inHub: 'SalesEnablement' },
  ]},

  { name: 'Marketing', icon: <FaBullhorn />, submenu: [
    { name: 'Dashboard',       page: 'MarketingDashboard' },
    { name: 'Campaigns',       page: 'Campaigns' },
    { name: 'Pursuit List',    page: 'PursuitList' },
    { name: 'Execution',       separator: true },
    { name: 'Assign Tasks',    page: 'AssignTasks' },
    { name: 'Delivery Tracker',page: 'DeliveryTracker' },
    { name: 'Timesheet Entry', page: 'TimesheetEntry' },
    { name: 'Journeys',        page: 'MarketingJourneys' },   // nurture sequences that actually run
    { name: 'Analysis & Setup', separator: true },
    { name: 'Analytics',       page: 'MarketingAnalytics' },  // Campaign·Won/Lost·Performance
    { name: 'Settings',        page: 'MarketingSettings' },
  ]},

  { divider: true, section: 'Delivery' },

  { name: 'Projects', icon: <FaProjectDiagram />, module: 'projects', submenu: [
    { name: 'Dashboard',                 page: 'ProjectsDashboard' },
    { name: 'Projects',                  page: 'Projects' },
    { name: 'Project 360°',              page: 'Project360' },
    { name: 'Delivery',                  separator: true },
    { name: 'Delivery Boards',           page: 'ProjectBoards' },   // Project Master·Pipeline·Task board·Gantt·Installation
    { name: 'Control',                   separator: true },
    { name: 'Resource Management',       page: 'ResourceManagement' },
    { name: 'Issue Management',          page: 'IssueManagement' },
    { name: 'Lifecycle',                 page: 'ProjectLifecycleHub' },
    { name: 'Financials',                page: 'ProjectFinancialsHub' },
    { name: 'Insights & Setup',          separator: true },
    { name: 'CEO Command Center',        page: 'CEOCommandCenter' },
    { name: 'Project Reports',           page: 'ProjectReports' },
    { name: 'Settings',                  page: 'ProjectSettings' },

    // ── Consolidated into the hubs above (2026-09-16 IA pass) ──────────
    // These rows are NOT drawn in the sidebar — Sidebar.jsx skips any entry
    // carrying `inHub`. They stay here because getSectionForPage() walks
    // NAV_ITEMS: drop them and each page silently becomes section-less,
    // which makes canRoleAccessPageBySection wave it through for every
    // role. Keeping them preserves the section gate exactly, and TabHub
    // re-checks each tab with canRoleOpenPage() before drawing it.
    { name: 'ProductionDeliveryTracker', page: 'ProductionDeliveryTracker', inHub: 'ProjectBoards' },
    { name: 'ProjectPipelineBoard',      page: 'ProjectPipelineBoard', inHub: 'ProjectBoards' },
    { name: 'KanbanBoard',               page: 'KanbanBoard', inHub: 'ProjectBoards' },
    { name: 'GanttChart',                page: 'GanttChart', inHub: 'ProjectBoards' },
    { name: 'InstallationDashboard',     page: 'InstallationDashboard', inHub: 'ProjectBoards' },
  ]},

  { name: 'Operations', icon: <FaStream />, submenu: [
    { name: 'Workflow Center',   page: 'WorkflowCenter' },          // Board·Configuration
    { name: 'Project Tracker',   page: 'ProjectWorkflowTracker' },
    { name: 'Lifecycle Tracker', page: 'LifecycleTracker', module: 'servicedesk' },
    { name: 'Post-Delivery',     page: 'OperationsLifecycleHub' },  // Commissioning·AMC·Warranty
    { name: 'Analytics',         separator: true },
    { name: 'Dept Workload',     page: 'DepartmentWorkload' },
    { name: 'Bottlenecks',       page: 'BottleneckAnalytics' },
  ]},

  // The complaint half of the complaint -> service-ticket loop. Sits directly
  // above 'Service Desk' so the pair reads as one workflow — see the ordering
  // note above for why the register no longer also appears inside Service Desk.
  { name: 'Complaints', icon: <FaExclamationCircle />, submenu: [
    { name: 'Dashboard',           page: 'ComplaintsDashboard' },
    { name: 'Complaint Register',  page: 'CustomerComplaintsIPCS' },
  ]},

  { name: 'Service Desk', icon: <FaHeadset />, module: 'servicedesk', submenu: [
    { name: 'Dashboard',                 page: 'SupportDashboard' },
    { name: 'Tickets',                   separator: true },
    { name: 'My Tickets',                page: 'MyTickets' },
    { name: 'All Tickets',               page: 'AllTickets' },
    { name: 'SLA Management',            page: 'SLAManagement' },
    { name: 'Agent Workload',            page: 'AgentWorkload' },
    { name: 'Field & Site',              separator: true },
    { name: 'My Field Jobs',             page: 'EngineerHome' },
    { name: 'Field Operations',          page: 'ServiceFieldCenter' },   // Visits·Engineers·Installation·Commissioning·Delivery·Spares
    { name: 'Customers',                 separator: true },
    { name: 'Customers & Contracts',     page: 'ServiceCustomerCenter' },   // Portal·Contracts·Warranty
    { name: 'Reviews',                   page: 'ServiceReviews' },
    { name: 'Insights & Setup',          separator: true },
    { name: 'Catalog & Knowledge',       page: 'ServiceCatalogCenter' },   // IPS·Rate card·KB·Email to case
    { name: 'Intelligence',              page: 'ServiceIntelligence' },
    { name: 'Settings',                  page: 'ServiceDeskSettings' },

    // ── Consolidated into the hubs above (2026-09-16 IA pass) ──────────
    // These rows are NOT drawn in the sidebar — Sidebar.jsx skips any entry
    // carrying `inHub`. They stay here because getSectionForPage() walks
    // NAV_ITEMS: drop them and each page silently becomes section-less,
    // which makes canRoleAccessPageBySection wave it through for every
    // role. Keeping them preserves the section gate exactly, and TabHub
    // re-checks each tab with canRoleOpenPage() before drawing it.
    { name: 'FieldVisitScheduler',       page: 'FieldVisitScheduler', inHub: 'ServiceFieldCenter' },
    { name: 'ServiceEngineers',          page: 'ServiceEngineers', inHub: 'ServiceFieldCenter' },
    { name: 'InstallationRequests',      page: 'InstallationRequests', inHub: 'ServiceFieldCenter' },
    { name: 'CommissioningWorkflow',     page: 'CommissioningWorkflow', inHub: 'ServiceFieldCenter' },
    { name: 'DeliveryNote',              page: 'DeliveryNote', inHub: 'ServiceFieldCenter' },
    { name: 'ServiceStockManagement',    page: 'ServiceStockManagement', inHub: 'ServiceFieldCenter' },
    { name: 'CustomerPortalManagement',  page: 'CustomerPortalManagement', inHub: 'ServiceCustomerCenter' },
    { name: 'ServiceContracts',          page: 'ServiceContracts', inHub: 'ServiceCustomerCenter' },
    { name: 'OperationsWarranty',        page: 'OperationsWarranty', inHub: 'ServiceCustomerCenter' },
    { name: 'ServiceMasterIPS',          page: 'ServiceMasterIPS', inHub: 'ServiceCatalogCenter' },
    { name: 'ServiceMaster',             page: 'ServiceMaster', inHub: 'ServiceCatalogCenter' },
    { name: 'KnowledgeBase',             page: 'KnowledgeBase', inHub: 'ServiceCatalogCenter' },
    { name: 'SupportMailbox',            page: 'SupportMailbox', inHub: 'ServiceCatalogCenter' },
  ]},

  { divider: true, section: 'Supply Chain' },

  { name: 'Procurement', icon: <FaShoppingCart />, module: 'procurement', submenu: [
    { name: 'Purchase Requests',         page: 'PurchaseRequestDashboard' },
    { name: 'PO Management',             page: 'PurchaseOrderManagement' },
    { name: 'Purchase Orders',           page: 'PurchaseOrders' },
    { name: 'Goods Receipt',             page: 'GoodsReceipt' },
    { name: 'Quality Inspection',        page: 'QualityInspection' },
    { name: 'Vendors & Planning',        separator: true },
    { name: 'Vendor Center',             page: 'VendorCenter' },
    { name: 'Sourcing & Strategy',       page: 'SourcingCenter' },   // Strategy·RFx·Capacity·Performance·Development
    { name: 'MRP Planning',              page: 'MRPPlanning' },
    { name: 'Reports & Setup',           separator: true },
    { name: 'Reports',                   page: 'ProcurementReports' },
    { name: 'Settings',                  page: 'ProcurementSettings' },

    // ── Consolidated into the hubs above (2026-09-16 IA pass) ──────────
    // These rows are NOT drawn in the sidebar — Sidebar.jsx skips any entry
    // carrying `inHub`. They stay here because getSectionForPage() walks
    // NAV_ITEMS: drop them and each page silently becomes section-less,
    // which makes canRoleAccessPageBySection wave it through for every
    // role. Keeping them preserves the section gate exactly, and TabHub
    // re-checks each tab with canRoleOpenPage() before drawing it.
    { name: 'SupplierPerformanceIndex',  page: 'SupplierPerformanceIndex', inHub: 'SourcingCenter' },
    { name: 'SupplierDevelopment',       page: 'SupplierDevelopment', inHub: 'SourcingCenter' },
    { name: 'SourcingStrategy',          page: 'SourcingStrategy', inHub: 'SourcingCenter' },
    { name: 'RfxEvaluation',             page: 'RfxEvaluation', inHub: 'SourcingCenter' },
    { name: 'SupplierCapacity',          page: 'SupplierCapacity', inHub: 'SourcingCenter' },
  ]},

  { name: 'Inventory', icon: <FaBox />, module: 'inventory', submenu: [
    { name: 'Dashboard',                 page: 'InventoryDashboard' },
    { name: 'Advanced Dashboard',        page: 'AdvancedInventoryDashboard' },
    { name: 'Operations',                separator: true },
    { name: 'Stock Control',             page: 'StockControl' },   // Summary·Movements·Reservations·Consumption·Batch·Serial·Alerts
    { name: 'Warehouse & Stores',        page: 'WarehouseCenter' },   // Warehouse·Operations·Stores·Cost·Inbound Quality
    { name: 'Logistics & Returns',       page: 'LogisticsCenter' },   // Shipping·Routes·RMA
    { name: 'Plan & Analyse',            separator: true },
    { name: 'Planning',                  page: 'InventoryPlanning' },   // Demand·Parameters·Health·Kanban
    { name: 'Insights & Reports',        page: 'InventoryInsights' },   // Service Level·Intel·Report
    { name: 'Masters & Setup',           separator: true },
    { name: 'Item Master',               page: 'ItemMaster' },
    { name: 'Component Pricing',         page: 'VendorPriceComparison' },
    { name: 'Settings',                  page: 'InventorySettings' },

    // ── Consolidated into the hubs above (2026-09-16 IA pass) ──────────
    // These rows are NOT drawn in the sidebar — Sidebar.jsx skips any entry
    // carrying `inHub`. They stay here because getSectionForPage() walks
    // NAV_ITEMS: drop them and each page silently becomes section-less,
    // which makes canRoleAccessPageBySection wave it through for every
    // role. Keeping them preserves the section gate exactly, and TabHub
    // re-checks each tab with canRoleOpenPage() before drawing it.
    { name: 'StockSummary',              page: 'StockSummary', inHub: 'StockControl' },
    { name: 'StockMovements',            page: 'StockMovements', inHub: 'StockControl' },
    { name: 'StockReservations',         page: 'StockReservations', inHub: 'StockControl' },
    { name: 'MaterialConsumption',       page: 'MaterialConsumption', inHub: 'StockControl' },
    { name: 'BatchTracking',             page: 'BatchTracking', inHub: 'StockControl' },
    { name: 'SerialTracking',            page: 'SerialTracking', inHub: 'StockControl' },
    { name: 'StockAlertsAndSuggestions', page: 'StockAlertsAndSuggestions', inHub: 'StockControl' },
    { name: 'DemandPlanning',            page: 'DemandPlanning', inHub: 'InventoryPlanning' },
    { name: 'InventoryPlanningParameters', page: 'InventoryPlanningParameters', inHub: 'InventoryPlanning' },
    { name: 'InventoryHealth',           page: 'InventoryHealth', inHub: 'InventoryPlanning' },
    { name: 'KanbanLoops',               page: 'KanbanLoops', inHub: 'InventoryPlanning' },
    { name: 'WarehouseManagement',       page: 'WarehouseManagement', inHub: 'WarehouseCenter' },
    { name: 'WarehouseOperations',       page: 'WarehouseOperations', inHub: 'WarehouseCenter' },
    { name: 'StoresDashboard',           page: 'StoresDashboard', inHub: 'WarehouseCenter' },
    { name: 'StoresCostAnalysis',        page: 'StoresCostAnalysis', inHub: 'WarehouseCenter' },
    { name: 'LogisticsShipping',         page: 'LogisticsShipping', inHub: 'LogisticsCenter' },
    { name: 'RoutePlanning',             page: 'RoutePlanning', inHub: 'LogisticsCenter' },
    { name: 'ReturnsRMA',                page: 'ReturnsRMA', inHub: 'LogisticsCenter' },
    { name: 'QualityManagement',         page: 'QualityManagement', inHub: 'WarehouseCenter' },
    { name: 'ServiceLevelDashboard',     page: 'ServiceLevelDashboard', inHub: 'InventoryInsights' },
    { name: 'InventoryIntelligence',     page: 'InventoryIntelligence', inHub: 'InventoryInsights' },
    { name: 'InventoryReport',           page: 'InventoryReport', inHub: 'InventoryInsights' },
  ]},

  { name: 'Production', icon: <FaIndustry />, module: 'production', submenu: [
    { name: 'Production Dashboard',      page: 'ProductionDashboard' },
    { name: 'Execution',                 separator: true },
    { name: 'Module Batch Requests',     page: 'ProductionModuleRequests' },
    { name: 'Module Production Batches', page: 'ProductionOrders' },
    { name: 'Shop Floor',                page: 'ShopFloor' },
    { name: 'Subcontracting',            page: 'SubcontractOrders' },
    { name: 'Batch Genealogy',           page: 'GenealogyTrace' },
    { name: 'Component Traceability',    page: 'ComponentTrace' },
    { name: 'Plan & Engineer',           separator: true },
    { name: 'Planning',                  page: 'ProductionPlanningHub' },   // MRP·CRP·S&OP·Scenario·Work Centre
    { name: 'BOM Management',            page: 'BOMCenter' },   // Builder·Modeling·Upload
    { name: 'Setup',                     separator: true },
    { name: 'Settings',                  page: 'ProductionSettings' },

    // ── Consolidated into the hubs above (2026-09-16 IA pass) ──────────
    // These rows are NOT drawn in the sidebar — Sidebar.jsx skips any entry
    // carrying `inHub`. They stay here because getSectionForPage() walks
    // NAV_ITEMS: drop them and each page silently becomes section-less,
    // which makes canRoleAccessPageBySection wave it through for every
    // role. Keeping them preserves the section gate exactly, and TabHub
    // re-checks each tab with canRoleOpenPage() before drawing it.
    { name: 'MRPWorkbench',              page: 'MRPWorkbench', inHub: 'ProductionPlanningHub' },
    { name: 'CRPWorkbench',              page: 'CRPWorkbench', inHub: 'ProductionPlanningHub' },
    { name: 'SOPPlanning',               page: 'SOPPlanning', inHub: 'ProductionPlanningHub' },
    { name: 'ScenarioPlanning',          page: 'ScenarioPlanning', inHub: 'ProductionPlanningHub' },
    { name: 'WorkCentrePlanning',        page: 'WorkCentrePlanning', inHub: 'ProductionPlanningHub' },
    { name: 'BOMBuilder',                page: 'BOMBuilder', inHub: 'BOMCenter' },
    { name: 'BOMModeling',               page: 'BOMModeling', inHub: 'BOMCenter' },
    { name: 'UploadBOM',                 page: 'UploadBOM', inHub: 'BOMCenter' },
  ]},

  { name: 'Quality', icon: <FaShieldAlt />, module: 'quality', submenu: [
    { name: 'Dashboard',             page: 'QualityDashboard' },
    { name: 'Control',               separator: true },
    { name: 'Inspection Center',     page: 'InspectionCenter' },
    { name: 'Material Tests',        page: 'MaterialQualityTests' },
    { name: 'NCR Management',        page: 'NCRManagement' },
    { name: 'CAPA Management',       page: 'CAPAManagement' },
    { name: 'Assurance',             separator: true },
    { name: 'FAT / SAT',             page: 'FATManagement' },
    { name: 'Supplier Quality',      page: 'SupplierQuality' },
    { name: 'Equipment Calibration', page: 'EquipmentCalibration' },
    { name: 'Reports & Setup',       separator: true },
    { name: 'Reports',               page: 'QualityReports' },
    { name: 'Settings',              page: 'QualitySettings' },
  ]},

  // Split out of 'Supply Chain' 2026-09-16. That band ran to nine menus once
  // the four promoted modules landed in it; Procurement -> Inventory ->
  // Production -> Quality is the material flow, and Engineering / R&D /
  // IoT / Compliance / Asset Register are the plant and asset side of the
  // same factory. Bands are display-only — they carry no pages and are
  // filtered out of getMenuSections(), so splitting one changes no gate.
  { divider: true, section: 'Engineering & Assets' },

  { name: 'Engineering', icon: <FaWrench />, module: 'engineering', submenu: [
    { name: 'Dashboard',           page: 'EngineeringDashboard' },
    { name: 'Development Register',page: 'EngineeringDev' },   // IPD design/development records
    { name: 'R&D Projects',        page: 'RDProjects' },
    { name: 'Prototype Tracker',   page: 'PrototypeTracker' },
    { name: 'Design Phases',       page: 'DesignPhases' },     // stage gates behind RDProjects/PrototypeTracker
    { name: 'Test Plans',          page: 'TestPlans' },
    { name: 'Change Notices (ECN)',page: 'ECNManagement' },
    { name: 'Power Quality',       page: 'PowerQualityAnalytics' },
  ]},

  // Promoted from an auto-discovered orphan group ('R&D · More') 2026-09-16.
  // Kept as its own section rather than folded into Engineering: of the five
  // roles that hold it, project_manager holds no 'Engineering' — folding would
  // have silently revoked the page for them. Name matches ROLE_SECTION_ALLOWLIST.
  { name: 'R&D', icon: <FaFlask />, module: 'rd', page: 'RDHub' },

  // Promoted from 'IoT Fleet · More' 2026-09-16 — seven real pages that never
  // got a curated entry, so they rendered as a generic "More" folder below
  // Administration and were invisible to the Page Access admin screen
  // (getMenuSections reads NAV_ITEMS only).
  { name: 'IoT Fleet', icon: <FaBroadcastTower />, module: 'iot', submenu: [
    { name: 'Fleet Monitor',       page: 'FleetMonitor' },
    { name: 'Equipment 360',       page: 'Equipment360' },
    { name: 'Alerts',              separator: true },
    { name: 'Alert Centre',        page: 'AlertCenter' },
    { name: 'Alert Rules',         page: 'AlertRules' },
    { name: 'Platform',            separator: true },
    { name: 'Metric & Device Registry', page: 'MetricRegistry' },
    { name: 'Hardware Pilots',     page: 'HardwarePilots' },
    { name: 'Platform Health',     page: 'IoTHealth' },
  ]},

  // Promoted from 'Compliance · More' / 'Asset Register · More' 2026-09-16.
  // Both stay standalone sections for the same reason as R&D above: their role
  // sets (hr holds both; qc_engineer holds Compliance; store_keeper/
  // procurement_* hold Asset Register) cut across Quality/Inventory, so there
  // is no parent menu that folds them in without revoking someone's access.
  { name: 'Compliance',     icon: <FaBalanceScale />, module: 'compliance', page: 'ComplianceRegister' },
  { name: 'Asset Register', icon: <FaTags />,         module: 'assets',     page: 'AssetRegister' },

  { divider: true, section: 'Finance' },

  { name: 'Finance', icon: <FaRupeeSign />, module: 'finance', submenu: [
    { name: 'Finance Dashboard',         page: 'FinanceDashboardNew' },
    { name: 'Transactions',              separator: true },
    { name: 'Receivables',               page: 'ReceivablesPage' },
    { name: 'Payables',                  page: 'PayablesPage' },
    { name: 'Payments',                  page: 'PaymentBatch' },
    { name: 'Customers & Suppliers',     page: 'Parties' },
    { name: 'Accounting',                separator: true },
    { name: 'Accounting',                page: 'FinanceAccounting' },   // Engine·Chart of Accounts·Period Close·Cost Centres
    { name: 'Tax & Compliance',          page: 'TaxManagement' },
    { name: 'Fixed Assets',              page: 'FixedAssets' },
    { name: 'Budget Management',         page: 'BudgetManagement' },
    { name: 'Reports & Setup',           separator: true },
    { name: 'Financial Reports',         page: 'FinanceReports' },
    { name: 'Settings',                  page: 'FinanceSettings' },
    { name: 'Self Service',              separator: true },
    { name: 'My Payslip',                page: 'PayslipViewer' },

    // ── Consolidated into the hubs above (2026-09-16 IA pass) ──────────
    // These rows are NOT drawn in the sidebar — Sidebar.jsx skips any entry
    // carrying `inHub`. They stay here because getSectionForPage() walks
    // NAV_ITEMS: drop them and each page silently becomes section-less,
    // which makes canRoleAccessPageBySection wave it through for every
    // role. Keeping them preserves the section gate exactly, and TabHub
    // re-checks each tab with canRoleOpenPage() before drawing it.
    { name: 'AccountingEngine',          page: 'AccountingEngine', inHub: 'FinanceAccounting' },
    { name: 'ChartOfAccounts',           page: 'ChartOfAccounts', inHub: 'FinanceAccounting' },
    { name: 'PeriodClosing',             page: 'PeriodClosing', inHub: 'FinanceAccounting' },
    { name: 'CostCenters',               page: 'CostCenters', inHub: 'FinanceAccounting' },
  ]},

  { divider: true, section: 'People' },

  { name: 'Employees', icon: <FaUsers />, module: 'employees', submenu: [
    { name: 'Dashboard',           page: 'EmployeesDashboard' },
    { name: 'All Employees',       page: 'EmployeesData' },
    { name: 'Ex-Employees',        page: 'ExEmployees' },
    // Its own `module: 'bgv'` so the row is hidden from a role that holds
    // employees:view but no BGV grant — the group gate alone would have shown it
    // to every manager and then dead-ended them on Access Denied, which is the
    // sidebar/route mismatch the 2026-09-16 browser sweep found on the HR menu.
    { name: 'Background Verification', page: 'BackgroundVerification', module: 'bgv' },
    // Employee Reports (Workforce Analytics & Reports) lives under HR, not here —
    // see the HR group below for why.
    // EmployeeMasters is deliberately NOT a row here: it is reached from
    // All Employees → "Manage Employee Masters" and from Settings → Master Data.
  ]},

  { name: 'HR', icon: <FaUserTie />, module: 'hr', submenu: [
    // Employee Directory is NOT a row here any more: it is the company phonebook,
    // not an HR process, and it sits beside Org Chart below (its own section).
    // Interns are not employees, so this is an HR row, not an Employees row.
    // Its own `module` because the HR section is also held by payroll_admin,
    // manager and employee, none of whom hold internships:view — Sidebar.jsx
    // drops an HR row whose module the caller cannot view, and Layout.jsx's
    // route gate refuses the page itself.
    { name: 'Internships',               page: 'Internships', module: 'internships' },
    // payroll:view (PC-01 closure) — hr_exec, manager and employee hold the HR
    // section but not payroll; their API calls here were all 403.
    { name: 'Payroll Center',            page: 'PayrollCenter', module: 'payroll' },
    // Own `module`: the HR section is also held by hr, hr_exec, manager and
    // employee, who hold no it_declarations grant — Sidebar drops the row for
    // them and Layout refuses the URL (§203).
    { name: 'IT Declaration Review',     page: 'ITDeclarationReview', module: 'it_declarations' },
    // employee_bank:view holders (hr, hr_manager, admin by default) — §204 —
    // and propose-only :add holders, who see only their own requests (§206;
    // no role holds :add as seeded).
    { name: 'Bank Detail Approvals',     page: 'BankChangeApprovals', module: 'employee_bank', moduleActions: ['view', 'add'] },
    { name: 'Announcements',             page: 'Announcements' },
    // Workforce Analytics & Reports needs hr:view (its data endpoint does), so it
    // belongs to the section the hr:view roles hold. It used to sit under
    // Employees, which hr_exec / hr_manager / payroll_admin do not have in
    // ROLE_SECTION_ALLOWLIST — so the menu hid it from them AND
    // canRoleAccessPageBySection refused the direct URL, although each holds
    // hr:view. getSectionForPage() resolves a page to the FIRST group that
    // lists it, so it must appear in this group only.
    { name: 'Workforce Analytics & Reports', page: 'EmployeeReports', module: 'hr' },
    { name: 'Self Service',              separator: true },
    { name: 'My Dashboard',              page: 'EmployeeDashboard' },
    // employeeLinkOnly: the portal is the signed-in person's OWN records, so
    // Sidebar.jsx drops the row for a login with no linked employee (a system
    // administrator) instead of offering an empty page. The URL still opens and
    // says why it is empty.
    { name: 'Self Service',              page: 'EmployeeSelfService', employeeLinkOnly: true },
    { name: 'Employee Records',          page: 'EmployeeRecords' },   // Documents·Assets·Policies·HR Documents
    { name: 'Lifecycle',                 separator: true },
    // Probation and exit are separate workflows (an employee being confirmed vs
    // one leaving), so each has its own row. Probation used to be a tab of the
    // 'Exit & Probation' hub; the hub key ExitCenter is kept — it is the Exit
    // Management page now — so bookmarks and Page Access grants still resolve.
    { name: 'Probation Management',      page: 'Probation' },
    { name: 'Exit Management',           page: 'ExitCenter' },   // Exits & settlement·Offboarding checklist
    // Own `module` (§209): talent ratings are confidential, so the row shows
    // only to succession:view holders (hr, hr_manager, admin, super_admin by
    // default; any other role by explicit grant in Roles Setup). Everyone else
    // in this section — employee, manager, hr_exec — no longer sees it, and
    // Layout refuses the URL.
    { name: 'Succession Center',         page: 'SuccessionCenter', module: 'succession' },
    { name: 'Security & Access',         separator: true },
    // Gate passes and visitor management had no link anywhere: /BiometricAccess
    // redirected to AttendanceSettings?tab=devices, which renders DeviceManagement
    // and covers none of it. Filed under HR because the page, its backend module
    // (hr/biometric.routes.js) and this section all agree — putting the row under
    // Attendance instead would leave getSectionForPage() resolving 'Attendance'
    // while the file's folder module stays 'hr'.
    { name: 'Gate Pass & Visitors',      page: 'BiometricAccess' },   // Attendance import·Gate passes·Visitors

    // ── Consolidated into the hubs above (2026-09-16 IA pass) ──────────
    // These rows are NOT drawn in the sidebar — Sidebar.jsx skips any entry
    // carrying `inHub`. They stay here because getSectionForPage() walks
    // NAV_ITEMS: drop them and each page silently becomes section-less,
    // which makes canRoleAccessPageBySection wave it through for every
    // role. Keeping them preserves the section gate exactly, and TabHub
    // re-checks each tab with canRoleOpenPage() before drawing it.
    { name: 'EmployeeDocuments',         page: 'EmployeeDocuments', inHub: 'EmployeeRecords' },
    { name: 'EmployeeAssets',            page: 'EmployeeAssets', inHub: 'EmployeeRecords' },
    { name: 'Policies',                  page: 'Policies', inHub: 'EmployeeRecords' },
    { name: 'Downloads',                 page: 'Downloads', inHub: 'EmployeeRecords' },
    { name: 'Offboarding',              page: 'Offboarding', inHub: 'ExitCenter' },
    { name: 'ExitManagement',            page: 'ExitManagement', inHub: 'ExitCenter' },
  ]},

  // 'Talent' used to be a separate top-level menu (Resume Database/Pools/
  // Question Bank/Agencies) but it had no `module:` key, so it was invisible
  // to manager/department_head — who hold 'Recruitment' but not 'Talent' —
  // and it overlapped with Recruitment's candidate views (Resume Database,
  // Candidate Pipeline and All Candidates all rendered the same `candidates`
  // table). Merged into this single module 2026-07-28: the three candidate
  // views are now tabs on one 'Candidates' page, and the sourcing tools
  // (Talent Pools/Question Bank/Agencies) live in this menu directly, all
  // inheriting the 'recruitment' module permission.
  { name: 'Recruitment', icon: <FaBriefcase />, module: 'recruitment', submenu: [
    // 'My Work' leads, not the Dashboard. §25 of the 2026-09-27 brief: "Recruiters
    // need action more than charts... Do not make the first screen a wall of 20
    // charts", with Work Queue first in its own priority list. The analytics
    // Dashboard is still here, one row down.
    { name: 'My Work',                   page: 'RecruitmentWorkQueue' },
    { name: 'Pipeline Snapshot',         page: 'RecruiterDashboard' },
    { name: 'Dashboard',                 page: 'RecruitmentDashboard' },
    { name: 'Pipeline',                  separator: true },
    { name: 'Jobs',                      page: 'Jobs' },
    { name: 'Candidates',                page: 'Candidates' },
    { name: 'Talent Bank',               page: 'TalentBank' },
    { name: 'Sourcing',                  page: 'Sourcing' },
    { name: 'Interviews',                page: 'InterviewCenter' },   // Schedule·Feedback·Question Bank
    { name: 'Offer & Onboarding',        page: 'OnboardingCenter' },   // Offers·Checklist·Employee creation
    { name: 'Reports & Setup',           separator: true },
    { name: 'Reports & Setup',           page: 'HiringAdmin' },   // Forecasts·Reports·Email templates·Settings

    // ── Consolidated into the hubs above (2026-09-16 IA pass) ──────────
    // These rows are NOT drawn in the sidebar — Sidebar.jsx skips any entry
    // carrying `inHub`. They stay here because getSectionForPage() walks
    // NAV_ITEMS: drop them and each page silently becomes section-less,
    // which makes canRoleAccessPageBySection wave it through for every
    // role. Keeping them preserves the section gate exactly, and TabHub
    // re-checks each tab with canRoleOpenPage() before drawing it.
    // ── Pages reached through a hub tab, so getSectionForPage() resolves them ──
    // These seven had NO entry here at all before 2026-09-27 — not even an `inHub`
    // row — so getSectionForPage() returned null for each and
    // canRoleAccessPageBySection() waved them past the section allowlist. The
    // `recruitment` module gate still applied, so it was an allowlist bypass and
    // not an authz hole. Sidebar.jsx skips any row carrying `inHub`, so these draw
    // no menu entries.
    //
    // `inHub` is a CLAIM, not a label: nav.hubs.test.jsx reads the named hub's
    // exported TABS and fails if the page is not one of them, because a row marked
    // inHub that is not a tab is reachable by no click at all. Every row below is
    // a real tab of the hub it names.
    //
    // NOT listed here, deliberately:
    //  · CandidateDetail, CandidateScreening, TalentPoolDetail — drill-downs
    //    reached by clicking a record, not tabs. Tab membership is the only
    //    mechanism this codebase has for resolving a page's section, so these
    //    three keep the pre-existing `section === null` behaviour; the
    //    `recruitment` module gate still covers them.
    //  · AllCandidates — superseded by CandidateWorkbench and no longer a tab of
    //    anything. Its ROUTES entry is kept so a direct URL and the existing audit
    //    fixtures still resolve, and so the rollout reverts by changing one import
    //    in Candidates.jsx.
    { name: 'CandidateWorkbench',        page: 'CandidateWorkbench', inHub: 'Candidates' },
    { name: 'CandidatePipeline',         page: 'CandidatePipeline', inHub: 'Candidates' },
    { name: 'ResumeDatabase',            page: 'ResumeDatabase', inHub: 'Candidates' },
    { name: 'TalentPools',               page: 'TalentPools', inHub: 'Sourcing' },
    { name: 'RecruitmentAgencies',       page: 'RecruitmentAgencies', inHub: 'Sourcing' },
    { name: 'JobOpenings',               page: 'JobOpenings', inHub: 'Jobs' },
    { name: 'JobRequisitionPipeline',    page: 'JobRequisitionPipeline', inHub: 'Jobs' },

    { name: 'InterviewScheduler',        page: 'InterviewScheduler', inHub: 'InterviewCenter' },
    { name: 'InterviewFeedback',         page: 'InterviewFeedback', inHub: 'InterviewCenter' },
    { name: 'InterviewQuestionBank',     page: 'InterviewQuestionBank', inHub: 'InterviewCenter' },
    { name: 'OfferManagement',           page: 'OfferManagement', inHub: 'OnboardingCenter' },
    { name: 'OnboardingChecklist',       page: 'OnboardingChecklist', inHub: 'OnboardingCenter' },
    { name: 'EmployeeAutoCreation',      page: 'EmployeeAutoCreation', inHub: 'OnboardingCenter' },
    { name: 'HiringForecasts',           page: 'HiringForecasts', inHub: 'HiringAdmin' },
    { name: 'RecruitmentReports',        page: 'RecruitmentReports', inHub: 'HiringAdmin' },
    { name: 'EmailTemplates',            page: 'EmailTemplates', inHub: 'HiringAdmin' },
    { name: 'RecruitmentSettings',       page: 'RecruitmentSettings', inHub: 'HiringAdmin' },
    { name: 'CareersPageAdmin',          page: 'CareersPageAdmin', inHub: 'HiringAdmin' },
  ]},

  { name: 'Learning Center', icon: <FaGraduationCap />, submenu: [
    { name: 'L&D Command Centre',  page: 'LearningDashboard' },
    { name: 'Training Calendar',   page: 'LearningDevelopment' },
    { name: 'Learning Paths',      page: 'LearningPaths' },
    { name: 'Assessments',         page: 'AssessmentCenter' },
    { name: 'Certifications',      page: 'CertificationManagement' },
    { name: 'Capability',          separator: true },
    { name: 'Skill Matrix',        page: 'SkillMatrix' },
    { name: 'Competency Framework',page: 'CompetencyFramework' },
    { name: 'Administration',      separator: true },
    { name: 'Trainer Management',  page: 'TrainerManagement' },
    { name: 'Training Reports',    page: 'TrainingReports' },
    { name: 'Settings',            page: 'LNDSettings' },
  ]},

  { name: 'Attendance', icon: <FaCalendarCheck />, module: 'attendance', submenu: [
    { name: 'My Attendance',             page: 'AttendanceDashboard' },
    { name: 'QR Attendance',             page: 'QRAttendance' },
    { name: 'Team & Monitoring',         separator: true },
    { name: 'Live Workforce',            page: 'LiveWorkforceDashboard' },
    { name: 'Team Attendance',           page: 'TeamAttendance' },
    { name: 'Shift Calendar',            page: 'ShiftCalendar' },
    { name: 'Approvals',                 separator: true },
    { name: 'Approvals',                 page: 'AttendanceApprovals' },   // Regularization·Overtime·Delegation
    { name: 'Reporting',                 separator: true },
    { name: 'Reports',                   page: 'AttendanceReportsHub' },
    { name: 'Audit Logs',                page: 'AttendanceAuditLogs' },
    { name: 'Configuration',             separator: true },
    { name: 'Configuration',             page: 'AttendanceConfig' },   // Rotations·Work Centres·Contract Labour·Payroll Sync·Settings

    // ── Consolidated into the hubs above (2026-09-16 IA pass) ──────────
    // These rows are NOT drawn in the sidebar — Sidebar.jsx skips any entry
    // carrying `inHub`. They stay here because getSectionForPage() walks
    // NAV_ITEMS: drop them and each page silently becomes section-less,
    // which makes canRoleAccessPageBySection wave it through for every
    // role. Keeping them preserves the section gate exactly, and TabHub
    // re-checks each tab with canRoleOpenPage() before drawing it.
    { name: 'RegularizationApprovals',   page: 'RegularizationApprovals', inHub: 'AttendanceApprovals' },
    { name: 'OvertimeApprovals',         page: 'OvertimeApprovals', inHub: 'AttendanceApprovals' },
    { name: 'ApprovalDelegation',        page: 'ApprovalDelegation', inHub: 'AttendanceApprovals' },
    { name: 'Shifts',                    page: 'Shifts', inHub: 'AttendanceConfig' },
    { name: 'WorkCentres',               page: 'WorkCentres', inHub: 'AttendanceConfig' },
    { name: 'ContractLabour',            page: 'ContractLabour', inHub: 'AttendanceConfig' },
    { name: 'PayrollSync',               page: 'PayrollSync', inHub: 'AttendanceConfig' },
    { name: 'AttendanceSettings',        page: 'AttendanceSettings', inHub: 'AttendanceConfig' },
  ]},

  { name: 'Leaves', icon: <FaUmbrellaBeach />, module: 'leaves', submenu: [
    { name: 'My Leaves',         page: 'MyLeaves' },
    { name: 'Apply Leave',       page: 'ApplyLeave' },
    { name: 'Leave Calendar',    page: 'LeaveCalendar' },
    { name: 'Holiday Calendar',  page: 'HolidayCalendar' },
    { name: 'Comp Off',          page: 'CompOff' },
    { name: 'Approvals',         separator: true },
    { name: 'Leave Approvals',   page: 'LeaveApprovals' },
    { name: 'Team Leaves',       page: 'TeamLeaves' },
    { name: 'Administration',    separator: true },
    { name: 'All Leaves',        page: 'AllLeaves' },
    { name: 'Leave Reports',     page: 'LeaveReports' },
    { name: 'Encashment',        page: 'LeaveEncashment' },
    { name: 'Leave Settings',    page: 'LeaveSettings' },
  ]},

  { name: 'Timesheets', icon: <FaClock />, module: 'timesheets', submenu: [
    { name: 'My Timesheet',        page: 'MyTimesheet' },
    { name: 'My Analytics',        page: 'MyAnalytics' },
    { name: 'Team',                separator: true },
    { name: 'All Timesheets',      page: 'Timesheets' },
    { name: 'Approvals',           page: 'TimesheetApprovals' },
    { name: 'Reports & Setup',     separator: true },
    { name: 'Utilization Report',  page: 'UtilizationReport' },
    { name: 'Weekly Report',       page: 'WeeklyProductionReport' },
    { name: 'Settings',            page: 'TimesheetSettings' },
  ]},

  // Eight of these twelve pages (Review Cycles, KRA, OKR, Calibration,
  // Increment, Promotion, Dashboard, Reports) were built, routed and gated —
  // EMPLOYEE_SELF_SERVICE_PAGES already names them as "manager/HR-only" — but
  // carried no link anywhere in the app: no NAV row, no hub tab, no setPage
  // call. Added 2026-09-16. The self-service three stay at the top, per the
  // house order for shared HR-family menus.
  { name: 'Performance', icon: <FaTrophy />, module: 'performance', submenu: [
    { name: 'My Reviews',                page: 'PerformanceReviews' },
    { name: 'Goals & KPIs',              page: 'Goals' },
    { name: '360° Feedback',             page: 'Feedback360' },
    { name: 'Manage',                    separator: true },
    { name: 'Cycles & Goals',            page: 'PerformanceManage' },   // Team·Cycles·KRA·OKR
    { name: 'Talent Decisions',          page: 'TalentDecisions' },   // Calibration·Increment·Promotion
    { name: 'Insights & Setup',          separator: true },
    { name: 'Insights & Setup',          page: 'PerformanceInsights' },   // Dashboard·Reports·Settings

    // ── Consolidated into the hubs above (2026-09-16 IA pass) ──────────
    // These rows are NOT drawn in the sidebar — Sidebar.jsx skips any entry
    // carrying `inHub`. They stay here because getSectionForPage() walks
    // NAV_ITEMS: drop them and each page silently becomes section-less,
    // which makes canRoleAccessPageBySection wave it through for every
    // role. Keeping them preserves the section gate exactly, and TabHub
    // re-checks each tab with canRoleOpenPage() before drawing it.
    { name: 'TeamPerformance',           page: 'TeamPerformance', inHub: 'PerformanceManage' },
    { name: 'ReviewCycleManager',        page: 'ReviewCycleManager', inHub: 'PerformanceManage' },
    { name: 'KRAManagement',             page: 'KRAManagement', inHub: 'PerformanceManage' },
    { name: 'OKRManagement',             page: 'OKRManagement', inHub: 'PerformanceManage' },
    { name: 'CalibrationCenter',         page: 'CalibrationCenter', inHub: 'TalentDecisions' },
    { name: 'IncrementPlanning',         page: 'IncrementPlanning', inHub: 'TalentDecisions' },
    { name: 'PromotionPlanning',         page: 'PromotionPlanning', inHub: 'TalentDecisions' },
    { name: 'PerformanceDashboard',      page: 'PerformanceDashboard', inHub: 'PerformanceInsights' },
    { name: 'PerformanceReports',        page: 'PerformanceReports', inHub: 'PerformanceInsights' },
    { name: 'PerformanceSettings',       page: 'PerformanceSettings', inHub: 'PerformanceInsights' },
  ]},

  { name: 'Travel Desk', icon: <FaPlane />, submenu: [
    { name: 'Dashboard',                 page: 'TravelDashboard' },
    { name: 'My Travel',                 separator: true },
    { name: 'My Travel',                 page: 'MyTravel' },   // Entry·Requests·Bookings·Advances·Calendar
    { name: 'Expenses',                  page: 'TravelExpenseCenter' },   // Claims·Trip expenses·Review·Payment
    { name: 'Visit Reports',             page: 'TravelVisits' },   // Reports·Customer visits
    { name: 'Approvals & Insight',       separator: true },
    { name: 'Travel Approvals',          page: 'TravelApprovals' },
    { name: 'Insights & Policy',         page: 'TravelInsights' },   // Command·Analytics·Reports·Audit·Policy

    // ── Consolidated into the hubs above (2026-09-16 IA pass) ──────────
    // These rows are NOT drawn in the sidebar — Sidebar.jsx skips any entry
    // carrying `inHub`. They stay here because getSectionForPage() walks
    // NAV_ITEMS: drop them and each page silently becomes section-less,
    // which makes canRoleAccessPageBySection wave it through for every
    // role. Keeping them preserves the section gate exactly, and TabHub
    // re-checks each tab with canRoleOpenPage() before drawing it.
    { name: 'TravelEntry',               page: 'TravelEntry', inHub: 'MyTravel' },
    { name: 'TravelRequests',            page: 'TravelRequests', inHub: 'MyTravel' },
    { name: 'ExpenseClaims',             page: 'ExpenseClaims', inHub: 'TravelExpenseCenter' },
    { name: 'TravelExpenses',            page: 'TravelExpenses', inHub: 'TravelExpenseCenter' },
    { name: 'TravelAdvances',            page: 'TravelAdvances', inHub: 'MyTravel' },
    { name: 'TravelBookings',            page: 'TravelBookings', inHub: 'MyTravel' },
    { name: 'VisitReports',              page: 'VisitReports', inHub: 'TravelVisits' },
    { name: 'CustomerVisits',            page: 'CustomerVisits', inHub: 'TravelVisits' },
    { name: 'TravelCalendar',            page: 'TravelCalendar', inHub: 'MyTravel' },
    { name: 'ExpenseReview',             page: 'ExpenseReview', inHub: 'TravelExpenseCenter' },
    { name: 'TravelPayment',             page: 'TravelPayment', inHub: 'TravelExpenseCenter' },
    { name: 'TravelAudit',               page: 'TravelAudit', inHub: 'TravelInsights' },
    { name: 'TravelCommandCenter',       page: 'TravelCommandCenter', inHub: 'TravelInsights' },
    { name: 'TravelAnalytics',           page: 'TravelAnalytics', inHub: 'TravelInsights' },
    { name: 'TravelReports',             page: 'TravelReports', inHub: 'TravelInsights' },
    { name: 'TravelPolicyEngine',        page: 'TravelPolicyEngine', inHub: 'TravelInsights' },
  ]},

  { name: 'Org Chart', icon: <FaSitemap />, page: 'OrgChart' },

  // The read-only company phonebook (GET /employees/directory). Moved out of the
  // HR submenu: it was a second employee list there, and HR is for HR processes.
  // Its OWN section, not a row inside 'Org Chart', because nearly every role
  // holds 'Org Chart' and the phonebook's audience is exactly the six roles that
  // held 'HR' (ROLE_SECTION_ALLOWLIST lists it for each). Anyone who can open
  // All Employees is sent there instead and never sees this row — see
  // canOpenEmployeeMaster() in menuCatalog.js, used by Sidebar.jsx and Layout.jsx.
  { name: 'Employee Directory', icon: <FaAddressBook />, page: 'EmployeeDirectory' },

  { divider: true, section: 'Tools' },

  { name: 'e-Signatures', icon: <FaFileSignature />, submenu: [
    { name: 'Sign & Send',         page: 'DocumentSigning' },
    { name: 'Document Vault',      page: 'DocumentMaster' },
  ]},

  // Standalone item (no submenu) — visible to every role incl. employees;
  // admin-only tabs are gated inside the page itself.
  { name: 'QR Codes', icon: <FaQrcode />, page: 'QRCodeStudio' },

  { divider: true, section: 'Administration' },

  // NOTE: there is deliberately no 'User Management' group here. Users, Roles
  // and Approver Chains are TABS of Settings → Access Control, and this group
  // mounted the very same three components a second time. Two doors onto one
  // screen is how the role list, the department list and the permission matrix
  // drifted apart in the first place — each door grew its own copy. The pages
  // stay routable (see SUPER_ADMIN_ONLY_PAGES in menuCatalog.js) so existing
  // bookmarks and setPage('UserSetup') calls still resolve; they just are not
  // advertised as a second home.

  { name: 'Settings', icon: <FaCog />, page: 'SettingsCenter', submenu: [
    { name: '⚙ Settings Center',         page: 'SettingsCenter' },
    { name: 'User Preferences',          page: 'UserPreferences' },
    { name: 'Company & Access',          separator: true },
    { name: 'Company Setup',             page: 'CompanySetup' },   // Profile·Branches·Org·Brand Vault
    { name: 'Access Control',            page: 'AccessControl' },
    { name: 'Workflow Builder',          page: 'WorkflowBuilder' },
    { name: 'Setup Notifications',       page: 'SetupNotifications' },
    { name: 'Data & Platform',           separator: true },
    { name: 'Master Data',               page: 'MasterDataCenter' },   // Masters·Products·Documents·Order Policy·Asset Maintenance
    { name: 'Platform & Integrations',   page: 'PlatformCenter' },   // System·Integrations·Tally·Zoho·API·DB
    { name: 'Guided Setup',              separator: true },
    { name: 'Setup Center',              page: 'SetupCenter' },

    // ── Consolidated into the hubs above (2026-09-16 IA pass) ──────────
    // These rows are NOT drawn in the sidebar — Sidebar.jsx skips any entry
    // carrying `inHub`. They stay here because getSectionForPage() walks
    // NAV_ITEMS: drop them and each page silently becomes section-less,
    // which makes canRoleAccessPageBySection wave it through for every
    // role. Keeping them preserves the section gate exactly, and TabHub
    // re-checks each tab with canRoleOpenPage() before drawing it.
    { name: 'CompanyProfile',            page: 'CompanyProfile', inHub: 'CompanySetup' },
    { name: 'BranchManagement',          page: 'BranchManagement', inHub: 'CompanySetup' },
    { name: 'OrganizationSetup',         page: 'OrganizationSetup', inHub: 'CompanySetup' },
    { name: 'BrandVault',                page: 'BrandVault', inHub: 'CompanySetup' },
    { name: 'MasterSetup',               page: 'MasterSetup', inHub: 'MasterDataCenter' },
    { name: 'ProductSetup',              page: 'ProductSetup', inHub: 'MasterDataCenter' },
    { name: 'DocumentSetup',             page: 'DocumentSetup', inHub: 'MasterDataCenter' },
    { name: 'OrderPolicy',               page: 'OrderPolicy', inHub: 'MasterDataCenter' },
    { name: 'AssetMaintenance',          page: 'AssetMaintenance', inHub: 'MasterDataCenter' },
    { name: 'SystemSettings',            page: 'SystemSettings', inHub: 'PlatformCenter' },
    { name: 'IntegrationsHub',           page: 'IntegrationsHub', inHub: 'PlatformCenter' },
    { name: 'TallyIntegration',          page: 'TallyIntegration', inHub: 'PlatformCenter' },
    { name: 'ZohoSignIntegration',       page: 'ZohoSignIntegration', inHub: 'PlatformCenter' },
    { name: 'APIDocumentation',          page: 'APIDocumentation', inHub: 'PlatformCenter' },
    { name: 'DatabaseTest',              page: 'DatabaseTest', inHub: 'PlatformCenter' },
  ]},

  { name: 'Audit Logs',    icon: <FaHistory />, page: 'AuditLogs' },
];