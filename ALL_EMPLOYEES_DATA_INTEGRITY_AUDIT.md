# All Employees — Data Integrity & Table Usability Audit

**Date:** 2026-09-28 · **Page:** Employees → All Employees (`frontend/src/features/employees/pages/EmployeesData.jsx`)
**Data:** live database, company 1 — 34 employee rows, 32 current, 2 exited, 0 soft-deleted

Every number below was read from the live database or produced by a live API call, not inferred
from the code. Where a probe created a row, the row was deleted afterwards and the deletion
verified.

---

## 1. Why Employee IDs are missing

`employees.office_id` had **three generators that did not agree**, and no database constraint of
any kind — no unique index, no format check, no NOT NULL.

| # | Path | Format produced |
|---|------|-----------------|
| 1 | `employee.service.js` `computeNextCode()` — the Add Employee API | `EMP001` |
| 2 | `recruitment.repository.js` `hireCandidate()` — candidate → employee | `EMP-0001` |
| 3 | `scripts/security/pilot-provision.mjs` — RBAC pilot logins | **nothing (NULL)** |

**Path 3 is the answer to the question.** It inserts employees directly:

```sql
INSERT INTO employees (first_name, last_name, company_email, department, status, company_id, joining_date)
VALUES ($1, $2, $3, $4, 'Active', $5, CURRENT_DATE)
```

No `office_id`, no `designation`. All 24 blank Employee IDs and 24 of the 26 blank Roles in
company 1 are rows from this script — Pilot HR, Pilot Finance, Pilot Production and so on. They
are login fixtures for role-based access testing, not HR master records, but they are on the
register and HR sees them.

### Path 1 was worse than inconsistent — it was actively broken

```js
const codeRes = await client.query("SELECT office_id FROM employees ORDER BY id DESC LIMIT 1");
office_id = computeNextCode(codeRes.rows[0]?.office_id);
```

No company filter. On live data the globally-newest row belonged to another tenant and carried a
NULL `office_id`, so `computeNextCode` took its "first ever employee" branch and returned
**`EMP001`** — the code employee id=1 has held since February. The only duplicate check in the
function guarded the *caller-supplied* branch, so the auto-generated path (the one the UI uses)
was the single path nothing checked.

**Verified live, then rolled back:** one `POST /employees` produced

```
id 8446  office_id 'EMP001'  company_id 1     ← alongside id 1, office_id 'EMP001', company_id 1
```

It was also one row away from emitting something that is not a code at all. Given the dashed
format from path 2:

```
parseInt('EMP-0002'.substring(3), 10)        →  parseInt('-0002')  →  -2
`EMP${String(-2 + 1).padStart(3, '0')}`      →  'EMP0-1'
```

A fixed `substring(3)` offset cannot read both families, and it reads one of them as a negative
number.

### Fix

`backend/src/shared/employeeCode.js` is now the only thing that mints a code. It is:

- **company-scoped** — Employee IDs are a company's own numbering;
- **serialised** by a company-scoped `pg_advisory_xact_lock`, held to COMMIT;
- **aware of both families** — `MAX()` over the numeric suffix of every `EMP`-prefixed code in the
  company, whatever the spelling. Company 1's legacy rows reach `EMP012`, so the next code is
  `EMP-0013`, colliding with neither family. (The recruitment path read only `^EMP-[0-9]+`, saw a
  max of 2, and was minting `EMP-0003` — straight into the occupied range.)

Canonical format: **`EMP-0001`**, chosen because `shared/docNumber.js`, `utils/generateCode.js`
and the recruitment hire path had already settled on it, and it matches every other document
number in Pulse (`PR-0001`, `GRN-0001`, `IPS-00001`).

### Database guards — migration `20260928000001`

- `employees_office_id_company_uniq` — UNIQUE on `(COALESCE(company_id,0), LOWER(office_id))`,
  partial on `office_id IS NOT NULL`. Per company, because two tenants may legitimately both have
  `EMP-0001`. On `LOWER()`, because that is how the application compares — an index that disagrees
  with the check it backs is not a backstop.
- `employees_office_id_format` — `CHECK (office_id IS NULL OR office_id ~ '^EMP-?[0-9]{3,}$')`.

