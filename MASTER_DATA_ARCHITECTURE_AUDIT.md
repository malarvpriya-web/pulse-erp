# Master Data Architecture — Audit & Remediation

**Pulse ERP · §172–§173 · 2026-09-16 → 17**

Brief: *"users must navigate to Master Settings to add Zones, Departments,
Designations… this creates unnecessary navigation and reduces usability."*

The audit came first, and it changed the shape of the job. This was presented as
a navigation problem. About a third of it was. The rest was **silent data loss**:
dropdowns built from hardcoded arrays that had drifted away from the values
actually stored in the columns they write to, so opening an existing record for
edit showed a blank field, and saving it wrote the blank back.

---

## 1. What was found

A scan of `frontend/src/**` for pure string-literal arrays found **381**, of
which **148** read as a business vocabulary (`*_TYPES`, `CATEGORIES`, `SOURCES`,
`INDUSTRIES`, …). They divide three ways:

| | Count | Disposition |
|---|---:|---|
| State machines / code-coupled enums | ~110 | **Left alone** — see §5 |
| A real master existed; the page did not read it | 4 | Wired up |
| User-extensible vocabulary with no master anywhere | **13** | New registry |

### 1.1 The drift, measured in live data

Four of those thirteen had already diverged from their own columns:

| Column | Stored values the dropdown never offered |
|---|---|
| `accounts.industry` | **4 of 7** — `IT Services`, `Analytics`, `Engineering`, `FMCG` |
| `project_issues.issue_type` | **5 of 5** — the array was lowercase, the column is Title Case |
| `projects.project_type` | `Primary` |
| `employees.employment_type` | holds **both** `Permanent` (HR's list) and `full_time` (recruitment's) |

A `<select>` cannot render a value that is not among its options. It falls back
to the first option, and the next save writes that. So every account carrying an
industry the CRM never offered — and **every** project issue in the table — was
one edit away from losing a field nobody had touched.

### 1.2 The duplication

The same list, copy-pasted and then edited independently:

| Vocabulary | Copies | Notes |
|---|---:|---|
| `INDUSTRIES` | 3 | `Accounts.jsx`, `Leads.jsx`, `Parties.jsx` — identical today, all 11 items, none matching live data |
| `PROJECT_TYPES` | 3 frontend + 1 backend | `shared/projectTypes.js` also validated writes against its own copy |
| `VISIT_TYPES` | 3 | 13 / 7 / 13 items — three *different* vocabularies on the same kind of column |
| `VENDOR_CATEGORIES` | 2 | `VendorManagement.jsx` + `ProcurementSettings.jsx` |
| `ASSET_TYPES` | 3 | `AddEmployee`, `EditEmployee`, `EmployeeAssets` |
| `ZONES` | 3 backend | `complaints`, `ips`, `servicedesk` routes |

### 1.3 The half a frontend change does not fix

Three route modules validated these vocabularies against **their own** arrays:

```js
complaints.routes.js:552   PROJECT_TYPES.includes(body.service_type) ? body.service_type : null
servicedesk.routes.js:639  oneOf(body.zone, ZONES)
```

A project type added through a new picker would have been accepted by the master,
offered in the dropdown, chosen by the user — and then **written as NULL**. A
validator that does not read the master is not a validator; it is a second master
that silently disagrees with the first.

---

## 2. Complete master data inventory

### 2.1 Module vocabularies — now contextually creatable (`master_values`)

