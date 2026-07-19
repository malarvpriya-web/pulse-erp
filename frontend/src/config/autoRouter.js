// PATH: frontend/src/config/autoRouter.js
/**
 * autoRouter.js — Zero-configuration page discovery.
 *
 * Uses Vite's import.meta.glob to scan all feature pages and automatically
 * builds MERGED_ROUTES and AUTO_NAV_ITEMS without manual registration.
 * Manual entries in routes.jsx always take precedence.
 */

import { lazy } from 'react';
import { ROUTES as MANUAL_ROUTES, NAV_ITEMS as MANUAL_NAV_ITEMS } from './routes';

// ---------------------------------------------------------------------------
// Glob scan — all page files across features
// ---------------------------------------------------------------------------
const FEATURE_PAGES = import.meta.glob('../features/**/pages/*.jsx', { eager: false });
const ROOT_PAGES    = import.meta.glob('../pages/*.jsx',             { eager: false });

// ---------------------------------------------------------------------------
// Folder → display name + icon + module config
// ---------------------------------------------------------------------------
const FOLDER_CONFIG = {
  finance:      { label: 'Finance',       icon: 'TrendingUp',            module: 'finance' },
  hr:           { label: 'HR',            icon: 'Users',                 module: 'hr' },
  crm:          { label: 'CRM',           icon: 'Handshake' },
  sales:        { label: 'Sales',         icon: 'ShoppingCart' },
  inventory:    { label: 'Inventory',     icon: 'Box',                   module: 'inventory' },
  procurement:  { label: 'Procurement',   icon: 'Package',               module: 'procurement' },
  projects:     { label: 'Projects',      icon: 'FolderKanban',          module: 'projects' },
  production:   { label: 'Production',    icon: 'Factory' },
  recruitment:  { label: 'Recruitment',   icon: 'Briefcase' },
  talent:       { label: 'Talent',        icon: 'Star' },
  timesheets:   { label: 'Timesheets',    icon: 'Clock',                 module: 'timesheets' },
  performance:  { label: 'Performance',   icon: 'Trophy' },
  leaves:       { label: 'Leaves',        icon: 'Umbrella',              module: 'leave' },
  attendance:   { label: 'Attendance',    icon: 'CalendarCheck',         module: 'attendance' },
  travel:       { label: 'Travel Desk',   icon: 'Plane' },
  servicedesk:  { label: 'Service Desk',  icon: 'Headphones' },
  operations:   { label: 'Operations',    icon: 'Settings2' },
  marketing:    { label: 'Marketing',     icon: 'Target' },
  reports:      { label: 'Reports',       icon: 'FileText',              module: 'reports' },
  analytics:    { label: 'Analytics',     icon: 'LineChart' },
  admin:        { label: 'Admin',         icon: 'Shield' },
  audit:        { label: 'Audit',         icon: 'History' },
  complaints:   { label: 'Complaints',    icon: 'MessageSquareWarning' },
  orgchart:     { label: 'Org Chart',     icon: 'Network' },
  notifications:{ label: 'Notifications', icon: 'Bell' },
  documents:    { label: 'Documents',     icon: 'FileText' },
  engineering:  { label: 'Engineering',   icon: 'Wrench' },
  warehouse:    { label: 'Warehouse',     icon: 'Warehouse' },
  logistics:    { label: 'Logistics',     icon: 'Truck' },
  quality:      { label: 'Quality',       icon: 'CheckSquare' },
  maintenance:  { label: 'Maintenance',   icon: 'Tool' },
  iot:          { label: 'IoT Fleet',      icon: 'Radio',                 module: 'iot' },
  compliance:   { label: 'Compliance',     icon: 'ShieldCheck',           module: 'compliance' },
  assets:       { label: 'Asset Register',  icon: 'Boxes',                 module: 'assets' },
  rd:           { label: 'R&D',             icon: 'FlaskConical',          module: 'rd' },
  tenders:      { label: 'Tenders',         icon: 'Gavel',                 module: 'crm' },
  employees:    { label: 'Employees',     icon: 'Users2' },
  'hr-analytics': { label: 'HR Analytics', icon: 'BarChart2' },
};