> ⚠ **The format CHECK is deliberately permissive, and this is load-bearing.** Postgres evaluates a
> CHECK on every **UPDATE** as well as every INSERT, `NOT VALID` included — `NOT VALID` only skips
> the initial full-table scan, it does not exempt grandfathered rows from later writes. A strict
> `^EMP-[0-9]{4,}$` CHECK would have left the 8 legacy `EMP001`-style rows in place and then
> **rejected the next edit to one of those employees' phone numbers** — breaking editing for exactly
> the records the constraint was added because of. The strict format is enforced in the minting code
> instead. There is a regression test for this (`a LEGACY-format row is still editable`).

Also added: `20260928000002` — `employees_company_email_uniq`, UNIQUE on
`(COALESCE(company_id,0), LOWER(TRIM(company_email)))`. `addEmployee`'s new duplicate-email check
is a check-then-act pair against a table it holds no lock on; the index is what makes the
invariant true.

**No `NOT NULL` yet** — it cannot be added until the 24 blank rows are backfilled, and that is a
data change that gets approved, not smuggled into a schema migration. See §3.

---

## 2. Does Employee ID generation work through every creation path?

There are exactly **two** application creation paths (`grep 'INSERT INTO employees'` across
`backend/src`, excluding tests and migrations), plus provisioning scripts. **There is no
bulk/CSV import for employees.**

| Path | Before | After |
|------|--------|-------|
| Add Employee screen → `POST /employees` | `EMP001` from an unscoped read; duplicate possible | `EMP-0013` from the shared generator, unique-checked under the lock |
| `POST /employees` API direct | same | same |
| Recruitment → Employee (`hireCandidate`) | own copy, `^EMP-[0-9]+` MAX only | calls `nextEmployeeCode()` |
| `GET /employees/next-code` (form prefill) | unscoped → returned `EMP001`, already in use | company-scoped → `EMP-0013` |
| Add Employee form `.catch()` fallback | **a fourth generator in the browser**: scanned the whole list for a max and minted `'EMP' + padded` | removed; on failure the field reads "Assigned on save" and the server mints it |
| `pilot-provision.mjs` | no `office_id` | unchanged — it is a fixture script, and the DB now rejects a malformed code from it |
| Bulk/CSV import | does not exist | does not exist |

Live verification after the change:

```
GET  /employees/next-code                     → {"code":"EMP-0013"}
POST /employees (valid)                       → 200, office_id "EMP-0013"
POST /employees (office_id 'EMP001')          → 409  "Employee ID EMP001 is already in use"
POST /employees (office_id 'EMP0-1')          → 400  "not a valid Employee ID"
INSERT ... office_id 'EMP001' (raw SQL)       → rejected by employees_office_id_company_uniq
INSERT ... office_id 'EMP0-1' (raw SQL)       → rejected by employees_office_id_format
UPDATE legacy EMP001 row                      → allowed
```

---

## 3. Which existing records have missing Employee IDs

24 rows in company 1 (23 current + 1 exited). All are `pilot-provision.mjs` fixtures:

```
ids 14,15,16,17,18,19,20,21,28,29,31,32,33,34,35,36,37,38,39,40,41,42,43,44
```

Plus 11 rows in test tenants (`admin_a_ZZGEN_…@pulse.test`, companies 565–4623) — leftover
fixture debris from an earlier tenant-isolation sweep.

**8 rows carry the legacy `EMP001` format and are deliberately left alone:** `EMP001, EMP002,
EMP003, EMP005, EMP006, EMP010, EMP011, EMP012`. An Employee ID is printed on an ID card, quoted
in an offer letter and typed into payroll queries; renumbering someone silently is worse than a
mixed format.

### Proposed backfill — `scripts/hr/backfill-employee-codes.mjs`

`--report` | `--dry-run` (default) | `--apply`. Touches **only** rows where `office_id` is NULL or
blank; never rewrites an existing code. Codes come from the same generator the API uses, ordered
by id so the oldest employee gets the lowest new code. Idempotent.

**Dry-run output (nothing was written):**

