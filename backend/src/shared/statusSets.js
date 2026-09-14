/**
 * statusSets.js — Canonical, case-insensitive status vocabularies.
 *
 * WHY THIS EXISTS
 * ---------------
 * Status columns in this schema are written with inconsistent casing by
 * different modules — `employees.status` receives 'Active' (employee.routes.js),
 * 'Notice' (exit.routes.js:243) and 'left' (exit.routes.js:440); tickets are
 * 'Open'/'In Progress'/'Resolved' from the UI but were queried as
 * ('resolved','closed') in one place and ('Resolved','Closed') in another.
 * Analytics endpoints hand-wrote their own literal lists against those columns,
 * so the same business question returned different answers on different pages
 * (CEO Intelligence showed 13 open tickets on one tab and 15 on another) and
 * several KPIs could never return a non-zero value at all.
 *
 * Every analytics/dashboard query MUST build its status predicate from this
 * module rather than inlining literals. The helpers emit `LOWER(col) IN (...)`
 * so casing can never matter again, and the set contents are the single place
 * to add a new status value.
 *
 * Do NOT interpolate user input through these helpers — they only ever emit
 * fixed literals defined in this file.
 */

/** Quote + lowercase a fixed vocabulary into a SQL list. Never takes user input. */
const list = (values) => values.map(v => `'${String(v).toLowerCase()}'`).join(',');

// ── employees ────────────────────────────────────────────────────────────────
// 'Notice' is an employee serving notice period: still on payroll, still
// counted in headcount, still in department/gender/salary aggregates. Excluding
// it (the previous behaviour) silently dropped those people from every
// workforce metric while they were still employed.
export const EMPLOYEE_ACTIVE  = ['active', 'probation', 'notice', 'confirmed'];
export const EMPLOYEE_EXITED  = ['inactive', 'terminated', 'left', 'resigned', 'ex-employee', 'relieved', 'exited'];
/** Exits the employee chose. Subset of EMPLOYEE_EXITED. */
export const EMPLOYEE_VOLUNTARY_EXIT = ['resigned', 'left'];

// ── support_tickets ──────────────────────────────────────────────────────────
export const TICKET_CLOSED   = ['resolved', 'closed', 'cancelled'];
export const TICKET_CRITICAL = ['critical'];
export const TICKET_ESCALATED = ['escalated'];

// ── projects ─────────────────────────────────────────────────────────────────
// Constrained by projects_status_check to exactly these five values. There is
// no 'on-track' status — project health is DERIVED (schedule + budget + margin),
// never stored, so any query filtering `status='on-track'` returns nothing.
export const PROJECT_OPEN    = ['planning', 'active', 'on_hold'];
export const PROJECT_ACTIVE  = ['active'];
export const PROJECT_CLOSED  = ['completed', 'cancelled'];

// ── invoices ─────────────────────────────────────────────────────────────────
// 'sent' is a real, populated status that predates the lowercase enumeration.
// It is unpaid, so it belongs in every receivable/outstanding bucket. Omitting
// it made CEO Intelligence's "Outstanding" and CFO's "AR" disagree by the exact
// value of the sent-but-unpaid invoices.
export const INVOICE_PAID     = ['paid'];
export const INVOICE_VOID     = ['cancelled', 'void', 'draft'];
export const INVOICE_UNPAID   = ['pending', 'overdue', 'sent', 'partially_paid', 'partial'];

// ── bills (AP) ───────────────────────────────────────────────────────────────
export const BILL_PAID   = ['paid'];
export const BILL_VOID   = ['cancelled', 'void', 'draft'];
// 'approved' is a real bill state: authorised for payment but not yet paid, so
// it belongs in UNPAID and counts toward accounts payable. It was missing, which
// meant an approved bill was invisible to every AP figure while still being
// money the company owes. Added after check-status-vocabulary flagged it against
// live data — that gate is the reason this was caught rather than shipped.
export const BILL_UNPAID = ['pending', 'overdue', 'sent', 'partially_paid', 'partial', 'approved'];

