/**
 * Where a notification should take you when you click it.
 *
 * Notifications carry no route of their own — the table has `module_name`,
 * `notification_type`, `reference_id` and a `link` column that exactly one
 * writer (quality.routes.js' CAPA assignment) ever fills. So the destination is
 * derived here, from the two columns every writer does set, and the whole
 * vocabulary those writers use lives in the maps below:
 *
 *   - module_name       — 'attendance', 'procurement', … from the cron jobs and
 *                         route handlers, plus human labels ('Purchase Request',
 *                         'Sales Order', …) from WorkflowNotificationService.
 *   - notification_type — the specific event ('ap_overdue', 'meeting_invite', …),
 *                         or a bare UI badge class ('success' / 'warning' /
 *                         'approval' / 'alert') for workflow events.
 *
 * A type is more specific than a module, so TYPE_PAGE wins over MODULE_PAGE.
 *
 * Approver vs. submitter: the same module has two homes — "your leave was
 * approved" belongs on MyLeaves, "a leave is awaiting your action" on
 * LeaveApprovals. Entries that differ carry both ({ approve, self }); which one
 * is used depends on the notification reading as approver-facing, and the other
 * stays as a fallback for a role that cannot open the first.
 */
import { MERGED_ROUTES } from '@/config/autoRouter';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/* notification_type → page. Exact match, checked first. */
const TYPE_PAGE = {
  // attendance
  regularization:    { approve: 'RegularizationApprovals', self: 'AttendanceDashboard' },
  regularization_hr: { approve: 'RegularizationApprovals', self: 'AttendanceDashboard' },
  late_arrival:      'AttendanceDashboard',
  warning_issued:    'AttendanceDashboard',
  system_reminder:   'AttendanceDashboard',
  low_attendance:    'AttendanceAnalytics',
  // announcements — the reader's page (PERSONAL_PAGES, every role), never the
  // HR administration page: an employee cannot open that one, so the bell used
  // to resolve to nothing for exactly the people the announcement was for.
  announcement: 'MyAnnouncements',
  // HR
  fnf_ready_for_approval: 'Offboarding',
  interview_reminder:     'InterviewScheduler',
  intern_evaluation_request: 'MyInternEvaluations',
  // Sent to the department head asked to review a probation (ref = review id).
  // Exact match, so it wins over the 'probation_' prefix → the HR Probation page.
  probation_review_request: 'MyProbationReviews',
  // Sent to the FORMER reviewer when HR reassigns their review. It carries no
  // reference (reference_id is NULL), so this opens the page without a review.
  probation_review_reassigned: 'MyProbationReviews',
  // finance
  ap_overdue:          'PayablesPage',
  ar_overdue:          'ReceivablesPage',
  depreciation_posted: 'FixedAssets',
  // procurement
  delivery_followup:        'PurchaseOrders',
  po_overdue_delivery:      'PurchaseOrders',
  alert_overdue_delivery:   'PurchaseOrders',
  alert_vendor_rating_drop: 'VendorScorecard',
  vendor_doc_expiring:      'VendorManagement',
  reorder_draft_prs:        'PurchaseRequest',
  // sales / CRM
  quotation_expired:        'Quotations',
  subscription_renewal:     'Subscriptions',
  production_completed:     'SalesOrders',
  lead_followup_due:        'Leads',
  opportunity_followup_due: 'OpportunitiesKanban',
  upsell_opportunity:       'OpportunitiesKanban',
  // production
  mrp_auto_run:            'MRPWorkbench',
  capacity_overload_alert: 'ProductionPlanningHub',
  // quality
  calibration_due: 'EquipmentCalibration',
  // assets / maintenance / documents
  asset_warranty_expiring: 'AssetRegister',
  maintenance_due:         'AssetMaintenance',
  document_expiring:       'DocumentMaster',
  // marketing
  campaign_close_out: 'Campaigns',
  // service
  warranty_expiring: 'WarrantyManagement',
  amc_eligible:      'AMCManagement',
  // engineering / R&D
  ecn_implemented: 'ECNManagement',
  patent_expiring: 'RDHub',
  // meetings — there is no Meetings page; they live on the manager cockpit
  meeting_invite:    'ManagerDashboard',
  meeting_cancelled: 'ManagerDashboard',
  // executive
  kpi_digest: 'ExecutiveDashboard',
};

