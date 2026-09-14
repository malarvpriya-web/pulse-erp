/**
 * reportCatalog.js — the single declaration of what the Reports module offers.
 *
 * WHY THIS EXISTS
 * ---------------
 * The catalog used to live in the React page (`features/reports/pages/Reports.jsx`)
 * as a hand-maintained array, while the filters each report actually honours lived
 * in the repository. The two drifted, silently and in the user's face:
 *
 *   - the Department input rendered on all 21 reports; the backend applied it to 5,
 *     so a user filtering the GST Summary by department got the unfiltered numbers
 *     back with no error and no indication;
 *   - Project Cost was declared `hasDate: true`, so the page showed a date picker
 *     for a route that dropped `req.query` entirely;
 *   - Outstanding Invoices and Pending Approvals accepted `start_date`/`end_date`
 *     and ignored them.
 *
 * A filter that is silently dropped is worse than one that is refused: the user
 * reads a number they believe is scoped. So the catalog is now server-owned and
 * declarative. It drives three things that can no longer disagree:
 *
 *   1. `GET /reports/catalog` — the page renders exactly the controls each report
 *      supports, because it asks the server what they are.
 *   2. Request validation — a parameter a report does not declare is a 400, never
 *      a silent no-op.
 *   3. The authorization policy — `reportsPolicy` is derived from `permission`
 *      below, so a report added tomorrow is guarded by construction. There is no
 *      route-level annotation to forget.
 *
 * `permission` is the guard the underlying data would require if the user opened
 * the owning module directly — payroll figures need `payroll:view` exactly as the
 * Payroll module does. This keeps one permission model across the app rather than
 * inventing a "reports" permission that drifts from it.
 *
 * A note on the people reports. Every report in this module is company-wide:
 * `/leave` returns every colleague's applications, `/attendance` returns the
 * whole roster. They are therefore gated on `hr:view`, NOT on `leave:view` or
 * `attendance:view` — every employee holds those two, because they are what let
 * someone open their own leave balance and their own attendance. Gating a
 * company-wide roster on a self-service permission leaves it open to everyone,
 * which is the same trap `/analytics/top-performers` documents next door. This
 * module contains no self-service report; the owning modules serve those.
 */

/** Every filter name the module recognises. Anything outside this set is a 400. */
export const FILTER_NAMES = Object.freeze([
  'start_date', 'end_date', 'department', 'year', 'month', 'status', 'employee_id',
]);

/** Pagination is accepted on every report and is never counted as a report filter. */
export const PAGINATION_NAMES = Object.freeze(['limit', 'offset']);

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 5000;

/**
 * id           — URL segment under /api/reports and the stable key used by saved reports
 * category     — grouping shown in the picker
 * label / desc — user-facing copy; owned here so the page cannot describe a report
 *                as something other than what it computes
 * filters      — exactly the parameters this report honours
 * permission   — [module, action] required to read it
 * grain        — 'detail' (one row per record, drillable) | 'summary' (aggregated)
 * measures     — numeric columns, so the UI can right-align and total them without
 *                guessing from the value shape
 */