// ── timesheets ───────────────────────────────────────────────────────────────
export const TIMESHEET_PENDING  = ['submitted', 'pending'];
export const TIMESHEET_APPROVED = ['approved'];

// ── leave ────────────────────────────────────────────────────────────────────
export const LEAVE_APPROVED = ['approved'];
export const LEAVE_PENDING  = ['pending', 'submitted', 'applied'];

// ── job openings ─────────────────────────────────────────────────────────────
export const OPENING_OPEN = ['open', 'active', 'published', 'in_progress'];

// ── offer letters ────────────────────────────────────────────────────────────
// The authoritative offer source is `offer_letters.offer_status`. `candidates.status`
// is NOT an offer field — nothing in the app writes offer outcomes to it — so any
// acceptance-rate query built on `candidates` reports 0 forever.
// 'draft' is deliberately excluded: an offer that was never sent was never
// extended, so counting it would depress the acceptance rate.
export const OFFER_EXTENDED = ['sent', 'accepted', 'declined', 'rejected', 'expired'];
export const OFFER_ACCEPTED = ['accepted'];
export const OFFER_DECLINED = ['declined', 'rejected'];

// ── sales orders ─────────────────────────────────────────────────────────────
// There is no check constraint on sales_orders.order_status; the vocabulary the
// sales module actually writes is draft → confirmed → picking/packed/dispatched
// → delivered → invoiced, with cancelled/rejected as terminal rejects.
// The Reports module previously filtered `order_status = 'completed'`, a value
// nothing in the codebase ever writes, so its Sales Report returned ₹0 against
// live confirmed orders. Booked revenue is therefore expressed as an EXCLUSION,
// like the receivable predicates below: a status nobody anticipated lands in the
// total instead of silently disappearing from it.
export const SALES_ORDER_VOID    = ['draft', 'cancelled', 'rejected'];
export const SALES_ORDER_INVOICED = ['invoiced'];
/**
 * The full lifecycle, DECLARED rather than only described in the comment above.
 *
 * Those states have been named there since the module was written, but nothing
 * in code listed them, so `check-status-literals.mjs` — which asks whether a
 * literal in SQL names a state this system knows about — could not tell
 * `'delivered'` (real) from `'completed'` (the value that made the Sales Report
 * return zero against live confirmed orders).
 *
 * Booked revenue is still an EXCLUSION of SALES_ORDER_VOID, deliberately: an
 * unanticipated status must land IN the total rather than vanish from it. This
 * list is for recognition, not filtering.
 */
export const SALES_ORDER_LIFECYCLE = [
  'draft', 'pending', 'confirmed', 'picking', 'packed',
  'dispatched', 'delivered', 'invoiced', 'cancelled', 'rejected',
];

// ── purchase orders / requests ───────────────────────────────────────────────
export const PO_CLOSED    = ['completed', 'received', 'closed', 'cancelled', 'rejected'];
export const PO_FULFILLED = ['completed', 'received', 'closed'];
// Committed spend is an EXCLUSION for the same reason SALES_ORDER_VOID is: the
// PO vocabulary is open (`purchase_orders.status` carries no check constraint),
// so a status nobody anticipated has to land IN the spend total rather than
// silently vanish from it. Draft is excluded because it is not yet a commitment.
export const PO_VOID      = ['draft', 'cancelled', 'rejected'];
export const PR_CLOSED    = ['approved', 'rejected', 'cancelled', 'converted_to_po', 'closed'];

// ── attendance_records ───────────────────────────────────────────────────────
// The live vocabulary is mixed-case across writers ('Present' from the seed,
// 'present' from clock-in). Every bucket below is disjoint, and together they
// account for every row — a report that filters only present/absent/leave leaves
// weekend and holiday days inside its own total with no column to explain them.
export const ATTENDANCE_PRESENT = ['present', 'late', 'wfh', 'work_from_home', 'half_day', 'on_duty'];
export const ATTENDANCE_ABSENT  = ['absent'];
export const ATTENDANCE_LEAVE   = ['leave', 'on_leave', 'paid_leave', 'unpaid_leave'];
export const ATTENDANCE_OFF     = ['weekend', 'holiday', 'week_off', 'off'];