```
EMP-0013  id=14  Pilot HR          EMP-0019  id=20  Pilot ServiceB    EMP-0025  id=33  Pilot DeptHead
EMP-0014  id=15  Pilot Finance     EMP-0020  id=21  Pilot Management  EMP-0026  id=34  Pilot L2Approver
EMP-0015  id=16  Pilot Production  EMP-0021  id=28  Pilot QC          EMP-0027  id=35  Pilot HRMgr
EMP-0016  id=17  Pilot Stores      EMP-0022  id=29  Pilot Purchase    EMP-0028  id=36  Pilot HRExec
EMP-0017  id=18  Pilot Sales       EMP-0023  id=31  Pilot Project     EMP-0029  id=37  Pilot Payroll
EMP-0018  id=19  Pilot ServiceA    EMP-0024  id=32  Pilot ServiceMgr  EMP-0030  id=38  Pilot FinanceMgr
EMP-0031  id=39  Pilot AccountsExec  EMP-0033  id=41  Pilot ProcExec  EMP-0035  id=43  Pilot QCEng
EMP-0032  id=40  Pilot SalesExec     EMP-0034  id=42  Pilot ProdEng   EMP-0036  id=44  Pilot DesignEng
+ 11 test-tenant rows, each EMP-0001 within its own company
```

**Not run — awaiting your decision.** Once it has, a follow-up migration can add `NOT NULL`.

---

## 4. Which existing records have missing Department / Role

Company 1, current staff:

| Gap | Count | ids |
|-----|-------|-----|
| Missing Department | **1** | 45 |
| Missing Role / Designation | **26** | 5, 6, 14–21, 28, 29, 31–41, 43, 44, 45 |
| Missing Joining Date | 1 | 11 |

Two distinct causes:

- **ids 14–44 (24 rows)** — `pilot-provision.mjs`, which sets `department` but not `designation`.
- **ids 5, 6** — created through the Add Employee form with `designation` as the **empty string**.
  `''` is not NULL, so it passed every `if (!designation)` guard in `addEmployee`, and passed
  `validateMasterValue` too (which returns early on a falsy value).
- **id 45** — the recruitment hire path. `department` and `designation` come from a `LEFT JOIN` on
  `job_openings` / `job_requisitions`, both nullable. A candidate hired against an opening with no
  department produced an employee with none.

### Fix — both layers

**Backend (`employee.service.js`):**

- `REQUIRED_ON_CREATE` = department, designation, **status**, **joining date** — checked with
  `!String(data[key] ?? '').trim()`, so blank-but-present counts as missing. Joining date is in the
  list because `getEmployeeAnalytics` already classifies a missing one as *critical*: without it the
  employee is absent from every hiring window, lands in the tenure chart's "Not recorded" bucket,
  and has no probation clock. It is also always known at the moment of hire, which is the only
  moment this list applies to — an existing row without one is left alone.
- `NOT_CLEARABLE` on update = department, designation. Deliberately narrower: an edit that never
  mentions department is fine, including on the legacy rows — HR must be able to correct a phone
  number on an incomplete record without being forced to complete it. What is refused is submitting
  a blank for one of these, i.e. clearing a value that is there.
- Recruitment `hireCandidate` refuses the hire with a message naming what to fix on the job
  opening, rather than minting an incomplete master record HR then has to find.

**Frontend:** both forms label the fields `*`, block submit with a message naming each gap, and
**open the Job accordion section** — an error about a field inside a collapsed section is an error
the user cannot act on.

Live:

```
POST /employees {first_name, last_name, company_email}   (no dept/role/status)
→ 400  "Department, Role / Designation, Employment status are required for an employee record."
```

### Legacy incomplete rows are now identifiable, not deleted

Nothing was deleted. On the register they are marked three ways:

- the three mandatory cells render **"Not assigned" / "Missing"** in a dashed amber chip, not a
  neutral em-dash — an em-dash reads as "nothing to say here";
- the row carries an **Incomplete** badge beside the name and a 3px amber inset marker;
- an **Incomplete (26)** toggle beside the filters narrows to exactly those rows.

`status` is also required on create because **`employees.status` has a column DEFAULT of
`'Probation'`** — every path that omitted it silently filed the new hire as a probationer. Eleven
single-employee test tenants read `Probation` for precisely that reason. Requiring it makes the
default unreachable through the API.

---

## 5. Why All Employees said 32 while the Dashboard said 33

**Both endpoints return 32 today, and they already did before I changed anything.**

Measured against the live server, in the browser's own terms:

```
GET /employees?status=all   → 34 rows { active:29, notice:2, probation:1, left:1, resigned:1 }
                              non-exited = 32                  ← All Employees "Total Staff"
GET /employees/analytics    → summary.total = 32                ← Dashboard "Current Headcount"
                              statusBreakdown Active 29, Probation 1, Notice 2
```