| Entity | Module | Endpoint | Rows | Columns it fills |
|---|---|---|---:|---|
| Industry | CRM | `/master/v/industries` | 15 | `accounts.industry`, `leads.industry`, `parties.industry` |
| Lead Source | CRM | `/master/v/lead-sources` | 11 | `leads.lead_source`, `contacts.lead_source` |
| Account Type | CRM | `/master/v/account-types` | 5 | `accounts.account_type` |
| Visit Type | CRM | `/master/v/visit-types` | 19 | `visit_reports`, `customer_visits`, `field_visits` `.visit_type` |
| Project Type | Projects | `/master/v/project-types` | 10 | `projects.project_type` |
| Issue Type | Projects | `/master/v/issue-types` | 7 | `project_issues.issue_type` |
| Employment Type | HR | `/master/v/employment-types` | 8 | `employees`, `job_openings`, `job_offers`, `job_requisitions` `.employment_type` |
| Qualification | HR | `/master/v/qualifications` | 7 | `employees.basic_qualification` |
| Skill Type | HR | `/master/v/skill-types` | 3 | `employees.skill_type` |
| Asset Type | HR | `/master/v/asset-types` | 13 | `employee_asset_allocations.asset_type` |
| Vendor Category | Procurement | `/master/v/vendor-categories` | 12 | `vendors.vendor_category` |
| Payment Term | Finance | `/master/v/payment-terms` | 10 | `rfq_quotes`, `amc_contracts`, `commercial_proposals`, `recruitment_agencies` `.payment_terms` |
| Travel Type | Travel | `/master/v/travel-types` | 13 | `travel_requests`, `travel_cost_transactions` `.travel_type` |

### 2.2 Table-backed masters (pre-existing)

| Entity | Table | Rows | API | Contextual add |
|---|---|---:|---|---|
| Department | `master_departments` | 15 | `/master/departments` | ✅ §170 |
| Zone | `master_zones` | 5 | `/master/zones` | ✅ §170 |
| Designation | `master_designations` | 24 | `/master/designations` | ✅ §170 |
| Grade | `master_grades` | 7 | `/master/grades` | ✅ §170 |
| Band | `master_bands` | 6 | `/master/bands` | ✅ §170 |
| Unit of Measure | `master_uom` | 30 | `/master/uom` | ✅ §170 |
| HSN / SAC | `master_hsn_sac` | 5 | `/master/hsn` | ✅ §170 |
| Item Category | `item_categories` | 12 | `/inventory/catalog/categories` | ✅ **§172** |
| Leave Type | `leave_types` | 23 | Leave Settings | ➖ own screen |
| Skill Category | `master_skill_categories` | 15 | `/hr-master/skill-categories` | ➖ HR Settings |
| Service Issue Category | `service_issue_categories` | 5 | `/ips/categories` | ➖ full CRUD on its own page |
| Cost Centre | `cost_centers` | 5 | `/cost-centers` | ➖ full CRUD on its own page |
| Pipeline Stage | `crm_pipeline_stages` | 6 | `/crm/pipeline-stages` | ➖ ordered + probability-weighted |
| Win/Loss Reason | `crm_win_loss_reasons` | 10 | `/crm/win-loss-reasons` | ➖ own page |
| Document Type | `document_types` | 17 | `/admin/document-setup` | ➖ own page |
| Warehouse | `warehouses` | 15 | `/warehouse` | ➖ a facility, not a vocabulary |
| Warehouse Zone | `warehouse_zones` | 5 | `/warehouse/zones` | ➖ child of a warehouse |
| Work Centre | `work_centres` | 6 | `/production/work-centres` | ➖ 21 columns (capacity, rates) |
| Sales Territory | `sales_territories` | 7 | `/sales/territories` | ➖ owns assignment rules |
| Expense Type → Expense Category | `master_values` (two-level) | 10 → 30 | `/master/v/expense-types`, `…/expense-categories` | ✅ **§173** |
| Ticket Category | `ticket_categories` | 22 | `/finance/ticket-categories` | ✅ **§173** |

---

## 3. What was built

### 3.1 One registry, no new tables

`master_values` has been in the schema since the platform-foundation migration
with 18 seeded rows and — verified across `backend/` and `frontend/` — **zero
application readers**. Seeded and never connected. Reviving it gives one table,
one API, one audit path, and makes a fourteenth vocabulary a row in a registry
rather than a migration.

```
backend/src/modules/master/vocabularies.js     REGISTRY — 15 entries
backend/src/modules/master/master.routes.js    GET/POST/PUT/DELETE /master/v/:vocab (+ ?parent=)
backend/src/shared/masterVocabulary.js         the SERVER-side read
frontend/src/components/core/VocabSelect.jsx   <VocabSelect vocab="industries" …>
frontend/src/components/core/MasterSelect.jsx  the picker (search + inline add)
```