// ── vendors ──────────────────────────────────────────────────────────────────
export const VENDOR_BLOCKED = ['blocked', 'suspended'];

// ── NCR ──────────────────────────────────────────────────────────────────────
export const NCR_CLOSED = ['closed', 'cancelled'];

// ── AMC ──────────────────────────────────────────────────────────────────────
export const AMC_ACTIVE = ['active'];

// ── CRM: leads ───────────────────────────────────────────────────────────────
// The CRM audit (2026-08-19) found conversion rate pinned to 0% forever: every
// KPI counted `LOWER(status) = 'converted'`, but the live vocabulary closes a
// lead as 'Won'. Four leads worth ₹2.8 Cr were Won while the dashboard reported
// 0% conversion. A lead is "converted" if it produced business — whether that
// was recorded by the convert-to-opportunity action ('converted') or by closing
// the enquiry directly ('won'). Both are seeded here so neither path is lost.
/**
 * `shelved` is a real pursuit outcome — the Pursuits board and the lead stats
 * both count it — and it is neither converted nor lost. Declared so a literal
 * naming it is recognised as a state rather than reported as a typo.
 */
export const LEAD_SHELVED   = ['shelved'];
export const LEAD_CONVERTED = ['converted', 'won'];
export const LEAD_LOST      = ['lost', 'unqualified', 'disqualified', 'dropped'];
/** Terminal states — a lead that can no longer move. Used as the conversion denominator's exclusion. */
export const LEAD_CLOSED    = [...LEAD_CONVERTED, ...LEAD_LOST];

// A lead's FIRST funnel step is "did it get worked at all". The sales funnel
// used to define its Qualified Leads stage as `status IN ('Qualified','Hot')`
// — a two-value literal list against a live vocabulary of New / Contacted /
// Qualified / Negotiation / Won / Lost / converted. That counted 2 leads as
// qualified while 8 opportunities existed downstream, and the funnel printed
// "450% conversion" from Lead to Opportunity. A funnel stage has to be
// CUMULATIVE — a lead sitting at Negotiation obviously cleared qualification —
// so it is expressed as an exclusion, like the receivable predicates above: a
// status nobody anticipated counts as worked rather than silently vanishing
// from the numerator.
/** Leads still at first touch — created but not yet worked. */
export const LEAD_UNWORKED     = ['new', 'open', 'raw', 'untouched', 'not_contacted'];
/** Leads thrown out WITHOUT ever qualifying. A subset of LEAD_LOST — a plain
 *  'lost' lead qualified first and was lost later, so it stays in the stage. */
export const LEAD_DISQUALIFIED = ['unqualified', 'disqualified', 'junk', 'spam'];

// ── CRM: opportunities ───────────────────────────────────────────────────────
/**
 * Stages an opportunity legitimately occupies while OPEN.
 *
 * Not used for filtering — `sqlOpportunityOpen()` is an exclusion of won/lost,
 * so a stage nobody anticipated counts as open rather than disappearing — but
 * declared so the literal checker can tell a real stage from `closed_won`, a
 * value this column has never held and which six files filtered on.
 * `bidding` comes from the tender workspace, which creates opportunities there.
 */
export const OPPORTUNITY_OPEN_STAGES = [
  'prospecting', 'qualification', 'proposal', 'negotiation', 'bidding', 'shelved',
];
export const OPPORTUNITY_WON  = ['won'];
export const OPPORTUNITY_LOST = ['lost'];
export const OPPORTUNITY_CLOSED = [...OPPORTUNITY_WON, ...OPPORTUNITY_LOST];