The 34 rows are: 29 Active, 2 Notice (ids 5, 44), 1 Probation (id 6), 1 Left (id 42),
1 `resigned` (id 10). Exited = 2 → current = 32. **32 is the correct number and both pages show
it.** No employee accounts for a difference, because there is no difference.

The 33 was almost certainly a pre-fix render. The two pages *did* disagree 32/33/34 until the
2026-09-27 dashboard pass introduced `shared/employeeStatus.js`; `EmployeesData.jsx` was last
edited at 11:08 and `EmployeesDashboard.jsx` at 17:10 on 2026-09-28, and the backend process was
started at **17:10:44** — so a dashboard viewed earlier in the session was served by a process that
predated part of that reconciliation. I could not reproduce 33 from any endpoint, and I am not
going to invent an employee to explain it.

### Definitions, stated

Both pages use **one** population: everyone whose status is not in `EXITED_STATUSES`. Someone
serving notice **is** in headcount — payroll, attendance and leave all still run for them until
the last working day, which is the reading `POST /employees/:id/offboard` writes and documents.
Probation is in. Exited is out, and lives on Ex-Employees.

So the pages fall under your option **A**: same population, same count. The metric names differ
("Total Staff" / "Current Headcount") but the number cannot.

### Reconciliation test — `employeeHeadcount.reconciliation.test.js`

The existing `employeeStatusVocabulary.contract.test.js` proves the two vocabulary **files**
agree. That is necessary and **not sufficient** — agreeing lists still give different totals if one
path applies `deleted_at IS NULL` and the other does not, or if one is capped by a LIMIT the other
has no equivalent of. The new suite compares the **numbers the two pages display**:

- Total Staff == `summary.total`;
- on a mismatch it prints **the offending employees by id, name and raw status**, because a count
  mismatch is not actionable and a list of names is;
- each status filter cohort == the dashboard bucket of the same name (your item 8);
- the page's KPI tiles sum to Total Staff; Exited is never inside it;
- `?status=all` returns every row — `getEmployees` caps at `DEFAULT_MAX = 2000` with **no signal to
  the caller** while the analytics CTE has no cap at all. Below 2000 employees they agree by luck.
  This asserts the row count against `COUNT(*)`, so the day the cap starts to bite is the day the
  test fails rather than the day someone notices two headcounts on two screens.

---

## 6. Canonical employment status values

`backend/src/shared/employeeStatus.js` ⇄ `frontend/src/features/employees/employeeStatus.js`
(a contract test parses both and fails the build if they drift).

The distinction that was missing is **READ vs WRITE**.

### READ vocabulary — every spelling that may already be in the column

| Bucket | Statuses | In headcount? |
|--------|----------|---------------|
| Active | `active` | yes |
| Probation | `probation` | yes |
| Notice | `notice`, `notice_period`, `notice period` | **yes** |
| Exited | `left`, `inactive`, `terminated`, `resigned`, `ex-employee`, `ex employee`, `exited`, `relieved`, `absconded` | no |
| Other | anything unrecognised | **yes** — fail-safe: mislabelling someone as employed is visible and fixable, dropping them out of headcount is not |

Comparison is `LOWER(TRIM(…))`, and a blank/NULL status reads as `active`.

### WRITE vocabulary — the only values a UI or API caller may SET

```
WRITABLE_STATUSES      = ['Active', 'Probation', 'Notice', 'Left']
BULK_WRITABLE_STATUSES = ['Active', 'Probation', 'Notice']
STATUS_LABELS          = { Active: 'Active', Probation: 'Probation', Notice: 'On Notice', Left: 'Exited' }
```

- **`'Inactive'` is no longer writable.** It is an exited status that the row dropdown offered, so
  one click retired someone with no last working day, no exit reason and no `exit_request` — a
  departure no report could date. Leaving goes through **Terminate**, which captures both.
- **`'Left'` is excluded from bulk** — a bulk change carries no exit date, so bulk-exiting would
  create N undateable departures in one click.
- `'terminated'` is written only by `deleteEmployee`'s soft delete, which also stamps `deleted_at`.
- Case is normalised on the way in: `'notice'` is stored as `'Notice'`, not as a fourth variant.

### Synonym copies removed