/* Prefix rules for the type families whose suffix is generated at runtime —
   `dept_kpi_digest:${slug(department)}`, `${recordType}_auto_assigned`,
   'tender_deadline_due_soon' / '…_overdue', the three amc_* renewal spellings. */
const TYPE_PREFIX_PAGE = [
  ['dept_kpi_digest', 'ExecutiveDashboard'],
  ['tender_deadline', 'TenderWorkspace'],
  ['amc_',            'AMCManagement'],
  ['compliance_',     'ComplianceRegister'],
  ['lead_',           'Leads'],
  ['opportunity_',    'OpportunitiesKanban'],
  ['quotation_',      'Quotations'],
  ['probation_',      'Probation'],
  ['interview_',      'InterviewScheduler'],
  ['calibration_',    'EquipmentCalibration'],
  ['vendor_',         'VendorManagement'],
  ['maintenance_',    'AssetMaintenance'],
  ['patent_',         'RDHub'],
];

/* module_name → page. Keys are normalised (lowercase, alphanumerics only) so
   'Purchase Request', 'purchase_request' and 'purchaserequest' all land here. */
const MODULE_PAGE = {
  attendance:    { approve: 'RegularizationApprovals', self: 'AttendanceDashboard' },
  announcements: 'MyAnnouncements',
  probation:     'Probation',
  // "Awaiting your action" → the approver inbox; "your request was approved /
  // rejected" → the same page's My Requests tab.
  approval:      { approve: 'ApprovalCenter', self: 'MyRequests' },
  approvals:     { approve: 'ApprovalCenter', self: 'MyRequests' },
  workflow:      { approve: 'ApprovalCenter', self: 'MyRequests' },
  notifications: 'NotificationCenter',

  leave:           { approve: 'LeaveApprovals', self: 'MyLeaves' },
  leaves:          { approve: 'LeaveApprovals', self: 'MyLeaves' },
  leaveencashment: 'LeaveEncashmentPage',
  compoff:         'CompOffPage',
  timesheet:       { approve: 'TimesheetApprovals', self: 'MyTimesheet' },
  timesheets:      { approve: 'TimesheetApprovals', self: 'MyTimesheet' },
  travel:          { approve: 'TravelApprovals', self: 'MyTravel' },
  traveladvance:   { approve: 'TravelApprovals', self: 'TravelAdvances' },
  expenseclaim:    { approve: 'ExpenseReview', self: 'ExpenseClaims' },
  reimbursement:   { approve: 'ExpenseReview', self: 'ExpenseClaims' },
  exp:             { approve: 'ExpenseReview', self: 'ExpenseClaims' },
  reg:             { approve: 'RegularizationApprovals', self: 'AttendanceDashboard' },
  ot:              { approve: 'OvertimeApprovals', self: 'AttendanceDashboard' },

  hr:          'HRDashboard',
  payroll:     'PayrollCenter',
  pay:         'PayrollCenter',
  increment:   'IncrementPlanning',
  promotion:   'PromotionPlanning',
  recruitment: 'RecruitmentDashboard',
  offer:       'OfferManagement',
  offerletter: 'OfferManagement',
  requisition: 'JobRequisitionPipeline',

  crm:        'CRMActivities',
  sales:      'SalesOrders',
  salesorder: 'SalesOrders',
  marketing:  'Campaigns',
  commission: 'CommissionManagement',

  procurement:     'PurchaseOrders',
  purchaseorder:   'PurchaseOrders',
  purchaserequest: 'PurchaseRequest',
  pr:              'PurchaseRequest',
  goodsreceipt:    'GoodsReceipt',

  finance:    'FinanceDashboard',
  inventory:  'StockSummary',
  production: 'ProductionOrders',
  projects:   'Projects',
  quality:    'QualityDashboard',
  qualityncr: 'NCRManagement',
  fat:        'FATTracker',
  sat:        'SATTracker',

  assets:      'AssetRegister',
  maintenance: 'AssetMaintenance',
  documents:   'DocumentMaster',
  compliance:  'ComplianceRegister',
  engineering: 'ECNManagement',
  ecn:         'ECNManagement',
  rd:          'RDHub',
  iot:         'AlertCenter',

  service:       'Tickets',
  serviceticket: 'Tickets',
  amccontract:   'AMCManagement',
  warranty:      'WarrantyManagement',

  executive:    'ExecutiveDashboard',
  intelligence: 'CEOIntelligenceDashboard',
};

