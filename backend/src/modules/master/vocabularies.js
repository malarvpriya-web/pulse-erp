// ──────────────────────────────────────────────────────────────────────────────
// vocabularies.js — the registry behind /master/v/:vocab.
//
// WHY THIS EXISTS
// ---------------
// §170 moved five masters (departments, zones, designations, UOM, HSN) out of
// Master Data Setup and into the forms that need them, via <MasterSelect>. The
// §172 audit then swept every dropdown in the app and found ~148 vocabularies
// still held as `const X = ['a','b','c']` inside a page file. Most are harmless
// state machines. Thirteen are not: they are user-extensible business
// vocabularies, several of them copy-pasted into two or three pages that had
// already drifted apart, and the drift is visible in live data:
//
//   accounts.industry     4 of 7 stored values are not in the hardcoded list
//   project_issues.issue_type  5 of 5 stored values are not in it (case drift)
//   projects.project_type 'Primary' is stored, the list does not offer it
//   employees.employment_type holds BOTH the HR list ('Permanent') and the
//                             recruitment list ('full_time') on one column
//
// A value the <select> cannot match renders blank and is rewritten on the next
// save — the same silently-destructive bug §170 fixed for units of measure.
//
// WHY master_values AND NOT THIRTEEN NEW TABLES
// ---------------------------------------------
// `master_values` has been in the schema since the platform-foundation
// migration (type / value / code / parent_id / sort_order / is_active /
// company_id) with 18 seeded rows and — verified across backend/ and frontend/
// — ZERO application readers. It was seeded and never connected, the exact
// pattern [[project_empty_table_seed_probe_10_tables]] warns about. Reviving it
// is the single-source-of-truth answer: one table, one API, one audit path
// (`/master` already mounts behind auditMutations('master')), no new DDL per
// vocabulary. Adding a fourteenth vocabulary is a row in REGISTRY below, not a
// migration.
//
// WHAT DELIBERATELY STAYS OUT
// ---------------------------
// Three of the four types already in master_values are NOT exposed here:
//   LEAVE_TYPE      — the live master is the `leave_types` TABLE (23 rows, full
//                     policy columns). Exposing these 6 shadow rows would give
//                     leave types two sources of truth, which is the thing this
//                     module exists to prevent.
//   APPROVAL_STATUS — drives workflow transitions in code.
//   PRIORITY        — 29 tables carry a `priority` column whose values are
//                     compared, sorted and SLA-driven in code ('low' < 'high').
// A state machine is not master data. Letting a user add a 42nd project status
// does not give them a workflow, it gives them a row nothing can act on.
// ──────────────────────────────────────────────────────────────────────────────

const ADMIN = ['super_admin', 'admin'];
const HR    = ['hr', 'hr_manager', 'hr_exec'];

/**
 * Every entry is one user-extensible vocabulary.
 *
 * key    — the URL segment: GET /master/v/<key>
 * type   — the master_values.type discriminator. UPPER_SNAKE, stable forever:
 *          it is what the seeded rows carry, so renaming one orphans its rows.
 * label  — singular noun the UI puts in "+ Add new <label>…" and error copy.
 * module — which module owns it, for Master Data Setup's grouping and for the
 *          audit report. Not a permission.
 * roles  — roles whose POST/PUT/DELETE the route accepts, on top of ADMIN.
 *          MasterSelect hides its "+ Add new…" option for anyone not in this
 *          list, so the option is never offered to someone who would get a 403.
 * columns— the table.column pairs this vocabulary actually fills. Kept here so
 *          the audit report and the seeding migration are generated from the
 *          same list the API serves, rather than from a second copy that rots.
 * parentOf— OPTIONAL. The key of the vocabulary whose value scopes this one.
 *          Present on a two-level taxonomy, where a child is meaningless
 *          without its parent (an expense category with no expense type is a
 *          row no cascading picker will ever show again). `master_values`
 *          already carries `parent_id`, so this needed no schema change.
 */