| Where | Was | Now |
|-------|-----|-----|
| `PATCH /employees/:id/status` | **no validation at all** — `{"status":"totally-made-up"}` returned **200** | 400 + the allowed list |
| `PUT /employees/:id` | no validation | same canonical check |
| `getExEmployees` `EX_STATUSES` | 4th copy; listed `notice_period` as **exited** | `isExitedSql('e.status')` |
| `GET /employees/directory` | 5th copy; excluded `notice_period` but let `Notice` through | `isCurrentSql('e.status')` |
| Add Employee form | Active / Probation / **Inactive**, no Notice | `WRITABLE_STATUSES` |
| Edit Employee form | Active / Probation / Notice / **Inactive** | `WRITABLE_STATUSES` |
| Row dropdown | Active / Probation / Notice / **Inactive** | `BULK_WRITABLE_STATUSES` |
| Status colour map | keyed by raw value, so `notice_period` fell through to **Active green** | keyed by bucket |

The `getExEmployees` copy was a live contradiction: an employee at `notice_period` appeared on
All Employees **and** on Ex-Employees, counted in headcount by one page and as a departure by the
other. Which of three equivalent spellings a row happened to hold decided whether that person was
in the company phonebook.

### ⚠ Cross-tenant write, closed

`PATCH /employees/:id/status` was `UPDATE employees SET status=$1 … WHERE id=$2` — **the only
employee write in the file with no company filter.** An HR user in one company could change the
employment status of any employee id in the database, in any tenant, and the audit entry would
look entirely routine. Now scoped; verified against a real other-tenant row (employee 6589,
company 565) → **404**.

Also: the DB still holds one legacy lowercase `resigned` (id 10) alongside `Left` (id 42). Both
bucket to Exited and both are correct; nothing new can be written in that spelling.

---

## 7. Pagination

| | Before | After |
|-|--------|-------|
| Count line | `Showing 20 of 32 employees` | `Showing 1–20 of 32 employees` (+ `(filtered from 32)` when narrowed) |
| Rows per page | fixed 20, no control | **10 / 20 / 50 / 100**, default 20, remembered per browser |
| Page controls | `« ‹ › »` glyphs only | **Previous · 1 2 … n · Next**, current page highlighted, gaps elided |
| When shown | only if `totalPages > 1` | whenever there are rows — the rows-per-page control lives here, and at 50-of-32 the whole bar vanished, so the only way back to a smaller page size disappeared exactly when it had been used |

Filtering order was already correct — the full set is filtered, then sliced — and the count has
always referred to the filtered set. Two things were not:

- **Page clamping.** `setCurrentPage(1)` was called by each filter control, but `page` also had to
  survive a change in the underlying list. On page 2 of 2 with 21 rows, terminating one leaves 20:
  `totalPages` drops to 1 and `slice(20, 40)` returned `[]` — an empty table under a count that
  said rows existed. Now `safePage` clamps what is rendered and an effect settles the state.
- **Row numbers** used the old constant, so at 50 rows/page the second page restarted at 21.

> ⚠ The clamping effect first went in **above** `const totalPages = …`. Its dependency array is
> evaluated in the same render pass, while `totalPages` is still in its temporal dead zone, so the
> page died inside the error boundary with `ReferenceError: Cannot access 'totalPages' before
> initialization` — a blank page, not a wrong number. **eslint passed it and the parser passed it.**
> The browser suite caught it, because it is the only thing in the repo that renders this component.

---

## 8. Search — fields verified

Placeholder was `Search name, ID, dept, role…`; the code searched name, `office_id`,
`company_email`, `department`, `designation`.

- **Email was searched but not advertised.**
- **Manager was not searched at all** — and the Manager column is visible by default, so typing a
  manager's name returned nothing.

Now searched: first+last name, `name`, `office_id`, `company_email`, `personal_email`,
`department`, `designation`, `reporting_manager`. Placeholder updated to
`Search name, ID, email, dept, role, manager…` — nothing advertised that is not searched.

Search runs over the whole filtered set before pagination, and resets to page 1. Sentinel values
are excluded, so searching `"null"` does **not** return the three employees whose manager column
holds the string `'null'` — a value that is not really there must not be searchable as if it were.

The browser suite drives each advertised field against real data and asserts the row that supplied
the term comes back; it annotates rather than silently passing when the data has no usable value
for a field.

---

## 9. Bulk-action safety changes

All four actions kept. Both high-impact ones are now **two-step**:

1. choose the value → the primary button reads **"Review N changes"** and cannot apply;
2. the confirm step states the **new value**, the **affected count**, and **lists the affected
   employees by name** with their Employee ID, current department and current status;
3. **Back** returns to step 1, **Cancel** closes without writing.

A count alone is not enough to cancel on: "Change status for 12 employees" gives no way to notice
that the selection still holds three rows from a filter applied two minutes ago. The names do. The
list is capped at 12 with "and N more" and scrolls inside its own panel, so a 100-row selection
cannot push the buttons off the dialog.

Bulk status also:

- offers only `Active / Probation / Notice` — **exiting is not a bulk operation** (no exit date);
- says how many rows **already hold** the target status and will be skipped;
- links to the per-row Terminate action for exits.

### ⚠ A silent partial-failure bug, fixed

```js
await Promise.all(ids.map(id => api.patch(`/employees/${id}/status`, …)));   // old
```

`Promise.all` rejects on the **first** failure while the remaining requests keep going. The
`catch` then showed "Failed to update status" and updated **nothing** in local state — so eleven of
twelve employees had in fact been changed on the server while the page insisted nothing had
happened. Now `allSettled`: only the fulfilled ids are applied locally, and the toast reads
`"9 updated, 3 failed — the failed records are unchanged"`.

Per-row status changes to `Notice` still confirm individually, naming the employee, the **old**
status and the new one.

---

## 10. Backend validation changes

**New shared modules**

- `backend/src/shared/employeeCode.js` — canonical format, `codeSeq`, `nextEmployeeCode`,
  `assertCodeAvailable`.
- `backend/src/shared/nullish.js` — `cleanText` / `isNullishText`, so the string `'null'` cannot
  become data again.
- `WRITABLE_STATUSES` / `BULK_WRITABLE_STATUSES` / `canonicalWritableStatus` added to
  `shared/employeeStatus.js` and mirrored in the frontend.

**`POST /employees`** — Employee ID minted server-side and proven free under the lock; a supplied
code validated and proven free; department, designation, status and joining date required (blank
counts as missing); status normalised to the canonical spelling; duplicate `company_email` → 409
naming the holder; `reporting_manager` scrubbed of sentinel text.

Also validated server-side, where nothing was before:

- **email format** on `company_email` (required) and `personal_email` (only when non-empty). The
  API accepted any non-empty string, and `company_email` becomes the login identity —
  `createEmployeeLogin` keys the `users` row on it.
- **joining date parses**, as a 400 rather than a 500 out of Postgres' date parser. Compared
  against a **UTC** "today": `new Date('YYYY-MM-DD')` is UTC midnight, so comparing it against
  local `now` makes a same-day hire look like a future one for anyone east of UTC — which is
  everyone using this deployment. A confirmed future start date is allowed (HR records those ahead
  of time); more than two years out is refused.

**`PUT /employees/:id`** — department/designation cannot be cleared; status validated and
canonicalised; `reporting_manager` scrubbed; the status-only fast path is now company-scoped
(it was `WHERE id = $1` — the controller checks ownership first, but an exported service function
that can write across tenants is a loaded gun for the next caller).

**`PATCH /employees/:id/status`** — status validated against `WRITABLE_STATUSES` (was: none),
canonicalised, and **company-scoped** (was: none).

**`GET /employees/next-code`** — company-scoped.

**`hireCandidate`** — uses the shared generator; refuses a hire whose job opening has no
department or job title.

**Migrations** — `20260928000001` (Employee ID unique + format), `20260928000002` (company email
unique). Both applied and verified on the live database.

---

## 11. Test results

**Full backend suite: 96 files, 2203 passed, 9 skipped, 0 failed.** Run end-to-end on the final
code, not on an intermediate state.

| Suite | Result |
|-------|--------|
| `employeeCode.contract.test.js` — **new**, 29 tests | pass |
| `employeeHeadcount.reconciliation.test.js` — **new**, 6 tests | pass |
| `smoke.employees.test.js` — 22 tests, **8 new** | pass |
| `employeeStatusVocabulary.contract.test.js` | pass |
| `employeeAnalytics.reconciliation.test.js` | pass |
| `employeeDataQuality.contract.test.js` | pass |

Two tests failed on the way here, both correctly:

- `smoke.employees.test.js` → "200 when admin creates employee" — its payload had no `status`, which
  is now required. **The test was updated to the new contract, not the contract loosened to the
  test.**