// ---------------------------------------------------------------------------
// Manual display name overrides for pages with acronyms or special names
// ---------------------------------------------------------------------------
const PAGE_DISPLAY_NAMES = {
  CFODashboard:           'CFO Dashboard',
  RDHub:                  'R&D Hub',
  EngineerHome:           'My Field Jobs',
  BOMBuilder:             'BOM Builder',
  FixedAssets:            'Fixed Assets',
  GSTModule:              'GST Module',
  TDSManagement:          'TDS Management',
  TCSManagement:          'TCS Management',
  MRPEngine:              'MRP Engine',
  RFQManagement:          'RFQ Management',
  SLAManagement:          'SLA Management',
  CSATDashboard:          'CSAT Dashboard',
  PNLStatement:           'P&L Statement',
  ABCAnalysis:            'ABC Analysis',
  WDVReport:              'WDV Report',
  SLMCalculator:          'SLM Calculator',
  PFManagement:           'PF Management',
  ESIManagement:          'ESI Management',
  PTCalculator:           'PT Calculator',
  QCInspection:           'QC Inspection',
  NCRManagement:          'NCR Management',
  CAPATracker:            'CAPA Tracker',
  GRNManagement:          'GRN Management',
  POManagement:           'PO Management',
  PRManagement:           'PR Management',
  MTTRReport:             'MTTR Report',
  MTBFReport:             'MTBF Report',
  CeoDashboard:           'CEO Dashboard',
  FinanceDashboard:       'Finance Dashboard',
  FinanceDashboardNew:    'Finance Dashboard',
  BudgetVsActuals:        'Budget vs Actuals',
  BudgetManagement:       'Budget Management',
  ChartOfAccounts:        'Chart of Accounts',
  JournalEntry:           'Journal Entry',
  PeriodClosing:          'Period Closing',
  BankAccounts:           'Bank Accounts',
  AccountingEngine:       'Accounting Engine',
  FinancialRatios:        'Financial Ratios',
  FinancialStatements:    'Financial Statements',
  CustomerOutstanding:    'Customer Outstanding',
  SupplierOutstanding:    'Supplier Outstanding',
  SupplierBills:          'Supplier Bills',
  PaymentBatch:           'Payments',
  PDCOutstanding:         'PDC Outstanding',
  PurchaseDashboard:      'Purchase Dashboard',
  ReportPDC:              'PDC Report',
  ReportPurchase:         'Purchase Report',
  ForexManagement:        'Forex Management',
  CommissionManagement:   'Commission Management',
  EmployeesDashboard:     'Employee Overview',
  EmployeesData:          'Employees Data',
  ExEmployees:            'Ex-Employees',
  EmployeeProfile:        'Employee Profile',
  AddEmployee:            'Add Employee',
  EditEmployee:           'Edit Employee',
  EmployeeDirectory:      'Employee Directory',
  HolidayCalendar:        'Holiday Calendar',
  ApplyLeave:             'Apply Leave',
  MyLeaves:               'My Leaves',
  AllLeaves:              'All Leaves',
  LeaveSettings:          'Leave Settings',
  LeaveApprovals:         'Leave Approvals',
  LeaveCalendar:          'Leave Calendar',
  LeaveReports:           'Leave Reports',
  CompOff:                'Comp Off',
  LeaveEncashment:        'Leave Encashment',
  // Legacy aliases — resolve to unified pages
  TeamLeaves:             'Leave Approvals',
  LeaveApplication:       'Apply Leave',
  LeaveManagement:        'All Leaves',
  LeaveManagementNew:     'All Leaves',
  AttendanceDashboard:    'My Attendance',
  TeamAttendance:         'Team Attendance',
  LateArrivals:           'Late Arrivals',
  ApprovalCenter:         'Approval Center',
  NotificationCenter:     'Notification Center',
  ApprovalWorkflow:       'Approval Workflow',
  WorkflowBuilder:        'Workflow Builder',
  CRMPipeline:            'CRM Pipeline',
  SalesDashboard:         'Sales Dashboard',
  SalesForecast:          'Sales Forecast',
  FulfilmentTracking:     'Fulfilment Tracking',
  CreditControl:          'Credit Control',
  InventoryIntelligence:  'Inventory Intelligence',
  ResourceManagement:     'Resource Management',
  ExitManagement:         'Exit Management',
  ServiceDesk:            'Service Desk',
  TicketDashboard:        'Ticket Dashboard',
  KnowledgeBase:          'Knowledge Base',
  AttendanceAnalytics:    'Attendance Analytics',
  OrgChart:               'Org Chart',
  EmployeeAssets:         'Employee Assets',
  AdminDashboard:         'Operations Dashboard',
  EmployeeDashboard:      'My Dashboard',
  SystemHealth:           'System Health',
  EngineeringDev:         'Engineering Development',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a PascalCase filename to a human-readable display name.
 * Handles acronyms: CFO, BOM, GST, MRP, RFQ, SLA, CSAT, TDS, PNL, GRN, PO, PR, QC, NCR, CAPA, etc.
 */
function filenameToDisplayName(filename) {
  if (PAGE_DISPLAY_NAMES[filename]) return PAGE_DISPLAY_NAMES[filename];

  // Insert space before uppercase sequences that follow lowercase, or before
  // a single capital followed by a lowercase (but keep acronym runs together)
  return filename
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

/** Extract folder name from path like '../features/finance/pages/Dashboard.jsx' */
function extractFolder(path) {
  const match = path.match(/\/features\/([^/]+)\//);
  return match ? match[1] : null;
}

/** Extract page key (filename without extension) */
function extractPageKey(path) {
  return path.split('/').pop().replace(/\.jsx?$/, '');
}

// Files that physically live in a pages/ folder but are embedded sub-components
// (panels/widgets rendered *inside* a hub or dashboard page), or generic
// prop-driven templates/modals. They are not navigable pages: they require props
// and would render broken (empty or crashing) if routed to directly. Excluding
// them keeps them out of the router, the sidebar, and global search — their
// parent pages import them directly, not through MERGED_ROUTES.
const NON_PAGE_SUFFIX = /(Panel|Widget|Heatmap|Trend)$/;
const NON_PAGE_FILES = new Set([
  'GenericListPage',   // servicedesk — generic list, needs {title,endpoint}
  'SetupTable',        // admin — generic table template, needs {title,endpoint}
  'SetupMaster',       // admin — generic master template, needs {config}
  'MenuPermissions',   // admin — embedded tab inside AccessControl
  'VendorProjectImpact', // procurement — embedded panel inside Vendor360
  'InterviewFeedback', // recruitment — modal, needs {candidateId,onClose}
  'PublicSigning',     // documents — public fullscreen route (App.jsx), not a menu page
]);

// Real pages whose *filename* differs from the curated route key they're reached
// by (e.g. FinanceDashboard.jsx is routed under the 'FinanceDashboardNew' key,
// 'Invoices' under 'InvoicesNew'). They must stay routable by URL / setPage(),
// but must NOT appear as duplicate auto-menu or search entries alongside their
// curated counterpart.
const DUPLICATE_PAGE_ALIASES = new Set([
  'FinanceDashboard',    // → FinanceDashboardNew ('Finance Dashboard')
  'Invoices',            // → InvoicesNew
  'TaxPage',             // → TaxManagement ('Tax & Compliance')
  'PurchaseRequest',     // → PurchaseRequestDashboard ('Purchase Requests')
  'CompOffPage',         // → CompOff ('Comp Off')
  'LeaveEncashmentPage', // → LeaveEncashment ('Encashment')
  'StockManagement',     // → ServiceStockManagement ('Spare Parts Stock')
]);

/**
 * True only for files that are real, default-exporting page components.
 * Barrel files (index.jsx) and co-located utility/helper/context modules live
 * inside pages/ folders but have no default export — turning them into lazy
 * routes crashes React.lazy ("Cannot convert object to primitive value") when
 * they're navigated to. Embedded sub-components (see NON_PAGE_* above) are
 * excluded too. Excluding them here keeps every consumer consistent.
 */
function isPageModule(key) {
  if (key === 'index') return false;
  if (key.startsWith('_')) return false;
  if (NON_PAGE_SUFFIX.test(key)) return false;
  if (NON_PAGE_FILES.has(key)) return false;
  return !/(Utils|Helpers|Constants|Context|Hook)$/.test(key);
}

// ---------------------------------------------------------------------------
// Build AUTO_ROUTES from glob results
// ---------------------------------------------------------------------------
const AUTO_ROUTES = {};

for (const [path, importer] of Object.entries(FEATURE_PAGES)) {
  const key = extractPageKey(path);
  if (!isPageModule(key)) continue;
  if (!AUTO_ROUTES[key]) {
    AUTO_ROUTES[key] = {
      component: lazy(importer),
      _auto: true,
      _path: path,
    };
  }
}

for (const [path, importer] of Object.entries(ROOT_PAGES)) {
  const key = extractPageKey(path);
  if (!isPageModule(key)) continue;
  if (!AUTO_ROUTES[key]) {
    AUTO_ROUTES[key] = {
      component: lazy(importer),
      _auto: true,
      _path: path,
    };
  }
}

// ---------------------------------------------------------------------------
// MERGED_ROUTES — manual routes override auto-discovered ones
// ---------------------------------------------------------------------------
export const MERGED_ROUTES = {
  ...AUTO_ROUTES,
  ...MANUAL_ROUTES,
};

// ---------------------------------------------------------------------------
// Build AUTO_NAV_ITEMS grouped by folder
// ---------------------------------------------------------------------------

/** Collect all pages per folder */
const folderMap = {};

for (const [path] of Object.entries(FEATURE_PAGES)) {
  const folder = extractFolder(path);
  const key    = extractPageKey(path);
  if (!folder) continue;

  // Skip barrels + internal/utility files (no default export → not a page)
  if (!isPageModule(key)) continue;

  if (!folderMap[folder]) folderMap[folder] = [];
  if (!folderMap[folder].includes(key)) folderMap[folder].push(key);
}

/**
 * Build nav children for a folder.
 * Each child = { name: pageKey, label: displayName }
 */
function buildChildren(folder, pageKeys) {
  return pageKeys
    .filter(key => {
      // Exclude utility / non-navigable pages
      const lower = key.toLowerCase();
      return !lower.includes('profile') &&
             !lower.includes('addemployee') &&
             !lower.includes('editemployee') &&
             !lower.includes('unauthorized') &&
             !lower.includes('fixture') &&
             !lower.endsWith('form');
    })
    .map(key => ({
      name:  key,
      label: filenameToDisplayName(key),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * AUTO_NAV_ITEMS — derived from filesystem.
 * Manual NAV_ITEMS from routes.jsx are merged in MERGED_NAV_ITEMS below.
 */
export const AUTO_NAV_ITEMS = Object.entries(folderMap)
  .filter(([folder]) => FOLDER_CONFIG[folder])
  .map(([folder, pageKeys]) => {
    const cfg      = FOLDER_CONFIG[folder];
    const children = buildChildren(folder, pageKeys);
    if (!children.length) return null;
    return {
      name:     cfg.label,
      icon:     cfg.icon,
      module:   cfg.module || null,
      children,
    };
  })
  .filter(Boolean)
  .sort((a, b) => {
    // Preserve a consistent ordering matching the original NAV_ITEMS
    const ORDER = ['Finance','HR','CRM','Sales','Inventory','Procurement',
                   'Projects','Production','Recruitment','Talent','Timesheets',
                   'Performance','Leaves','Attendance','Travel Desk','Service Desk',
                   'Operations','Marketing','Reports','Analytics','Admin','Audit',
                   'Complaints','Org Chart','Notifications','Documents','Engineering'];
    const ai = ORDER.indexOf(a.name);
    const bi = ORDER.indexOf(b.name);
    if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

/**
 * MERGED_NAV_ITEMS — manual NAV_ITEMS take precedence for any group with same name.
 * Auto-discovered groups for folders not present in manual list are appended.
 */
const manualGroupNames = new Set(MANUAL_NAV_ITEMS.map(g => g.name));
const autoOnlyGroups   = AUTO_NAV_ITEMS.filter(g => !manualGroupNames.has(g.name));

export const MERGED_NAV_ITEMS = [...MANUAL_NAV_ITEMS, ...autoOnlyGroups];

// ---------------------------------------------------------------------------
// ORPHAN_NAV_ITEMS — sidebar-shaped groups for pages that exist on disk but are
// NOT linked anywhere in the curated menu. Lets the Sidebar surface every page
// under a "<Module> · More" group so nothing is unreachable, while leaving the
// hand-tuned menu untouched. Consumed by Sidebar.jsx.
// ---------------------------------------------------------------------------

/** Every page key already reachable from the curated menu. */
const linkedPages = new Set();
for (const group of MANUAL_NAV_ITEMS) {
  if (group.page) linkedPages.add(group.page);
  (group.submenu || []).forEach(s => { if (s.page) linkedPages.add(s.page); });
}
// Manual ROUTES keys are considered "handled" too — this suppresses duplicates
// for pages that are routed under a hub/alias key rather than their filename.
const manualRouteKeys = new Set(Object.keys(MANUAL_ROUTES));

function isNavigableOrphan(key) {
  if (linkedPages.has(key) || manualRouteKeys.has(key)) return false;
  if (DUPLICATE_PAGE_ALIASES.has(key)) return false; // reachable via its curated key
  if (!isPageModule(key)) return false;
  const lower = key.toLowerCase();
  if (lower.startsWith('add') || lower.startsWith('edit')) return false;
  if (lower.endsWith('form')) return false;
  return !['profile', 'detail', 'unauthorized', 'fixture'].some(x => lower.includes(x));
}

const orphanFolderMap = {};
for (const [path] of Object.entries(FEATURE_PAGES)) {
  const folder = extractFolder(path);
  const key    = extractPageKey(path);
  if (!folder || !isNavigableOrphan(key)) continue;
  if (!orphanFolderMap[folder]) orphanFolderMap[folder] = [];
  if (!orphanFolderMap[folder].includes(key)) orphanFolderMap[folder].push(key);
}

export const ORPHAN_NAV_ITEMS = Object.entries(orphanFolderMap)
  .map(([folder, keys]) => {
    const cfg     = FOLDER_CONFIG[folder];
    const label   = cfg ? cfg.label : folder.charAt(0).toUpperCase() + folder.slice(1);
    const submenu = keys
      .map(key => ({ name: filenameToDisplayName(key), page: key }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!submenu.length) return null;
    return { name: `${label} · More`, module: cfg?.module || null, submenu, _auto: true };
  })
  .filter(Boolean)
  .sort((a, b) => a.name.localeCompare(b.name));

// ---------------------------------------------------------------------------
// Build SEARCHABLE_PAGES from all discovered pages (used by GlobalSearch)
// ---------------------------------------------------------------------------
export const AUTO_SEARCHABLE_PAGES = [];

for (const [path] of Object.entries(FEATURE_PAGES)) {
  const folder = extractFolder(path);
  const key    = extractPageKey(path);
  if (!folder || !isPageModule(key)) continue;
  if (DUPLICATE_PAGE_ALIASES.has(key)) continue; // shown once, under its curated key

  const folderCfg  = FOLDER_CONFIG[folder];
  const category   = folderCfg ? folderCfg.label : folder.charAt(0).toUpperCase() + folder.slice(1);
  const label      = filenameToDisplayName(key);

  AUTO_SEARCHABLE_PAGES.push({ page: key, label, category });
}

// Remove duplicates (same page key)
const seen = new Set();
const DEDUPED_SEARCHABLE = AUTO_SEARCHABLE_PAGES.filter(p => {
  if (seen.has(p.page)) return false;
  seen.add(p.page);
  return true;
});

export { DEDUPED_SEARCHABLE as SEARCHABLE_PAGES };

// ---------------------------------------------------------------------------
// getPageTitle — used by Layout breadcrumb / tab titles
// ---------------------------------------------------------------------------
export function getPageTitle(pageKey) {
  if (!pageKey) return 'Pulse ERP';
  return filenameToDisplayName(pageKey);
}

// ---------------------------------------------------------------------------
// Default export for convenience
// ---------------------------------------------------------------------------
export default {
  MERGED_ROUTES,
  MERGED_NAV_ITEMS,
  ORPHAN_NAV_ITEMS,
  AUTO_NAV_ITEMS,
  SEARCHABLE_PAGES: DEDUPED_SEARCHABLE,
  getPageTitle,
};