`GET /master/v` serves the registry itself — key, label, module, columns, **and
the roles the write routes enforce**. Master Data Setup builds its tabs from it
and `VocabSelect` resolves its `addRoles` from it, so there is no second copy in
the frontend to drift.

### 3.2 Pickers

`MasterSelect` stays a native `<select>` up to 12 options and becomes a
**searchable combobox** past it. Click opens the whole list before anything is
typed; typing narrows it; re-opening a picker that already holds a value shows
everything again rather than filtering to the one row already chosen.

`allowAdd={false}` on **filter** pickers. A filter narrows what is already there;
minting a master value from one produces a filter matching nothing, with no
explanation on screen.

After a successful add the new value is **selected automatically**, the list
refreshes without a page reload, and a green line says what happened.

### 3.3 Pages wired

18 pages now read a master instead of an array:

| Module | Page | Vocabulary |
|---|---|---|
| CRM | Accounts, Leads, Parties | Industry |
| CRM | Accounts | Account Type |
| CRM | Leads | Lead Source |
| Projects | Projects, ProjectPipelineBoard\*, ProductionDeliveryTracker\* | Project Type |
| Projects | IssueManagement | Issue Type |
| HR | AddEmployee, EditEmployee | Employment Type, Qualification, Skill Type, Asset Type |
| Procurement | VendorManagement (form + filter\*) | Vendor Category |
| Travel | TravelRequests | Travel Type |
| Travel | VisitReports, CustomerVisits (form + filter\*) | Visit Type |
| Inventory | ItemMaster | Item Category |

`*` filter picker — reads the master, does not offer to extend it.
Plus the seven §170 pages (UserSetup, Contacts, JobOpenings, TravelPolicyEngine,
Add/EditEmployee, ItemMaster), unchanged.

### 3.4 Backend validators now read the master

`shared/masterVocabulary.js` — `vocabularyValues(type, companyId, fallback)` and
`canonicalValue(…)`, 60-second cache, applied at 11 call sites across
`complaints.routes.js`, `servicedesk.routes.js`, `ips.routes.js` and
`deliveryTracker.routes.js`.

**Every call site passes the array it replaced as the fallback.** A database blip
must not turn every zone and service type in an incoming request into NULL —
refusing to narrow is the safe direction for values that are recorded, not
authorising.

`canonicalValue` matches case-insensitively and returns **the master's** spelling,
so a free-text column converges on one form instead of accumulating
`EPC`/`epc`/`Epc` — which is how `issue_type` ended up with four spellings.

---

## 4. Permissions, audit and tenancy

### 4.1 Per-vocabulary write roles

Not one blanket admin gate. HR may add a qualification; HR may **not** add a
vendor category. `MasterSelect` hides "+ Add new…" for anyone whose POST the
backend would refuse, using the role list the backend itself serves — so the
option is never offered to someone who would get a 403, and the two lists cannot
drift.

Reads are open to any authenticated user: self-service forms (travel, expense)
need this reference data, and a read gate keyed to admin would empty exactly the
dropdowns the people who use them most depend on.

### 4.2 Row ownership

| | Meaning | Writable by |
|---|---|---|
| `company_id IS NULL` | seeded product default | a **globally** scoped super admin only |
| `company_id = <cid>` | the tenant's own addition | that tenant |

A scoped admin renaming a shared row gets **409 with the reason**, not a silent
no-op — and Master Data Setup marks those rows `built in` and hides their
Rename/Delete buttons rather than moving the refusal to after the click. Another
tenant's row is **404**, which must not be a 409: a 409 confirms it exists.

### 4.3 Audit

`/master` already mounts behind `auditMutations('master')`, so every create,
rename and retire is logged with the user, the path and the payload.