export const REGISTRY = [
  // ── CRM / Sales ────────────────────────────────────────────────────────────
  {
    key: 'industries', type: 'INDUSTRY', label: 'Industry', module: 'CRM',
    roles: ['sales_manager', 'sales_exec', 'finance_manager'],
    columns: ['accounts.industry', 'leads.industry', 'parties.industry'],
  },
  {
    key: 'lead-sources', type: 'LEAD_SOURCE', label: 'Lead Source', module: 'CRM',
    roles: ['sales_manager', 'sales_exec'],
    columns: ['leads.lead_source', 'contacts.lead_source'],
  },
  {
    key: 'account-types', type: 'ACCOUNT_TYPE', label: 'Account Type', module: 'CRM',
    roles: ['sales_manager'],
    columns: ['accounts.account_type'],
  },
  {
    key: 'visit-types', type: 'VISIT_TYPE', label: 'Visit Type', module: 'CRM',
    roles: ['sales_manager', 'sales_exec', 'service_manager'],
    columns: ['visit_reports.visit_type', 'customer_visits.visit_type', 'field_visits.visit_type'],
  },

  // ── Projects ───────────────────────────────────────────────────────────────
  {
    key: 'project-types', type: 'PROJECT_TYPE', label: 'Project Type', module: 'Projects',
    roles: ['project_manager'],
    columns: ['projects.project_type'],
  },
  {
    key: 'issue-types', type: 'ISSUE_TYPE', label: 'Issue Type', module: 'Projects',
    roles: ['project_manager'],
    columns: ['project_issues.issue_type'],
  },

  // ── HR ─────────────────────────────────────────────────────────────────────
  {
    key: 'employment-types', type: 'EMPLOYMENT_TYPE', label: 'Employment Type', module: 'HR',
    roles: HR,
    columns: ['employees.employment_type', 'job_openings.employment_type',
              'job_offers.employment_type', 'job_requisitions.employment_type'],
  },
  {
    key: 'qualifications', type: 'QUALIFICATION', label: 'Qualification', module: 'HR',
    roles: HR,
    columns: ['employees.basic_qualification'],
  },
  {
    key: 'skill-types', type: 'SKILL_TYPE', label: 'Skill Type', module: 'HR',
    roles: HR,
    columns: ['employees.skill_type'],
  },
  {
    // ── Workforce category (Housekeeping, Security, Driver, Engineering…) ──
    //
    // The first vocabulary referenced by ID rather than by name:
    // employees.workforce_category_id is a real FK to master_values(id)
    // (migration 20261013000001). So `columns` is empty — there is no text
    // column holding the value — and `idColumns` names the FK instead, which
    // usage.js counts so Master Data shows "N employees" and refuses a hard
    // delete of a category in use (the FK would refuse it anyway).
    key: 'workforce-categories', type: 'WORKFORCE_CATEGORY', label: 'Workforce Category', module: 'HR',
    roles: HR,
    columns: [],
    idColumns: ['employees.workforce_category_id'],
  },
  {
    key: 'asset-types', type: 'ASSET_TYPE', label: 'Asset Type', module: 'HR',
    roles: [...HR, 'manager'],
    columns: ['employee_asset_allocations.asset_type'],
  },
  {
    // ── Bank name on an employee's salary account ────────────────────────────
    //
    // Free text until now, and the live column shows exactly what free text
    // does to a field nobody validates: company 1 holds 'ICICI' alongside
    // 'kljfsdkjf', 'vdsf' and 'czxc'. A bank name is not decoration — it is
    // half of the payment instruction payroll writes into the NEFT/ RTGS file,
    // and 'ICICI' / 'ICICI Bank' / 'ICICI Bank Ltd' are three strings that
    // reconcile as three different banks.
    //
    // ⚠ There is NO bank master table to point at, and I did not create one.
    // `bank_accounts` and `vendor_bank_details` are the company's and the
    // vendors' OWN accounts — instances, not a vocabulary — so binding an
    // employee's bank to either would be the "unrelated duplicate" trap. The
    // registry IS the master-data mechanism this codebase already has for a
    // list of standard names, so this is a row here and a seed, not a
    // migration and a fourteenth table.
    //
    // OPEN BY DESIGN. Seeded with the RBI scheduled commercial banks, which is
    // most of what an Indian payroll will ever see, but banks merge and small
    // co-operative banks are legitimate salary accounts. `+ Add new…` is open
    // to the HR roles so an unlisted-but-real bank is one click, not a support
    // ticket — and the added value lands in the master where the next employee
    // can pick it, instead of being retyped differently.
    key: 'banks', type: 'BANK', label: 'Bank', module: 'HR',
    roles: [...HR, 'payroll_admin', 'finance_manager', 'accounts_exec'],
    columns: ['employees.bank_name'],
  },
  {
    // ── Internship type (Summer, Industrial Training, Project…) ──────────────
    // Seeded by 20261013000002_internships.js. A master rather than a fixed
    // list because institutions name their programmes differently, and the
    // Add Intern form gets the same "+ Add new" the employee pickers have.
    key: 'internship-types', type: 'INTERNSHIP_TYPE', label: 'Internship Type', module: 'HR',
    roles: HR,
    columns: ['interns.internship_type'],
  },
  {
    // ── Intern education (20261013000003) ─────────────────────────────────────
    // Course spellings follow candidates.qualification ('BE/BTech', 'MBA' …) so
    // a degree is written one way across recruitment and interns. QUALIFICATION
    // above is an education LEVEL (Graduate, 12th), not a degree, so it is not
    // reused here.
    key: 'courses', type: 'COURSE', label: 'Course / Degree', module: 'HR',
    roles: HR,
    columns: ['interns.course'],
  },
  {
    key: 'specializations', type: 'SPECIALIZATION', label: 'Specialization', module: 'HR',
    roles: HR,
    columns: ['interns.specialization'],
  },
  {
    key: 'academic-years', type: 'ACADEMIC_YEAR', label: 'Year / Semester', module: 'HR',
    roles: HR,
    columns: ['interns.current_year'],
  },

  {
    // ── Background-verification check types ──────────────────────────────────
    //
    // The nine types the BGV module ships with (Identity, Address, Employment,
    // Education, Criminal/Court, Reference, Professional Reference, Document,
    // Other) are a SEED, not the vocabulary. The brief said "do NOT hard-code
    // this if the existing master-data architecture can support a proper
    // reusable master" — it does, so this is a registry row and a seed rather
    // than a `const CHECK_TYPES = [...]` in a page file, which is exactly the
    // ~148-vocabulary problem this file's header describes.
    //
    // Open to the HR roles: a tenant running a sector-specific check (a drug
    // screen, a credit check, a vendor-specific database search) adds it here
    // and every BGV screen offers it, instead of it being filed under 'Other'
    // where no spend-by-type report can ever separate it again.
    //
    // ⚠ Bound BY NAME, like every other vocabulary in this registry — the
    // column is `bgv_checks.check_type VARCHAR(100)`, not an FK. That is what
    // makes deactivating a used value safe and a hard delete unsafe; see
    // [[project_master_data_governance_2026-09-29]]. `/v/:vocab/:id/usage`
    // counts the checks using a value, so Master Setup can say so before
    // anyone tries.
    key: 'bgv-check-types', type: 'BGV_CHECK_TYPE', label: 'BGV Check Type', module: 'HR',
    roles: HR,
    columns: ['bgv_checks.check_type'],
  },

  // ── Procurement / Finance ──────────────────────────────────────────────────
  {
    key: 'vendor-categories', type: 'VENDOR_CATEGORY', label: 'Vendor Category', module: 'Procurement',
    roles: ['procurement_manager', 'procurement_exec'],
    columns: ['vendors.vendor_category'],
  },
  {
    // §216 — how an item ships, for choosing a freight rate card. Seeded with
    // General / Fragile / Hazardous / Oversize; companies add their own.
    key: 'freight-categories', type: 'FREIGHT_CATEGORY', label: 'Freight Category', module: 'Procurement',
    roles: ['procurement_manager', 'procurement_exec', 'store_keeper'],
    columns: ['inventory_items.freight_category', 'freight_rate_cards.freight_category'],
  },
  {
    key: 'payment-terms', type: 'PAYMENT_TERM', label: 'Payment Term', module: 'Finance',
    roles: ['finance_manager', 'accounts_exec', 'procurement_manager'],
    // ⚠ `parties.payment_terms` is deliberately NOT here. Five tables carry a
    // column of this name and they do not agree on what it holds: parties' is
    // an INTEGER (credit days — 30, 45, 15 in live data), the other four are
    // text ("Net 30", "50% advance"). A text vocabulary bound to the integer
    // column would write 'Net 30' into an int and 500 on the insert.
    columns: ['rfq_quotes.payment_terms', 'amc_contracts.payment_terms',
              'commercial_proposals.payment_terms', 'recruitment_agencies.payment_terms'],
  },

  // ── Travel ─────────────────────────────────────────────────────────────────
  {
    key: 'travel-types', type: 'TRAVEL_TYPE', label: 'Travel Type', module: 'Travel',
    roles: [...HR, 'finance_manager', 'sales_manager'],
    columns: ['travel_requests.travel_type', 'travel_cost_transactions.travel_type'],
  },

  // ── Expenses — a TWO-LEVEL taxonomy ────────────────────────────────────────
  //
  // ⚠ EXPENSE_TYPE is a policy key as well as a vocabulary. Both the claim path
  // (travel-reimbursement.routes.js) and the preview (travel-policy.routes.js)
  // map it to a limit column on `travel_policy_rules`:
  //
  //     Accommodation → hotel_limit_per_day
  //     Food          → meal_limit_per_day
  //     Travel        → local_conveyance_limit
  //     anything else → miscellaneous_limit
  //
  // The `else` is what makes this safe to open up: a type a user adds is still
  // policy-checked, against the miscellaneous limit. Verified in both files —
  // had either lacked that fallback, a user-added type would have created a
  // class of spend that passes no check at all, and this would belong in
  // RESERVED_TYPES instead. If you add a fourth named limit column, map it here
  // and say so, or it silently falls into miscellaneous.
  {
    key: 'expense-types', type: 'EXPENSE_TYPE', label: 'Expense Type', module: 'Travel',
    roles: [...HR, 'finance_manager', 'accounts_exec'],
    columns: ['expense_claims.expense_type', 'reimbursement_claims.claim_type'],
  },
  {
    key: 'expense-categories', type: 'EXPENSE_CATEGORY', label: 'Expense Category', module: 'Travel',
    roles: [...HR, 'finance_manager', 'accounts_exec'],
    parentOf: 'expense-types',
    columns: ['expense_claims.expense_category'],
  },
];

/** key → registry entry. */
export const BY_KEY = Object.fromEntries(REGISTRY.map(v => [v.key, v]));

/**
 * Types owned by something else. Kept as an explicit deny-list rather than
 * relying on "it isn't in REGISTRY": if someone later adds a `priorities` entry
 * without reading the header above, this is what stops it.
 */
export const RESERVED_TYPES = new Set(['LEAVE_TYPE', 'APPROVAL_STATUS', 'PRIORITY']);

/** Roles allowed to write this vocabulary. Admins may write all of them. */
export const writeRoles = (entry) => [...ADMIN, ...(entry.roles || [])];

export default REGISTRY;