/* ─────────────────────────────────────────────────────────────────────────────
   Canonical stored spelling.

   Every predicate below lowercases both sides, so a filter never cared how a
   state was capitalised. A GROUP BY key does: `opportunities.stage` held both
   'Qualification' and 'qualification' and the pipeline chart drew the stage
   twice, splitting its value across the two rows.

   The write side therefore has to agree on one spelling, and the one it agrees
   on is lowercase — that is `crm_pipeline_stages.stage_key`, the master's own
   rename-safe key, and it is character-for-character the vocabulary declared
   above. The display label lives in `crm_pipeline_stages.name`.

   Enforced in the database as well (migration 20260910000005): a normalising
   trigger, not a CHECK, so a stage nobody anticipated is still stored rather
   than rejected.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * The spelling a state must be STORED as. Returns null/undefined unchanged so
 * a caller can pass an optional field straight through.
 */
export const canonicalState = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/* ─────────────────────────────────────────────────────────────────────────────
   Predicate builders — always case-insensitive.
   `col` is a caller-controlled column reference, never user input.
   ───────────────────────────────────────────────────────────────────────────── */

/** `LOWER(col) IN (...)`. Returns `FALSE` for an empty set so callers can't accidentally match everything. */
export const isIn = (col, values) =>
  values.length ? `LOWER(${col}) IN (${list(values)})` : 'FALSE';

/** `(col IS NULL OR LOWER(col) NOT IN (...))` — NULL is not an exclusion. */
export const notIn = (col, values) =>
  values.length ? `(${col} IS NULL OR LOWER(${col}) NOT IN (${list(values)}))` : 'TRUE';

// Ready-made predicates for the sets analytics asks for most often.
export const sqlEmployeeActive   = (col = 'status') => isIn(col, EMPLOYEE_ACTIVE);
export const sqlEmployeeExited   = (col = 'status') => isIn(col, EMPLOYEE_EXITED);
export const sqlTicketOpen       = (col = 'status') => notIn(col, TICKET_CLOSED);
export const sqlProjectOpen      = (col = 'status') => notIn(col, PROJECT_CLOSED);
export const sqlInvoicePaid      = (col = 'status') => isIn(col, INVOICE_PAID);
export const sqlInvoiceUnpaid    = (col = 'status') => isIn(col, INVOICE_UNPAID);
export const sqlBillUnpaid       = (col = 'status') => isIn(col, BILL_UNPAID);

/**
 * Receivable/payable predicate expressed as an exclusion rather than an
 * inclusion, so a status value nobody anticipated still lands in the
 * outstanding bucket instead of silently vanishing from the balance.
 * This is the definition CFO's AR and CEO's Outstanding now BOTH use.
 */
export const sqlInvoiceOutstanding = (col = 'status') =>
  `${notIn(col, INVOICE_PAID)} AND ${notIn(col, INVOICE_VOID)}`;
export const sqlBillOutstanding = (col = 'status') =>
  `${notIn(col, BILL_PAID)} AND ${notIn(col, BILL_VOID)}`;

/** Sales orders that count as booked revenue — everything except draft/cancelled/rejected. */
export const sqlSalesOrderBooked = (col = 'order_status') => notIn(col, SALES_ORDER_VOID);
/** Purchase orders still awaiting action. */
export const sqlPoOpen  = (col = 'status') => notIn(col, PO_CLOSED);
/** Purchase orders the vendor actually delivered against — numerator of the fulfilment rate. */
export const sqlPoFulfilled = (col = 'status') => isIn(col, PO_FULFILLED);
/**
 * Purchase orders that count as committed spend — everything except
 * draft/cancelled/rejected. An exclusion, so a status nobody anticipated lands
 * IN the spend total rather than silently vanishing from it. This is the
 * predicate the spend cube and the spend trend both use.
 */
export const sqlPoCommitted = (col = 'status') => notIn(col, PO_VOID);
/** Purchase requests still awaiting action. */
export const sqlPrOpen  = (col = 'status') => notIn(col, PR_CLOSED);