**Gap closed:** `captureBefore` was missing from four master routes. Renames and
retires on departments / zones / designations / grades / bands reached the audit
log with `old_data_json: null` — the entry recorded *that* a name changed but not
what it changed **from**, which for a vocabulary every employee row and report
filter references is the only question worth asking afterwards. All master writes
now carry a before-image.

### 4.4 Duplicate prevention

The pre-existing `UNIQUE (type, code, company_id)` did **nothing** for the UI:
`code` is nullable and Postgres treats NULLs as distinct, so two rows both called
"Technology" never collided. Migration `20260916000010` adds

```sql
UNIQUE (type, COALESCE(company_id, 0), LOWER(BTRIM(value)))
```

The index cannot express the other half — a tenant adding "Technology" when the
**shared** default already says "Technology" belongs to no company, so no
per-company constraint sees it. The route checks shared + own before inserting;
the index closes the race behind it. The error names the value that collided.

---

## 5. What is deliberately NOT master data

The brief listed some of these. Each is a considered refusal, not an oversight.

| | Why |
|---|---|
| **Priorities** | 29 tables carry a `priority` column that is compared, sorted and SLA-driven in code (`low` < `high`). A user-added priority has no position in that order. |
| **Approval statuses** | Drive workflow transitions in code. |
| **Project / PR / order statuses** | State machines. `projects.status` has a **CHECK constraint** — it is an enum, not a vocabulary. |
| **Recruitment stages** | `applied → screening → 1st_level → …` drives the kanban and the backend transition rules. |
| **Leave types** | The live master is the `leave_types` **table** (23 rows, 30+ policy columns). The 6 shadow rows in `master_values` are not exposed — two sources of truth is the thing this work exists to prevent. |
| **`parties.payment_terms`** | It is an **INTEGER** (credit days: 30, 45, 15 in live data) while the other four `payment_terms` columns are text. A text master bound to it would 500 on insert. Only the four text columns are mapped. |

Letting someone add a 42nd project status does not give them a workflow. It gives
them a row nothing can act on.

---

## 6. The two gaps — closed in §173

Both were reported in §172 as unfixed. Each was hiding something larger than the
missing picker.

### 6.1 Expense — three vocabularies for one domain ✅

| where | shape | wrote |
|---|---|---|
| `ExpenseClaims.jsx` | hardcoded **two-level** (5 groups, 20 items) | `expense_claims.expense_type` / `.expense_category` |
| `EmployeeSelfService.jsx` | a different, **lowercase** `CLAIM_TYPES` | `reimbursement_claims.claim_type` |
| `expense_categories` table | 11 curated rows **with descriptions** | nothing — seed script only |

The only one an administrator could see was the one nothing read.

**The caution §172 raised turned out not to apply — because I checked it rather
than asserting it.** `expense_type` is a policy key: the claim path and the
preview both map Accommodation / Food / Travel to a specific limit column on
`travel_policy_rules`. But both files also carry an `else` to
`miscellaneous_limit`, so a user-added type is **still policy-checked**. That
fallback is the whole reason this could be opened up; without it the vocabulary
would have belonged in the refused list at §5. The three named spellings are now
load-bearing and a test asserts them.

`master_values.parent_id` was already in the schema, so the two-level taxonomy
needed **no DDL**:

- `GET /master/v/expense-categories?parent=Food` — parent matched by **name**,
  because the page already holds the parent's stored text.
- ⚠ An unknown parent returns `[]`, never everything. A cascading picker showing
  all children under a parent that does not exist invites choosing a value the
  record cannot mean.
- `POST` **refuses a child with no parent**. Written without one it is a row no
  cascading picker will ever show again — accepted, invisible, undeletable.

⚠ The unique index is `(type, company, value)` and excludes the parent, so a
category name lives under one type only. Correct — two same-named rows are
indistinguishable once written as plain text — but it bit during seeding:
`Miscellaneous` under both Site and Other silently no-opped, and **Other shipped
with an empty child list** for one draft. There is now a test that every expense
type has at least one category.

Also fixed: changing the type used to auto-select the new type's **first item**,
so switching Travel→Food silently turned a Flight into a Breakfast on a
half-filled claim. It clears instead.