export const REPORTS = Object.freeze([
  // ── HR & People ────────────────────────────────────────────────────────────
  {
    id: 'attendance', category: 'HR & People', label: 'Attendance Summary',
    desc: 'Per-employee day counts from attendance records, split into present, absent, leave and non-working days.',
    filters: ['start_date', 'end_date', 'department'], permission: ['hr', 'view'],
    grain: 'summary',
    measures: ['recorded_days', 'present_days', 'absent_days', 'leave_days', 'non_working_days', 'total_hours'],
  },
  {
    id: 'leave', category: 'HR & People', label: 'Leave Applications',
    desc: 'Every leave application with approval trail, employee and leave type.',
    filters: ['start_date', 'end_date', 'department', 'status', 'employee_id'],
    permission: ['hr', 'view'], grain: 'detail', measures: ['number_of_days'],
  },
  {
    id: 'leave/summary', category: 'HR & People', label: 'Leave Balance Summary',
    desc: 'Allocated, used and remaining days per employee and leave type for a year.',
    filters: ['year', 'department'], permission: ['hr', 'view'], grain: 'summary',
    measures: ['allocated_days', 'used_days', 'remaining_days', 'pending_count', 'rejected_count'],
  },
  {
    id: 'leave/department', category: 'HR & People', label: 'Leave by Department',
    desc: 'Application volume, approval outcome and days taken per department.',
    filters: ['year', 'month'], permission: ['hr', 'view'], grain: 'summary',
    measures: ['total_employees', 'total_applications', 'approved', 'rejected', 'pending', 'total_days_taken', 'avg_days_per_employee'],
  },
  {
    id: 'leave/approval-performance', category: 'HR & People', label: 'Approval Turnaround',
    desc: 'Approver response times and outcomes, from the leave approval history.',
    filters: ['start_date', 'end_date'], permission: ['hr', 'view'], grain: 'summary',
    measures: ['total_actions', 'approved_count', 'rejected_count', 'avg_response_hours'],
  },
  {
    id: 'headcount', category: 'HR & People', label: 'Headcount by Department',
    desc: 'Active headcount per department, with exits and joiners shown separately.',
    filters: ['department'], permission: ['hr', 'view'], grain: 'summary',
    measures: ['active_employees', 'exited_employees', 'total_records', 'joined_last_12m'],
  },

  // ── Payroll (salary data — payroll:view) ───────────────────────────────────
  {
    id: 'payroll-summary', category: 'Payroll', label: 'Payroll Summary',
    desc: 'Gross, net and TDS totals per month and department from processed payroll runs.',
    filters: ['start_date', 'end_date', 'department'], permission: ['payroll', 'view'],
    grain: 'summary', measures: ['employee_count', 'total_gross', 'total_net', 'total_tds'],
  },
  {
    id: 'leave/liability', category: 'Payroll', label: 'Leave Encashment Liability',
    desc: 'Unused leave valued at daily rate. Contains per-employee salary-derived figures.',
    filters: ['year'], permission: ['payroll', 'view'], grain: 'summary',
    measures: ['allocated_days', 'used_days', 'balance_days', 'daily_rate', 'liability_amount'],
  },
  {
    id: 'leave/lop', category: 'Payroll', label: 'Loss of Pay',
    desc: 'LOP days and deduction value per employee per payroll month.',
    filters: ['year', 'month'], permission: ['payroll', 'view'], grain: 'detail',
    measures: ['working_days', 'present_days', 'absent_days', 'lop_days', 'lop_amount'],
  },

  // ── Sales & Revenue ────────────────────────────────────────────────────────
  {
    id: 'sales', category: 'Sales & Revenue', label: 'Sales Orders by Month',
    desc: 'Booked order value per month, excluding draft and cancelled orders.',
    filters: ['start_date', 'end_date'], permission: ['crm', 'view'], grain: 'summary',
    measures: ['order_count', 'total_revenue', 'avg_order_value'],
  },
  {
    id: 'sales-targets', category: 'Sales & Revenue', label: 'Targets vs Actual',
    desc: 'Target versus achieved value per owner and period, with achievement rate.',
    filters: ['year'], permission: ['crm', 'view'], grain: 'summary',
    measures: ['target_amount', 'actual_amount', 'achievement_pct'],
  },

  // ── Finance & Accounting ───────────────────────────────────────────────────
  {
    id: 'outstanding-invoices', category: 'Finance & Accounting', label: 'Outstanding Invoices',
    desc: 'Unpaid invoice balances net of receipts, bucketed by days past due.',
    filters: ['start_date', 'end_date'], permission: ['finance', 'view'], grain: 'detail',
    measures: ['total_amount', 'paid_amount', 'outstanding_amount', 'days_overdue'],
  },
  {
    id: 'gst-report', category: 'Finance & Accounting', label: 'GST Summary',
    desc: 'Taxable value, tax collected and gross invoiced value per month.',
    filters: ['start_date', 'end_date'], permission: ['finance', 'view'], grain: 'summary',
    measures: ['invoice_count', 'taxable_value', 'gst_collected', 'gross_amount'],
  },
  {
    id: 'expense-report', category: 'Finance & Accounting', label: 'Expense Claims',
    desc: 'Employee expense claims with category, status and claimed value.',
    filters: ['start_date', 'end_date', 'department', 'status'], permission: ['finance', 'view'],
    grain: 'detail', measures: ['total_amount'],
  },
  {
    id: 'project-cost', category: 'Finance & Accounting', label: 'Project Budget vs Actual',
    desc: 'Budget, committed spend and variance per project.',
    filters: ['status'], permission: ['projects', 'view'], grain: 'detail',
    measures: ['budget_amount', 'actual_cost', 'variance', 'utilisation_pct'],
  },

  // ── Procurement ────────────────────────────────────────────────────────────
  {
    id: 'purchase-orders', category: 'Procurement', label: 'Purchase Orders',
    desc: 'PO-level spend with vendor, dates and status.',
    filters: ['start_date', 'end_date', 'status'], permission: ['procurement', 'view'],
    grain: 'detail', measures: ['total_amount'],
  },
  {
    id: 'vendor-performance', category: 'Procurement', label: 'Vendor Performance',
    desc: 'Order volume, spend and fulfilment rate per vendor.',
    filters: ['start_date', 'end_date'], permission: ['procurement', 'view'], grain: 'summary',
    measures: ['total_orders', 'total_spend', 'fulfilled_orders', 'fulfilment_rate_pct'],
  },
  {
    id: 'pending-pos', category: 'Procurement', label: 'Pending Approvals',
    desc: 'Purchase requests and purchase orders still awaiting action.',
    filters: ['start_date', 'end_date'], permission: ['procurement', 'view'], grain: 'detail',
    measures: ['total_amount'],
  },

  // ── Inventory & Stock ──────────────────────────────────────────────────────
  {
    id: 'stock', category: 'Inventory & Stock', label: 'Stock Summary',
    desc: 'Current stock against reorder level for every item.',
    filters: [], permission: ['inventory', 'view'], grain: 'detail',
    measures: ['current_stock', 'reorder_level', 'stock_value'],
  },
  {
    id: 'stock-movement', category: 'Inventory & Stock', label: 'Stock Movement',
    desc: 'Inward and outward ledger transactions per item.',
    filters: ['start_date', 'end_date'], permission: ['inventory', 'view'], grain: 'detail',
    measures: ['quantity_in', 'quantity_out', 'balance_qty', 'rate', 'value'],
  },
  {
    id: 'low-stock', category: 'Inventory & Stock', label: 'Low Stock Alert',
    desc: 'Items at or below reorder level, with the shortfall quantity.',
    filters: [], permission: ['inventory', 'view'], grain: 'detail',
    measures: ['current_stock', 'reorder_level', 'shortage'],
  },
]);

const BY_ID = new Map(REPORTS.map(r => [r.id, r]));

export const getReport = id => BY_ID.get(id) || null;

/**
 * Ordered [pathPrefix, module, action] rules for `permissionByPath`.
 *
 * Longest path first: '/leave/liability' is payroll-grade because it exposes
 * salary, while '/leave' is leave-grade — so the specific rule has to be tested
 * before the general one.
 */
export const POLICY_RULES = REPORTS
  .map(r => [`/${r.id}`, r.permission[0], r.permission[1]])
  .sort((a, b) => b[0].length - a[0].length);

export default { REPORTS, FILTER_NAMES, PAGINATION_NAMES, DEFAULT_LIMIT, MAX_LIMIT, getReport, POLICY_RULES };