/* Types that mean "this is in your queue", not "here's what happened to your
   request". WorkflowNotificationService stamps escalated as 'alert' and
   submitted/pending as 'approval'; 'warning' covers both a rejection (yours)
   and an overdue item (someone else's), so the wording decides that one. */
const APPROVER_TYPES = new Set([
  'approval', 'alert', 'approval_pending', 'regularization', 'regularization_hr',
]);
const APPROVER_TEXT = /overdue|escalat|awaiting your|pending your|needs your|requires your/i;

function isApproverFacing(n) {
  const type = String(n?.notification_type || '').toLowerCase();
  if (APPROVER_TYPES.has(type)) return true;
  return APPROVER_TEXT.test(`${n?.title || ''} ${n?.message || ''}`);
}

const isKnownPage = (page) =>
  Boolean(page) && Object.prototype.hasOwnProperty.call(MERGED_ROUTES, page);

/* An entry is either a page key or an { approve, self } pair; return its
   candidates in the order they should be tried. */
function candidatesFor(entry, approverFacing) {
  if (!entry) return [];
  if (typeof entry === 'string') return [entry];
  return approverFacing ? [entry.approve, entry.self] : [entry.self, entry.approve];
}

/* `link`, when a writer set one, is authoritative — but only if it names a real
   route. This router is one segment of PascalCase page key, so a multi-segment
   link is ignored and the module/type maps still get the click somewhere
   useful rather than onto a blank page. */
function pageFromLink(link) {
  if (!link || typeof link !== 'string') return null;
  const [path] = link.split('?');
  const segments = path.split('/').filter(Boolean);
  if (segments.length !== 1) return null;
  return isKnownPage(segments[0]) ? segments[0] : null;
}

/**
 * Resolve the click destination for a notification.
 *
 * @param {object} n  the notification row
 * @param {(page: string) => boolean} [canOpen]  role gate; a page it rejects is
 *        skipped so a click never lands on Unauthorized.
 * @returns {{ page: string, params: object } | null}  null when nothing
 *        sensible matches — the caller should then not navigate.
 */
export function notificationTarget(n, canOpen) {
  if (!n) return null;
  const allowed = (page) => isKnownPage(page) && (!canOpen || canOpen(page));

  const type = String(n.notification_type || '').toLowerCase();
  const approverFacing = isApproverFacing(n);

  const candidates = [];
  const linkPage = pageFromLink(n.link);
  if (linkPage) candidates.push(linkPage);

  candidates.push(...candidatesFor(TYPE_PAGE[type], approverFacing));

  for (const [prefix, page] of TYPE_PREFIX_PAGE) {
    if (type.startsWith(prefix)) { candidates.push(page); break; }
  }

  candidates.push(...candidatesFor(MODULE_PAGE[norm(n.module_name)], approverFacing));

  const page = candidates.find(allowed);
  if (!page) return null;

  // `ref` carries the source record id through to the page. Pages that don't
  // read it ignore it; it costs nothing and keeps the link meaningful.
  const params = n.reference_id != null && n.reference_id !== ''
    ? { ref: String(n.reference_id) }
    : {};
  return { page, params };
}

/* Every page these maps can name. A rename that orphans one of them is
   otherwise silent — the click just stops navigating — so the test suite
   asserts this list against MERGED_ROUTES. */
export const TARGET_PAGES = [...new Set(
  [...Object.values(TYPE_PAGE), ...Object.values(MODULE_PAGE)]
    .flatMap(entry => (typeof entry === 'string' ? [entry] : [entry.approve, entry.self]))
    .concat(TYPE_PREFIX_PAGE.map(([, page]) => page))
    .filter(Boolean)
)];

/** The path `navigate()` expects, or null when the notification has no home. */
export function notificationHref(n, canOpen) {
  const target = notificationTarget(n, canOpen);
  if (!target) return null;
  const base = target.page === 'Home' ? '/' : `/${target.page}`;
  const qs = new URLSearchParams(target.params).toString();
  return qs ? `${base}?${qs}` : base;
}

export default notificationTarget;