- my own `employeeHeadcount.reconciliation.test.js` → "the KPI tiles sum to Total Staff" — I derived
  the Exited count from a set that had already dropped the exited, so it was 0 by construction and
  asserted nothing. Fixed to count over the raw rows.

**Browser — `tests/suites/22-all-employees.spec.ts` (new): 16 passed, 0 failed (3.2 min),
registered as the `all-employees` Playwright project.** Covers the null audit with every column
switched on, Total Staff vs the API, KPI sums, the whole pagination contract (range, rows-per-page,
numbered pages, page-2 content, filter re-counting, paging back from beyond the end), each
advertised search field driven against real data, status-filter cohorts vs KPI counts, the
incomplete-record markers, the bulk two-step confirmation, and page-overflow at **1280 / 1440 /
1920**.

It earned its keep twice:

- it caught the **TDZ crash** in §7 that eslint and the parser both passed — a blank page, found
  because this suite is the only thing in the repo that renders this component;
- its own first version failed too: `.check()` on `.ed-col-item input[type="checkbox"]`, which the
  stylesheet sets to `display: none`. Clicking the label is both what works and what a person does.

**eslint** — 0 errors. My five frontend files are warning-free; the backend's 233 warnings are all
pre-existing and in files I did not touch.

**`vite build`** — clean (4.41s). Worth running separately: this repo has a history of eslint
passing while the production build fails on JSX that only the real parser rejects.

---

## 12. Remaining data-quality issues (not changed — your call)

Run `node backend/scripts/hr/employee-data-quality.mjs 1` for the current state.

| # | Finding | Detail | Suggestion |
|---|---------|--------|------------|
| 1 | **24 blank Employee IDs** | company 1, all `pilot-provision.mjs` fixtures | `backfill-employee-codes.mjs --apply`, then a `NOT NULL` migration |
| 2 | **26 blank Roles, 1 blank Department** | ids listed in §4 | HR data entry; the Incomplete filter lists them |
| 3 | **3 rows hold the string `'null'`** in `reporting_manager` | ids 6, 12, 46 | one `UPDATE … SET reporting_manager = NULL`; the page already renders them as "Not assigned" and no new ones can be written |
| 4 | **`pilot-provision.mjs` writes no `office_id`/`designation`** | it is the origin of §1 and §2 | give it the shared generator, or move its fixtures out of company 1 |
| 5 | **11 test-tenant employees** (`admin_a_ZZGEN_…@pulse.test`, companies 565–4623) | debris from a tenant-isolation sweep | sweep, matching the **whole** tag — a `LIKE 'ZZGEN%'` prefix sweep would eat a concurrently-created `ZZGEN2A` |
| 6 | **Employee 1 reports to themselves** (`reporting_manager_id = 1`) | breaks any recursive org-chart walk | set it NULL for the top of the hierarchy |
| 7 | **2 rows have an out-of-range date of birth** (ids 3, 12) | implied age < 16 or > 75 | correct, or add a DOB range check on write |
| 8 | **1 row has no joining date** (id 11) | falls out of every hiring window; lands in the tenure chart's "Not recorded" bucket | HR data entry |
| 9 | **One legacy lowercase `resigned`** (id 10) beside `Left` (id 42) | both bucket to Exited, both correct | optional normalisation; nothing can write it now |
| 10 | **`getEmployees` caps at 2000 rows with no signal to the caller** | below 2000 the page and the dashboard agree by luck | the reconciliation test fails when the cap starts to bite; real fix is server-side pagination with a total |
| 11 | **A supplied Employee ID may use the legacy `EMP001` shape** | intentional — lets HR match an existing scheme during migration | tighten `assertCodeAvailable` to the strict format if you want canonical-only |

**Duplicates: none.** 0 duplicate Employee IDs, 0 duplicate company emails, 0 duplicate
first+last names, 0 soft-deleted rows, 0 future joining dates.

---

## What was NOT changed

- The table layout, column set and compact styling — unchanged.
- No new dashboards, charts, cards or sections. The only new controls are the rows-per-page
  select, the page numbers and the Incomplete toggle.
- No employee data was modified. Two probe rows were created during verification and both were
  deleted; company 1 is back to 34 rows.
- The horizontal scroll already lived on `.ed-table-scroll`, inside the table container. Verified
  at 1280/1440/1920 with every column switched on: the table scrolls, the page does not.