### 6.2 Tickets — an FK that had never been set, and a fourth list ✅

`support_tickets` carries **both** `category` (varchar, live) and `category_id`
(FK → `ticket_categories`). The repository bound `category_id` **into the
`category` column** — an integer into a varchar — so a ticket raised from the
finance Tickets page stored `"3"` where every reader expects `"Network"`, and
`category_id` was **NULL on all 15 rows ever created**. `findById` joins on that
FK, so its `category_name` was always null.

Counting the vocabularies for this one column found **four**:

| | count | status |
|---|---:|---|
| `ticket_categories` | 8 | Hardware, Software, Network… — nothing used it |
| `support_tickets.category` | 11 | HR, Finance, IT, Attendance, Payroll… — the live data |
| `SupportDashboard.jsx`, inline in the JSX | 9 | **the only one users could reach** |
| finance `Tickets.jsx` | by id | registered in `routes.jsx`, in **no menu** |

⚠⚠ **The page §172's report pointed at is an orphan.** `/Tickets` resolves to the
Service Desk, not to `features/finance/pages/Tickets.jsx` — which is registered
and reachable by nobody, so wiring a picker there would have been correct and
invisible. Found only by driving the page in a browser and looking at what
actually rendered. The fix went where users are.

The migration seeds the **union (22)**, so one master orphans no ticket and
removes no value the live dialog offered, then backfills `category_id` — 15 of 15
now linked. A rename updates the tickets' text too, or every existing ticket
would show the old name and no longer match its own category row.
`POST/PUT/DELETE /finance/ticket-categories` are new: until now this table could
be changed from neither a module page nor Master Settings.

### 6.3 Still open, and deliberately so

`expense_categories` (the table) is left in place, unread — the 11 descriptions
are the only thing in it worth keeping and nothing consumes them. Dropping it is
a separate call. The finance `Tickets.jsx` page remains an orphan: its picker is
fixed but nothing routes to it, and deciding whether it should exist at all is
not a master-data question.

### 6.4 Centrally managed by design

| Entity | Why it stays in Master Settings |
|---|---|
| Unit of Measure, HSN / SAC | Multi-column and consequential — an HSN code carries a GST rate that flows into invoices. |
| Grade, Band | `MasterSelect` is add-only by design; both are already reachable from the employee form. |
| Work Centre | 21 columns (capacity, cost rates, shift hours). Not a vocabulary. |
| Warehouse, Warehouse Zone | Facilities with addresses, capacity and a parent-child relationship. |
| Sales Territory | Owns assignment rules and revenue targets. |
| Pipeline Stage | Ordered, probability-weighted, with `is_won` / `is_lost` semantics. |
| Document Type, Win/Loss Reason, Cost Centre, Service Issue Category, Skill Category | Each already has full CRUD on its own settings page — a second entry point would be the duplication this work removes. |

### 6.5 ⚠ Seeded placeholder values, reported not adopted

Four columns hold the **same four words**:

```
project_issues.issue_type              Primary, General, Standard, Routine
visit_reports.visit_type               Primary, General, Standard, Routine
customer_visits.visit_type             Primary, General, Standard, Routine
employee_asset_allocations.asset_type  Primary, General, Standard, Routine
```

That is not four vocabularies. It is one placeholder list written across every
free-text `*_type` column by an earlier empty-table seeding pass. The usual move
— union the master with `SELECT DISTINCT` so nothing drops out of its dropdown —
would have enshrined junk as configuration, so it was **not** done. Nothing is
lost: `MasterSelect` renders a stored value absent from the master as its own
option, so those records still show their value and still round-trip a save.

`INDUSTRY` is the one exception — its off-list values are real customer data, and
are adopted per-company, minus the placeholder words.

---

## 7. Verification

| Suite | Result |
|---|---|
| `integration.masterVocabularies.test.js` (new) | **34 passing** — real database, four roles, two companies |
| `integration.ticketCategories.test.js` (new) | **12 passing** — reads the COLUMNS, not the response |
| `masterSelect.test.jsx` (new) | **27 passing** — component contract |
| `23-master-data.spec.ts` (new, `--project=master-data`) | **11 passing** — browser, end to end |
| Backend full suite | **77 of 78 files / 1677 passing**, 9 skipped — see below |
| Frontend full suite | **23 files / 524 passing** |