export const sqlAttendancePresent = (col = 'status') => isIn(col, ATTENDANCE_PRESENT);
export const sqlAttendanceAbsent  = (col = 'status') => isIn(col, ATTENDANCE_ABSENT);
export const sqlAttendanceLeave   = (col = 'status') => isIn(col, ATTENDANCE_LEAVE);
export const sqlAttendanceOff     = (col = 'status') => isIn(col, ATTENDANCE_OFF);

// CRM. `sqlOpportunityOpen` is the pipeline predicate — anything not yet closed.
/**
 * Reached qualification or beyond — the funnel's stage-2 predicate.
 * NULL status is NOT qualified: an unset status means the lead was never worked.
 */
export const sqlLeadQualified     = (col = 'status') =>
  `(${col} IS NOT NULL AND ${notIn(col, LEAD_UNWORKED)} AND ${notIn(col, LEAD_DISQUALIFIED)})`;
export const sqlLeadConverted     = (col = 'status') => isIn(col, LEAD_CONVERTED);
export const sqlLeadLost          = (col = 'status') => isIn(col, LEAD_LOST);
export const sqlLeadOpen          = (col = 'status') => notIn(col, LEAD_CLOSED);
export const sqlOpportunityWon    = (col = 'stage')  => isIn(col, OPPORTUNITY_WON);
export const sqlOpportunityLost   = (col = 'stage')  => isIn(col, OPPORTUNITY_LOST);
export const sqlOpportunityClosed = (col = 'stage')  => isIn(col, OPPORTUNITY_CLOSED);
export const sqlOpportunityOpen   = (col = 'stage')  => notIn(col, OPPORTUNITY_CLOSED);

export default {
  EMPLOYEE_ACTIVE, EMPLOYEE_EXITED, EMPLOYEE_VOLUNTARY_EXIT,
  TICKET_CLOSED, TICKET_CRITICAL, TICKET_ESCALATED,
  PROJECT_OPEN, PROJECT_ACTIVE, PROJECT_CLOSED,
  INVOICE_PAID, INVOICE_VOID, INVOICE_UNPAID,
  BILL_PAID, BILL_VOID, BILL_UNPAID,
  TIMESHEET_PENDING, TIMESHEET_APPROVED,
  LEAVE_APPROVED, LEAVE_PENDING,
  OPENING_OPEN, OFFER_EXTENDED, OFFER_ACCEPTED, OFFER_DECLINED,
  VENDOR_BLOCKED, NCR_CLOSED, AMC_ACTIVE,
  SALES_ORDER_VOID, SALES_ORDER_INVOICED,
  PO_CLOSED, PO_FULFILLED, PO_VOID, PR_CLOSED,
  ATTENDANCE_PRESENT, ATTENDANCE_ABSENT, ATTENDANCE_LEAVE, ATTENDANCE_OFF,
  LEAD_CONVERTED, LEAD_LOST, LEAD_CLOSED, LEAD_UNWORKED, LEAD_DISQUALIFIED,
  OPPORTUNITY_WON, OPPORTUNITY_LOST, OPPORTUNITY_CLOSED, OPPORTUNITY_OPEN_STAGES,
  LEAD_SHELVED, SALES_ORDER_LIFECYCLE,
  canonicalState,
  isIn, notIn,
  sqlEmployeeActive, sqlEmployeeExited, sqlTicketOpen, sqlProjectOpen,
  sqlInvoicePaid, sqlInvoiceUnpaid, sqlBillUnpaid,
  sqlInvoiceOutstanding, sqlBillOutstanding,
  sqlSalesOrderBooked, sqlPoOpen, sqlPoFulfilled, sqlPoCommitted, sqlPrOpen,
  sqlAttendancePresent, sqlAttendanceAbsent, sqlAttendanceLeave, sqlAttendanceOff,
  sqlLeadConverted, sqlLeadLost, sqlLeadOpen, sqlLeadQualified,
  sqlOpportunityWon, sqlOpportunityLost, sqlOpportunityClosed, sqlOpportunityOpen,
};