The one backend failure is **not from this work**. `unit.csvWriter.test.js` is a
repo guard that statically scans for hand-rolled CSV escaping, and its entire
offender list is `migrations/20260917000004_pct_family_seed_purge.js` — a file
written by a concurrent session, not touched here. Verified by running the suites
this work touches in isolation.

⚠ **One test in this work first passed for the wrong reason.** The RBAC case for
ticket categories went green claiming an `employee` could write.
`permissionFor()` checks the `permissions` table **by user_id first** and only
falls back to `role_permissions`, and user 1 carries a user-level row granting
`finance.can_add` — so any RBAC assertion built on user 1 passes regardless of
role. The suite now resolves a real employee account with no user-level override
in `beforeAll` rather than hardcoding an id, since a fixed id could quietly
acquire one later and the test would stay green while the gate went open.

Every negative case is paired with a positive one. A permission suite that only
asserts "HR is refused" passes just as happily when the endpoint is broken for
everyone.

**Covered:** create from a module page → appears in Master Settings → appears in
a *different* page's dropdown; edit and deactivate where permitted; duplicate
prevention (exact, case, whitespace, and against a shared default); permission
restriction per vocabulary; API validation; persistence across a full reload;
tenant isolation both directions; and that existing workflows still pass.

⚠ **The Playwright teardown initially leaked test rows into a shared master and
reported a clean run.** `browser.newPage()` opens a context **without** the
project's storageState, so `localStorage` was empty there, every DELETE went out
as `Bearer null`, and the `.catch()` that stops teardown from masking a real
failure swallowed it. The token is now captured during the tests, and the
teardown names anything it could not remove instead of failing quietly.

---

## 8. Files changed

**Backend**
```
src/modules/master/vocabularies.js                        new — the registry (15 entries)
src/modules/master/master.routes.js                       + /master/v CRUD, + ?parent=, + captureBefore ×4
src/modules/finance/routes/extended.routes.js             + ticket-category writes; expense-categories repointed
src/modules/finance/repositories/ticket.repository.js     the id-into-a-varchar-column fix
src/database/migrations/20260917000020_expense_and_ticket_taxonomies.js  new
src/__tests__/integration.ticketCategories.test.js        new
src/shared/masterVocabulary.js                            new — server-side master reads
src/modules/complaints/complaints.routes.js               validators read the master
src/modules/servicedesk/routes/servicedesk.routes.js      validators read the master
src/modules/servicedesk/routes/ips.routes.js              dropdown feeds read the master
src/modules/projects/routes/deliveryTracker.routes.js     dropdown feeds read the master
src/database/migrations/20260916000010_module_master_vocabularies.js   new
src/__tests__/integration.masterVocabularies.test.js      new
src/__tests__/integration.criticalFlow.test.js            mock sequence + 2 slots
```

**Frontend**
```
src/components/core/VocabSelect.jsx                       new; + cascading (parent)
src/components/core/MasterSelect.jsx                      + search, + allowAdd, + createExtra, + success line, + test hooks
src/features/servicedesk/pages/SupportDashboard.jsx       the ticket picker users actually reach
src/features/travel/pages/ExpenseClaims.jsx               cascading type → category
src/features/hr/pages/EmployeeSelfService.jsx             claim type unified onto the same master
src/features/admin/pages/MasterSetup.jsx                  tabs from the registry, built-in badge, ParentedListTab
src/features/admin/pages/MasterSetup.css                  grouped tab strip
src/__tests__/masterSelect.test.jsx                       new
… 11 module pages wired (see §3.3)
```

**Tests / docs**
```
tests/suites/23-master-data.spec.ts                       new
playwright.config.ts                                      + master-data project
Pulse/MODULE_FEATURE_CONNECTION_MANUAL.md                 + §172, + §173
```
