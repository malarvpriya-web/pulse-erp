# All Employees — Final Completion Pass

**Date:** 2026-09-28 · Follow-on to `ALL_EMPLOYEES_DATA_INTEGRITY_AUDIT.md`
**Scope:** the remaining items from that audit, plus everything else found while reviewing the
whole All Employees workflow.

Every figure below was read from the live database or produced by a live API call. Probe rows were
deleted and the deletions verified.

---

## 1. Employee ID generator — final architecture

One generator, `backend/src/shared/employeeCode.js`, used by every path.

```
                      ┌─────────────────────────────────────┐
  POST /employees ────┤                                     │
  next-code       ────┤  nextEmployeeCode(client, companyId) │──▶ EMP-0037
  hireCandidate   ────┤   · company-scoped advisory lock     │
  pilot-provision ────┤   · MAX over the numeric suffix of   │
                      │     EVERY EMP-prefixed code in that  │
                      │     company, dashed or not           │
                      └──────────────┬──────────────────────┘
                                     ▼
                      assertCodeAvailable(client, code, companyId)
                                     ▼
                   employees_office_id_company_uniq  (DB backstop)
                   employees_office_id_format        (DB backstop, VALIDATED)
                   employees.office_id NOT NULL      (DB backstop)
```

| Property | How it holds |
|---|---|
| Server-side | `office_id` is minted inside `addEmployee`'s transaction. The browser's fallback generator was deleted; the Add form now shows a read-only preview and "Assigned on save" if the prefill fails. |
| Unique per tenant | `employees_office_id_company_uniq` on `(COALESCE(company_id,0), LOWER(office_id))`. |
| Never duplicates | `assertCodeAvailable` under the lock, plus the index. Both the minted and the caller-supplied branch go through it — previously only the supplied branch was checked. |
| Never malformed | `CODE_RE` in the app, `employees_office_id_format` in the DB. `codeSeq` strips non-digits instead of slicing at a fixed offset, which is what produced `EMP0-1`. |
| Every creation path | Two app paths + the provisioning script, all now calling `nextEmployeeCode`. No bulk import exists. |
| Survives concurrency | **Tested** — see below. |
| Client IDs not trusted | A supplied code is format-checked and proven free; the prefill is advisory only. |
| Existing IDs untouched | `updateEmployee` never writes `office_id` (absent from its field list); both forms render it `disabled`; the backfill only fills blanks. |

### Concurrency — tested, not assumed

`employeeCode.contract.test.js` → *"mints distinct codes under concurrent creation"*: 5 simultaneous
`addEmployee` calls. Asserts all 5 succeed, all 5 codes match `EMP-\d{4,}`, all 5 are **distinct**,
and the sequence numbers are **contiguous** (which proves serialisation rather than luck). Then
re-checks the database for duplicates among the created ids.

5 and not more on purpose: `db.js` caps the pool at 6 in test mode and the pool is shared across
suites in a vitest worker. Asking for more would be testing the pool's queue, not the generator.
`addEmployee` holds exactly one connection and never requests a second while holding it, so 5 is safe.

### Also fixed here

`pilot-provision.mjs` — the origin of the whole defect — now mints via the shared generator and
supplies `designation`. Without that change it would simply fail at the INSERT now that `office_id`
is NOT NULL; making it fail was not the fix.

---

## 2. Employee ID backfill — 35 rows updated

Pre-conditions verified before applying (all four you listed):

```
rows WITH a code (must not be touched):  10
rows WITHOUT a code (the target):        35
existing duplicates:                      0
unique index present:                   yes
legacy-format rows:  8  EMP001 EMP002 EMP003 EMP005 EMP006 EMP010 EMP011 EMP012
per-company max suffix:                 company 1 → 12
generator preview:  company 1 → EMP-0013 · each test tenant → EMP-0001
```

`backfill-employee-codes.mjs --apply` → **Committed. 35 rows updated.**
Company 1 received `EMP-0013`…`EMP-0036` (continuing past the legacy `EMP012`, colliding with
neither family). The 11 test-tenant rows each received `EMP-0001` **within their own company**,
which is correct — Employee IDs are per-company numbering.

Post-backfill verification (§24):

```
missing (NULL or blank):  0        rows WITH a code:  45
duplicates:               0        rows WITHOUT:       0
legacy format (kept):     8  — unchanged, exactly the 8 above
per-company max suffix:   company 1 → 36, every test tenant → 1
```

Then `20260928000003_employee_office_id_not_null.js`:

- **guards itself** — it re-counts the blanks and fails with the offending ids rather than with
  Postgres' bare "column contains null values";
- `ALTER COLUMN office_id SET NOT NULL`;
- `VALIDATE CONSTRAINT employees_office_id_format` — now safe to promote, since every row is
  confirmed to match.

### What NOT NULL surfaced: 14 places creating employees the app could no longer create

Adding the constraint failed **13 test files** on the next full run — and every one for the same
reason. Twelve integration fixtures and two seed scripts insert employees with raw SQL and supplied
no `office_id`. Their `beforeAll` threw, every test in the file skipped, and the file reported as
failed (3 real assertion failures, 442 skipped tests).

That is the constraint doing its job, not collateral damage: each of those fixtures was creating a
record the application itself can no longer create. They now supply `FIXTURE_CODE_SQL` — 17 INSERTs
across 14 files.

> ⚠ **Deliberately not solved with a column DEFAULT.** A default would have satisfied NOT NULL for
> every direct INSERT and required no fixture changes at all — and would have quietly re-created the
> exact defect this whole pass existed to remove: a second way to mint a code, out of step with the
> company's numbering, that no new code path has to opt into. `FIXTURE_CODE_SQL` is instead
> obviously separate: `seq_emp + 900000`, so fixture rows are recognisable on sight (anything above
> `EMP-0900000` was created by a test, not by HR) and can never be mistaken for a company's own
> series.

`scripts/seed-test-fixtures.mjs` needed doing by hand — it is an `INSERT … SELECT`, so the code had
to become the first SELECT expression rather than a `VALUES` entry. The automated patch added the
column without a value there, which would have been a column-count error; caught by parsing the file
before running it.

### The trap you flagged, and why NOT NULL is not it

> ⚠ A CHECK is re-evaluated on every **UPDATE**, `NOT VALID` included — `NOT VALID` only skips the
> initial scan. A CHECK demanding the canonical `EMP-0001` shape would reject the next edit to any
> of the 8 legacy `EMP001` employees. That is why `employees_office_id_format` accepts
> `^EMP-?[0-9]{3,}$` — both families — and the strict format is enforced only where codes are minted.
>
> NOT NULL has no such effect: no code path writes NULL to the column, so it constrains new INSERTs
> and nothing else.

Verified live, after the migration:

```
office_id is_nullable:                          NO
format CHECK convalidated:                      true
UPDATE the legacy EMP001 row (phone change):    ALLOWED   ← the acceptance test
INSERT with no office_id:                       blocked by the not-null constraint
```

---

## 3. Duplicate IDs found / fixed

**0 duplicates exist, and 0 were created by the backfill.**

One duplicate was found and fixed in the previous pass: the old generator produced a second
`EMP001` in company 1 during a live probe (proving the defect), and that probe row was deleted.
There are now three independent layers preventing recurrence — the generator's company-scoped
`MAX`, `assertCodeAvailable` under the advisory lock, and the unique index — and the concurrency
test covers the race the first two exist for.

---

## 4. Mandatory-field validation

Backend is authoritative. `REQUIRED_ON_CREATE` in `employee.service.js`:

| Field | Create | Update | Notes |
|---|---|---|---|
| First / last name | required | required | pre-existing |
| Employee ID | **server-generated** | not writable | never accepted as authoritative from the client |
| Department | **required** | cannot be cleared | |
| Role / Designation | **required** | cannot be cleared | |
| Employment status | **required** | validated against `WRITABLE_STATUSES` | the column DEFAULTs to `'Probation'`, so omitting it silently filed hires as probationers |
| Joining date | **required** | validated | parse-checked; >2 years future refused; compared against a **UTC** today, because `new Date('YYYY-MM-DD')` is UTC midnight and comparing to local `now` makes a same-day hire look future-dated for anyone east of UTC |
| Official email | **required + format** | format | `company_email` becomes the login identity; duplicates → 409 naming the holder, plus `employees_company_email_uniq` |
| Reporting manager | validated | validated | must exist, same tenant, no self-reference, no cycle |

`NOT_CLEARABLE` is deliberately narrower than `REQUIRED_ON_CREATE`: an edit that never mentions
department is fine, including on legacy rows — HR must be able to fix a phone number on an
incomplete record without being forced to complete it first. What is refused is submitting a blank
over a value.

Live probes, on a restarted server:

```
POST /employees  no dept/role/status       → 400  "Department, Role / Designation, Employment status are required…"
POST /employees  no joining_date           → 400  "Joining date is required for an employee record."
POST /employees  company_email 'not-an-email' → 400  "…is not a valid company email address."
POST /employees  joining_date '15/01/2026' → 400  "…is not a valid joining date. Expected YYYY-MM-DD."
POST /employees  joining_date '2030-01-15' → 400  "…more than two years in the future."
POST /employees  joining_date = today      → 200  (the UTC-boundary case, correctly allowed)
POST /employees  status 'Inactive'         → 400  not in the write vocabulary
POST /employees  status 'notice'           → 200  stored as canonical 'Notice'
POST /employees  duplicate company_email   → 409  names the employee holding it
PATCH /:id/status 'totally-made-up'        → 400  + the allowed list
```

Legacy incomplete records were **not deleted** and remain identifiable — see §5.

---

## 5. Incomplete filter

### It was measuring a different thing from the dashboard

Two definitions of "incomplete" existed for the same row:

| Where | Fields |
|---|---|
| `EmployeesData.jsx` `REQUIRED_FIELDS` | Employee ID, Department, Role |
| `employeeListFilter.js` `MISSING_FIELD_TESTS` | joining date, department, designation, skill_type, probation end |

Neither was wrong; neither said which question it answered; and they gave different counts for the
same employee. Unified on **one** definition, in `employeeListFilter.js`:

```js
MANDATORY_FIELDS = [office_id, department, designation, status, joining_date]
```

Defined as **"this row would fail `POST /employees` today"** — i.e. derived from the server's own
rule (`REQUIRED_ON_CREATE` plus `office_id`, which is mandatory but server-generated).
`employeeRequiredFields.contract.test.js` parses both and fails if they drift.

`skill_type` is deliberately excluded: it is not required to create an employee, 27 live rows lack
it as a seeding artefact, and folding that in would bury the records that actually block something.
The dashboard still counts it under its own, wider question — which is why the two numbers
legitimately differ, and both now name what they measure.

### Accuracy, and saying what is missing

- The count on the toggle equals the number of rows the filter returns. Browser-asserted, against
  the definition above, including the sentinel case (`department = 'null'` counts as missing).
- **The badge now names the gaps**: `⚠ Department · Role`, truncated to two with `+N`, full list in
  the tooltip. "Incomplete" alone tells HR something is wrong and nothing about what to fix.
- The count moved from 26 → **27** when joining date joined the definition. Employee 11 has no
  joining date; the page was right and my own older browser test was wrong, which is how the change
  was caught.
- Incomplete **combines** with the other filters rather than replacing them — browser-asserted.

---

## 6. Canonical status — every write path

### The vocabulary

```
READ  (spellings that may exist):  Active | Probation | Notice·notice_period·notice period |
                                   left·inactive·terminated·resigned·ex-employee·ex employee·
                                   exited·relieved·absconded | anything else → "Other" (still employed)
WRITE (values anything may SET):   Active | Probation | Notice | Left
BULK  (values a bulk action may):  Active | Probation | Notice
```

### Audit of every write path

| Path | Before | After |
|---|---|---|
| `POST /employees` | any string; DB default `'Probation'` if omitted | required + validated + canonicalised |
| `PUT /employees/:id` | unvalidated | validated + canonicalised |
| `PATCH /employees/:id/status` | **no validation at all**, and **no tenant filter** | validated, canonicalised, tenant-scoped |
| Bulk status change | UI offered `Inactive` | `BULK_WRITABLE_STATUSES` only |
| Row dropdown | offered `Inactive` (an exit, one click, no date) | Active / Probation / Notice; exits go through Terminate |
| Add form | Active / Probation / **Inactive**, no Notice | `WRITABLE_STATUSES` |
| Edit form | Active / Probation / Notice / **Inactive** | `WRITABLE_STATUSES` |
| `POST /employees/:id/offboard` | literal `'Notice'` | `canonicalWritableStatus('Notice')` |
| `POST /exit/initiate` | literal `'Notice'` | `NOTICE_STATUS` |
| `POST /exit/fnf/:id/pay` | literal lowercase `'left'` | `EXIT_STATUS` |
| `POST /hr/offboarding/:id/complete` | own `separation_type → status` map | `EXIT_STATUS` |
| `exitStatusSync.cron.js` | own `separation_type → status` map | `EXIT_STATUS` |
| `deleteEmployee` | `'terminated'` + `deleted_at` | unchanged — soft delete, not offerable |
| Rehire | literal `'Active'` | `canonicalWritableStatus('Active')` |
| `getExEmployees` | 4th copy of the list, called notice EXITED | `isExitedSql` |
| `GET /employees/directory` | 5th copy, excluded `notice_period` but not `Notice` | `isCurrentSql` |

**Three copies of a `separation_type → status` mapping existed** — in the cron, in `hr.routes.js`,
and implicitly in the F&F handler. They had already drifted: the cron sent `retirement` to
`'resigned'`, `hr.routes.js` sent it to `'left'`. So *which of two independent paths finalised an
exit decided what the employee's status said afterwards.* All three now write `EXIT_STATUS`
(`'Left'`). The reason someone left is `exit_requests.separation_type`, which is where all three read
it from — storing it twice is what let them drift.

Safe because **nothing reads the distinction**: a sweep of every hardcoded exited-status list in the
repo found ~15, and every one is an "exclude the departed" filter listing several spellings side by
side. None branches on which. (Those 15 read-side copies are a separate, larger problem — see §14.)

### `status` ⇄ exit request ⇄ last working day (§18)

Setting **Notice** from the row dropdown is a status change *only*: no `exit_request`, no last
working day, no clearance checklist — while the dashboard's Notice columns all read from
`exit_requests`. The confirmation dialog now says exactly that and names the proper action, so it is
a deliberate shortcut rather than a silent bypass. No competing status model was introduced.

---

## 7. Security / tenant isolation

### Found and fixed in this pass

| Endpoint | Defect |
|---|---|
| **`POST /exit/fnf/:id/pay`** | Read the exit request by id with **no scope**, then flipped the employee to exited by id. A company A HR user could mark **any** company's F&F paid and terminate that employee. `exit_requests` has no `company_id`, so the scope now comes through the employees join. |
| **`PUT /self-service/employees/:id/profile`** | The role guard lets an HR role edit any employee id, and the UPDATE was id-only — so a company A HR user could rewrite a company B employee's home address and **bank account**. |
| **`POST /security/gdpr/purge/:userId`** | Gated to `admin`/`super_admin`, but `admin` is per-company and both statements were id-only: a company A admin could irreversibly anonymise a company B employee. |
| **`orgChartRepository.upsert`** | Synced `reporting_manager_id` with a bare `WHERE id = $2` and, unlike the other org-chart writes, no prior ownership check — `employee_id` came straight from the request body. |

### A second bug in the purge route

The `users` UPDATE resolved the login address with a subquery against `employees` — **after** that
row had already been overwritten with the anonymised address. It matched zero rows every time, and
was wrapped in `.catch(()=>{})`, so it failed silently: a "PII purge" left the login's real name and
real email in `users`. Nothing surfaced, because 0 rows updated is not an error. Now captured before
the anonymisation.

### Hardened as defence in depth

`POST /employees/:id/offboard`, `POST /employees/ex/:id/rehire`, `POST /exit/initiate` and
`POST /hr/offboarding/:id/complete` all had a prior ownership check but a bare `WHERE id =` on the
write itself. Predicates added — a bare id-only write on `employees` is the shape of both bugs found
so far, and the predicate removes the need to trace the proof.

### The guard that stops the next one

`employeeWriteScope.contract.test.js` parses **every** `UPDATE employees` / `DELETE FROM employees`
statement in `backend/src` and requires each to carry a `company_id` predicate or be on a documented
allowlist. Three entries, each with a written reason:

- `exitStatusSync.cron.js` — system cron; no caller, therefore no tenant.
- `increments.routes.js` — transitively scoped via an `increment_recommendations` row already
  selected with `AND company_id = $2`.
- `promotions.routes.js` — likewise via `promotion_recommendations`.

A new unscoped write fails the test until someone either scopes it or argues for it in writing.
The test also asserts its own extractor reads past a multi-line `WHERE` — an earlier throwaway
version cut statements at a fixed length and produced four false positives, including
`updateEmployee`, whose predicate sits on the line *after* `WHERE id = $62` as a `${...}`
interpolation. **I nearly "fixed" a statement that was already correct**; a scope checker that cries
wolf gets ignored.

### Verified live

```
PATCH /employees/6589/status  (employee 6589 is company 565; caller is company 1)  → 404
```
Chosen so that even a leak would have been a no-op (the value sent equalled the row's current
status). The earlier probe against id 8434 proved nothing — that row does not exist.

---

## 8. Self-manager and circular hierarchy

### Found

```
self-managing:   1  — employee 1, Malar Natesh, designation CEO, reporting_manager_id = 1
"cycles":        2  — paths [2,1,1] and [3,2,1,1]
```

Both "cycles" were artifacts of the one self-loop: subordinates walking up into a node that points
at itself. One defect, reported three times.

### Fixed

`repair-employee-data.mjs --apply`, dry-run first:

```
1. reporting_manager holding sentinel text: 3   ids 6, 12, 46   "null" → NULL
2. self-managing employees: 1   id=1 EMP001 Malar Natesh designation="CEO" → top of org, clear to NULL
3. manager NAME disagreeing with the manager FK: 1   id=40  null → "Pilot Sales"
After: self-managed 0, cycles 0, cross-tenant managers 0
COMMITTED — 5 row updates.
```

A **CEO's correct manager is NULL** — the top of a hierarchy has no manager, and an employee
reporting to themselves is definitionally wrong rather than merely unknown. That is determinable
from the data, not a guess. The script only clears a self-loop where the designation marks the
person as top-of-org (`chief|ceo|cto|cfo|coo|managing director|founder|chairman|president`);
anything else is **reported and skipped**, because the overwritten manager cannot be recovered.

### Prevented

`shared/employeeHierarchy.js` `assertValidManager` — self-reference, non-existent manager,
cross-tenant manager, cycle of any length, and a pre-existing loop (refused rather than extended,
naming where the corruption is). It takes a `db` handle so a caller inside a transaction checks
against the snapshot it is about to write.

Wired into the two paths that had **no** check:

- `POST`/`PUT /employees` (Add / Edit Employee)
- `PUT /orgchart/reporting-manager` — the **single**-employee path, while the bulk path and the
  upsert both already checked. The assignment the Org Chart screen makes one drag at a time was the
  one that could close a loop.

`employeeHierarchy.contract.test.js` — 14 tests: self-reference, non-existent, cross-tenant,
non-integer, a legitimate assignment, `A→B→A`, `A→B→C→A`, a pre-existing loop, the wiring into
`PUT /employees`, and three assertions that the **live** hierarchy has no self-managers, no cycles
and no cross-tenant manager edges.

> ⚠ `updateEmployee` is a single UPDATE with no `BEGIN`, so its check and write are not atomic — two
> simultaneous assignments could each pass and together close a loop. That is a far narrower window
> than the none-at-all it replaces; closing it properly means making that function transactional,
> which is a bigger change than this pass should carry. `findHierarchyDefects` is the backstop, and
> the live-hierarchy tests fail if a loop ever lands.

---

## 9. The 11 data issues — final status

| # | Issue | Class | Status |
|---|---|---|---|
| 1 | 24 blank Employee IDs | **A** | **FIXED** — 35 rows backfilled (incl. test tenants), `NOT NULL` added |
| 2 | 26 blank Roles, 1 blank Department | **B** | **HR data entry.** Cannot be invented. Now blocked on create, flagged per-row, and reachable via the Incomplete filter. ids in §12 |
| 3 | 3 rows holding the string `'null'` | **A** | **FIXED** — ids 6, 12, 46 → NULL; writes scrubbed by `shared/nullish.js`; reads by `displayValue.js` |
| 4 | `pilot-provision.mjs` writes no `office_id`/`designation` | **A** | **FIXED** — uses the shared generator + supplies designation |
| 5 | 11 test-tenant employees (`ZZGEN_…@pulse.test`) | **C** | **Not removed.** See below |
| 6 | Employee 1 reports to themselves | **A** | **FIXED** — cleared to NULL (CEO, top of org); self-assignment now blocked |
| 7 | 2 rows with out-of-range date of birth (ids 3, 12) | **B** | Real dates, not derivable. Suggest a DOB range check on write — deliberately not added, since a legitimately unusual DOB should not become unsaveable without your say-so |
| 8 | 1 row with no joining date (id 11) | **B** | **HR data entry.** Now required on create, and counted by the Incomplete filter (this is the row that moved the count 26→27) |
| 9 | One legacy lowercase `resigned` (id 10) beside `Left` (id 42) | **D** | **Intentional legacy.** Both bucket to Exited and both read correctly; nothing can write that spelling any more. Normalising it would rewrite history for no behavioural gain |
| 10 | `getEmployees` caps at 2000 rows with no signal to the caller | **C** | Below 2000 the page and dashboard agree by luck. The reconciliation test fails the day the cap bites. Real fix is server-side pagination with a total — a separate piece of work |
| 11 | A supplied Employee ID may use the legacy `EMP001` shape | **D** | **Intentional.** Lets HR match an existing scheme during migration. Minted codes are always canonical. Say the word and `assertCodeAvailable` tightens to canonical-only |

### #5 in detail — why I did not delete it

The repo **does** have an intended lifecycle for these rows:
`backend/scripts/audit/purge-leaked-test-tenants.mjs`. I ran it in report mode. It is the right
tool, and running it here would have been wrong:

- it nominates **80 tenants / 2441 rows across 21 tables**, including **1073 `audit_logs`** rows;
- its candidate list includes the **`9999xx` range**, which `testTenantIds.contract.test.js`
  documents as a **deliberate registry** of fixed test-tenant ids — purging those breaks the
  registry. (The script's marker rule and that registry disagree; that is worth reconciling
  separately.)
- its own header says `--apply` is irreversible and not transactional across tenants, and to take a
  backup first.

The narrow, reviewable command for **only** the tenants holding those 11 employees:

```
npm run backup
node backend/scripts/audit/purge-leaked-test-tenants.mjs \
  --apply --ids 565,568,571,573,575,577,579,581,583,1496,4623
```

Your call. They are invisible to company 1's register either way.

### #21 — the pilot rows are not test fixtures

`pilot-provision.mjs` is a **pilot user provisioning** script for real people. Its own header says
*"Edit ROSTER below with the real people before running with --apply. The placeholder addresses
exist so a dry run is meaningful, not so they can be created as-is."* Someone ran `--apply` against
the unedited roster, so 24 `Pilot *` rows with `pilot.*@manifest.in` addresses are live in company 1.

They are placeholders, not people — **but they are real login accounts that RBAC verification
depends on** (`procurement.authz.js` cites `pilot.hr@manifest.in` as the account that exposed a live
permissions bug), and there is no documented teardown for them. So: **preserved, not deleted.**
Each needs an HR decision — complete it into a real employee, or retire it through offboarding. The
script header now says this so it cannot happen again silently.

---

## 10. Pagination and rows-per-page

- **Rows per page is now at the TOP**, in the filter row, to the right beside Columns —
  `[ Search ] [ Department ] [ Status ] [ Role ] [ Incomplete ] … [ Rows per page: 20 ] [ Columns ]`.
  Kept at the bottom as well.
- **Synchronised by construction**: one `PageSizeControl` component reading one piece of state,
  rendered twice. Not two controls kept in step by an effect someone could forget. Browser-asserted
  in both directions.
- 10 / 20 / 50 / 100; default 20; remembered per browser.
- Changing page size **preserves search and filters** and returns to page 1 — browser-asserted.
- Count is a range over the **filtered** set: `Showing 1–20 of 32 employees`, plus
  `(filtered from 32)` when narrowed.
- `Previous · 1 2 … n · Next`, current page highlighted, gaps elided.
- Page is **clamped**, so no filter can leave an empty page selected. Browser-asserted by paging to
  2 and then narrowing hard.
- The pagination bar renders whenever there are rows, not only when `totalPages > 1` — at 50-rows
  -per-page over 32 employees the whole bar used to vanish, taking the only way back to a smaller
  page size with it.

The top control's position is asserted, not assumed: the test compares its bounding box against the
table's and requires it above the fold.

---

## 11. Search and filters — verified

Placeholder: `Search name, ID, email, dept, role, manager…`

| Field | Searched | Verified |
|---|---|---|
| Employee Name | ✓ first+last and the `name` column | browser, against real data |
| Employee ID | ✓ | browser |
| Email | ✓ company + personal | browser |
| Department | ✓ | browser |
| Role / Designation | ✓ | browser |
| Manager | ✓ | browser |

Nothing is advertised that is not searched, and nothing searched is unadvertised. The browser test
drives **each** advertised field with a real value from the data and asserts the row that supplied
it comes back; where the data has no usable value for a field it annotates rather than passing
silently.

Searching `"null"` does **not** return the rows whose manager column held the string `'null'` — a
value that is not really there must not be searchable as if it were.

Filters: Department, Status, Role, Incomplete. All applied to the **complete dataset** before
pagination, never to the visible page. They **combine** (Incomplete + Status asserted). Every filter
control and the KPI cards reset to page 1. Status cohorts equal the KPI tile counts, which equal the
dashboard buckets.

---

## 12. Export and bulk actions

### Export — two real problems found

- ⚠ **Aadhaar was exported in full** while the table masks it to `****1234`. An export that reveals
  more than the page it came from is a PII leak with a paper trail. Now masked identically — the
  rule is that the CSV says what the table says.
- ⚠ **No CSV formula-injection guard.** Excel, LibreOffice and Sheets all evaluate a cell beginning
  `=`, `+`, `-`, `@`, TAB or CR. An employee whose name or address begins with one became executable
  content in whoever opened the file. Now prefixed with a single quote, which those tools strip on
  display.
- Scope: `Export` writes the **filtered** set and the button says how many
  (`Export (12)`), so it cannot be mistaken for "export everything". `Export Selected (3)` writes
  exactly the selection. Both browser-asserted, including that the count tracks the filter.
- Also: UTF-8 BOM (Excel on Windows mangled non-ASCII names without it), CRLF line endings, a
  dated filename that names the scope, and the object URL is revoked instead of pinning the blob.

### Bulk actions

Both high-impact actions are **two-step**: choose → *"Review N changes"* → a confirm step naming
the new value, the affected count, and **the affected employees by name** with their Employee ID,
current department and current status. Back and Cancel both work; nothing is written until the
second button. The list caps at 12 with "and N more" and scrolls inside its own panel.

Bulk status additionally: offers only Active / Probation / Notice (no exits — a bulk change carries
no last working day), states how many rows already hold the target and will be skipped, and points
at per-row Terminate for exits.

**Partial failures are reported honestly.** `Promise.all` rejects on the first failure while the
remaining requests keep going — the old code then showed "Failed to update status" and updated
nothing locally, so eleven of twelve employees had in fact been changed on the server while the page
insisted nothing had happened. Now `allSettled`: only fulfilled ids are applied, and the toast reads
`9 updated, 3 failed — the failed records are unchanged`.

Bulk department assignment: requires a selection and a target; the dropdown can only offer
departments that exist; the backend validates against `master_departments` and is tenant-scoped;
counts and KPIs re-derive from the updated state.

---

## 13. Test results

### Backend — `99 files, 2229 passed, 9 skipped, 0 failed`

Above the pre-work baseline of 96 files / 2203 passed: **3 new suites, 26 more tests.**

| Suite | Tests |
|---|---|
| `employeeCode.contract.test.js` | 30 (incl. the concurrency test) |
| `employeeHierarchy.contract.test.js` — **new** | 14 |
| `employeeWriteScope.contract.test.js` — **new** | 4 |
| `employeeTenantScope.integration.test.js` — **new** | 14 |
| `employeeRequiredFields.contract.test.js` — **new** | 7 |
| `employeeHeadcount.reconciliation.test.js` | 6 |
| `smoke.employees.test.js` | 22 |

### Failures on the way here — each identified, none hidden, none weakened

**Run 1: 13 files failed, 3 tests failed, 442 skipped.** All three causes were mine:

1. **`analytics.schemaGuards.test.js`** — the SQL reference checker reported
   `MISSING TABLE walk` for my `WITH RECURSIVE walk(root, node, depth, path, looped) AS (…)`. Its CTE
   regex required `AS (` to follow the name directly, so an explicit column list pushed them apart.
   **Fixed the checker**, not the query — that was a genuine false positive and any CTE declaring its
   columns would have hit it. Re-ran `check-sql-references.mjs` standalone: `PASS`.
2. **`integration.reports.test.js`** — `null value in column "office_id" violates not-null`. The
   fixture inserted an employee without an ID.
3. **The other 12 files** — the same cause in `beforeAll`, which threw, skipped every test in the
   file, and reported the file as failed. Not DB contention, which is what the skip count first
   suggested.

**Run 2: 1 file failed, 0 tests failed, 2208 passed.** `integration.genealogyTraceability.test.js`
— my patch put `${FIXTURE_CODE_SQL}` inside a **single-quoted** string, so it reached Postgres
verbatim: `syntax error at or near "$"`. Converted to a template literal.

**Run 3: 0 failed.**

### Frontend — `24 files, 537 passed, 0 failed`

### Browser

| Project | Result |
|---|---|
| `all-employees` (22-all-employees.spec.ts) | **24 passed, 1 skipped, 0 failed** |
| `employees-dashboard` + `all-employees` together | **65 passed, 1 skipped, 0 failed** |
| Four projects (`all-employees`, `employees-dashboard`, `navigation`, `smoke`) | 345 passed, 1 skipped, **3 failed** → all three diagnosed and resolved (2 were the 27-vs-26 defect below; 1 is pre-existing and out of scope, §14.9) |

The one skip is correct and worth naming: *"searching 'null' does not match the rows whose manager is
the STRING null"* now skips, because `repair-employee-data.mjs` cleared all three of those rows — the
test has nothing left to assert. The unconditional *"no cell anywhere renders a raw null/undefined"*
test still runs with every column switched on.

New in this pass: the top control's position (bounding box above the table), top↔bottom
synchronisation in both directions, page size preserving filters, the Incomplete count equalling the
filtered result, Incomplete combining with Status, the badge naming a mandatory field, the Export
label tracking the filter, column hide + reload persistence, rows-per-page persistence, and the
essential columns not being toggleable.

### A real defect the dashboard suite caught: a KPI of 27 opening a list of 26

`21-employees-dashboard.spec.ts` failed twice with `Expected 27, Received 26` — on the New Hires KPI
drill-down and on "View all" from Recent New Hires. Investigated rather than adjusted:

```
analytics newHires = 27   period 2026-04-01 -> 2026-09-28
rows joined in that window, all statuses = 27
rows joined in that window, non-exited   = 26
  #42 EMP-0034  status="Left"  joined=2026-07-28
```

Both numbers are correct for their own question. **New Hires counts everyone hired in the period** —
it is a hiring-activity metric. **All Employees lists current staff** — ex-employees live on
Ex-Employees. Employee #42 was hired inside the window and has since left, so it is in the first
population and not the second.

Right is not the same as explained, and §8 of the review is explicit that an unexplained pair of
numbers is the defect. Rather than change either population — the KPI would stop measuring hiring,
the register would start listing leavers — **the drill-down chip now states the difference**:

> Showing **26** of 32 employees · Joined This financial year (01 Apr 26 – 28 Sept 26) · 1 more has
> since left and is on Ex-Employees

The two spec assertions were **strengthened, not relaxed**: from `shown === newHires` (false by
definition) to `shown + sinceLeft === newHires`, reading `sinceLeft` from the chip. That pins the
exact relationship between the two populations, so a row going missing for any *other* reason still
fails — which the old equality could not distinguish from this one.

This predates the pass (employee #42 has been `Left` throughout), but it is an All Employees drill-down
defect, so it is fixed here rather than listed.

### Other gates

| Gate | Result |
|---|---|
| `eslint` backend (`src` + `scripts`) | **0 errors**, 245 warnings — all pre-existing, none in files touched here |
| `eslint` frontend (`features/employees`) | **0 errors**, 0 warnings in my files |
| `vite build` | clean, 2.92s |
| `tsc --noEmit` | clean for the spec |
| `check-sql-references.mjs` | PASS |
| `transformWithOxc` parse of every edited file | OK — caught the backtick-in-SQL-comment and the `${…}`-in-single-quotes breakages before either ran |

### Live verification, on a restarted backend

```
Dashboard Current Headcount = 32   buckets Active 29 · Probation 1 · Notice 2
All Employees Total Staff   = 32   tiles   Active 29 · Probation 1 · Notice 2
rows (all statuses)         = 34   exited 2
rows missing an Employee ID =  0
```

Plus the 14 statement-level scope checks in `employeeTenantScope.integration.test.js`, each proving
1 row for the caller's own employee and 0 for another tenant's.

---

## 14. Still needs your decision

1. **26 blank Roles, 1 blank Department, 1 missing joining date** — HR data entry. Reachable in one
   click via Incomplete; cannot be invented.
2. **The 24 `Pilot *` placeholder employees** — complete them into real records, or retire them
   through offboarding. They are live login accounts, so deleting them would break RBAC verification.
3. **11 leaked test-tenant employees** — the narrow purge command is in §9. Needs a backup, and the
   `9999xx` registry conflict resolving first.
4. **2 out-of-range dates of birth** (ids 3, 12) — real values; I did not add a DOB range check
   because a legitimately unusual DOB should not become unsaveable without your say-so.
5. **`getEmployees`' silent 2000-row cap** — needs server-side pagination with a total. A separate
   piece of work; the reconciliation test fails the day it starts to matter.
6. **Legacy `EMP001`-format codes stay accepted** on caller-supplied IDs. Say so and
   `assertCodeAvailable` tightens to canonical-only.
7. **~15 hardcoded exited-status read-lists** across analytics, announcements, dashboard, leaves,
   manager, projects and two crons. Several are **incomplete** — `announcement.service.js` excludes
   only `('resigned','terminated')`, so an employee whose status is `Left` or `inactive` still
   receives announcements. Every write path is now canonical, so these cannot get worse, but they
   are wrong today on other pages. A repo-wide sweep replacing them with `isCurrentSql` /
   `isExitedSql` is the fix — deliberately out of scope here because it touches Projects, Leaves and
   Analytics, and bundling it into an All Employees pass would make a large blast radius invisible.
8. **`purge-leaked-test-tenants.mjs` nominates the `9999xx` registry** that
   `testTenantIds.contract.test.js` documents as deliberate. The two disagree; worth reconciling
   before anyone runs that script with `--apply`.
10. **`POST /leaves` returns 500 for a login with no employee record.** The admin
    trio are deliberately unlinked, `leave_applications.employee_id` is NOT NULL, so
    the insert violates it. The one-line fix is a guard returning 400 "no employee
    record is linked to your login" — the test already documents that as the
    expected response. Left to whoever owns Leaves validation; I did not touch that
    module and would not run its suites here.
9. **One pre-existing browser failure, not caused by this work.**
   `02-navigation.spec.ts` → *"@P1 HR submenu opens on hover and shows expected items"* expects an
   `Offboarding` button directly in the HR submenu. `routes.jsx:1145` marks it
   `inHub: 'ExitCenter'`, so the submenu correctly shows **Exit & Probation** instead — the Exit
   Center hub consolidation from an earlier session, with the nav spec never updated.

   Proof it is not mine: `routes.jsx` was last modified 09-27 22:10, `menuCatalog.js` 09-16,
   `Sidebar.jsx` 09-16 and the spec itself 09-01. I did not touch any of them.

   **Deliberately not "fixed".** The one-line change is to expect `Exit & Probation`, but which
   items the HR submenu should surface is a product decision about the Offboarding/Exit Center
   hub, not an All Employees concern — and editing an assertion I did not break is how a real nav
   regression gets masked. Flagging it instead.

---

# ADDENDUM - Employee ID format corrected to `EMP001`

**Date:** 2026-09-28, same day. This supersedes every `EMP-0001` statement above.

## What I got wrong

I adopted the **hyphenated** `EMP-0001` as canonical and backfilled 35 employees
that way. The reasoning was that `shared/docNumber.js`, `utils/generateCode.js` and
the recruitment hire path all produced that shape, so it was "the format the
codebase had already settled on" - and the eight rows carrying `EMP001`...`EMP012`
were therefore legacy to be tolerated.

That inverted the evidence. Those eight rows predate the entire codebase change
and **are** the company's convention. Of the three code paths that outvoted them,
**two had no callers at all** (`docNumber.nextEmployeeCode` and `generateCode` were
both dead), and the third was the same hire path whose numbering I had just
described as broken.

**Live data that predates the code is the spec. Three agreeing code paths are not -
especially when two of them are dead.** I should have weighted eight rows written
by the business over three functions written by developers, and I did the reverse.

## The canonical format

```
EMP001  EMP002  EMP009  EMP010  EMP012  EMP013  EMP036  EMP100  EMP999  EMP1000
^EMP[0-9]{3,}$
```

No hyphen. Three digits minimum, zero-padded, **not capped** - the thousandth
employee is `EMP1000`. Rejected: `EMP-001`, `EMP-0013`, `EMP01`, `EMP1`,
`EMP 001`, `EMPABC`, `ABC001`, `emp001`.

## 1. Highest existing Employee ID before migration

**`EMP012`** (suffix 12) - company 1, 8 canonical rows: `EMP001 EMP002 EMP003
EMP005 EMP006 EMP010 EMP011 EMP012`. The gaps at 004 and 007-009 were already
there and were left alone.

## 2-3. Backfill / renumber - 37 rows, range `EMP013`...`EMP038`

`scripts/hr/renumber-employee-codes.mjs --apply`, dry-run reviewed first.
Two cases, reported separately because they carry different weight:

**A. Hyphen removed, NUMBER PRESERVED - 35 rows.** `EMP-0013` -> `EMP013`, through
to `EMP-0036` -> `EMP036` (company 1, the 24 rows my bad backfill created), plus
11 test-tenant rows `EMP-0001` -> `EMP001` **within their own company**.

**B. NUMBER CHANGED - 2 rows.** These could not simply lose the hyphen:

| id | was | now | why |
|---|---|---|---|
| 45 Resume DB Candidate | `EMP-0001` | **`EMP037`** | `EMP001` is held by employee #1 (Malar Natesh) |
| 46 Direct Path Candidate | `EMP-0002` | **`EMP038`** | `EMP002` is held by employee #2 (Natesh Mayavel) |

Both predate my work (they came from the recruitment hire path) and both are
recruitment test candidates. Reassigning was required - the strict CHECK would
otherwise have made those two rows uneditable for ever - and it is listed here
rather than done quietly.

**`EMP001`...`EMP012` were not touched.** That is the whole point: those are the
numbers already on people's records.

## 4. Duplicate IDs - 0

## 5. Malformed IDs - 0

`0 NOT in the EMP001 format`; all 34 company-1 codes on 3 digits. Verified after
the renumber as a pre-commit gate inside the same transaction, and again
afterwards.

## 6. Generator

`shared/employeeCode.js` - the only module in `backend/src` that defines a
code-minting function, asserted by `employeeCodeSingleGenerator.contract.test.js`.

- `formatEmployeeCode(n)` -> `EMP` + `padStart(3,'0')`. `padStart` pads and never
  truncates, so 1000 -> `EMP1000`, not `EMP100`.
- MAX over the **numeric suffix**, per company: `EMP001, EMP002, EMP005` -> next is
  **`EMP006`**, not `EMP003`. A gap means someone's record was removed; reissuing
  their number to a different person is worse than a gap.
- Company-scoped `pg_advisory_xact_lock`, held to COMMIT.
- **Fixture-range codes excluded.** `FIXTURE_CODE_SQL` mints from 900000+ and
  `integration.reports.test.js` inserts one of those into **company 1** - without
  the exclusion the next real hire there would have been `EMP900002` and the
  company's series abandoned permanently. New test covers it.

Removed: `docNumber.nextEmployeeCode` (dead, wrong format), replaced by a note
explaining why employee codes cannot be a global sequence draw like the other
document numbers - they are per-company. `utils/generateCode`'s JSDoc no longer
uses EMP as its example.

## 7. Concurrency - the review's exact scenario

Seeded a private company to exactly `EMP012`, with gaps at 004 and 006-009/011 so
the highest-suffix rule is actually exercised, then 5 concurrent `addEmployee`
calls through the real service:

```
  PASS  all 5 succeeded
  PASS  no duplicates
  PASS  no gaps (contiguous sequence)
  PASS  exactly EMP013, EMP014, EMP015, EMP016, EMP017
  PASS  database holds no duplicate codes
  teardown: company removed, 0 employee rows remain
```

Kept as a permanent test, seeded to EMP012 rather than run against company 1:
company 1's highest is now EMP038, so a test there would prove the same property
while showing different numbers, and an expectation that drifts with the seed data
is one nobody trusts.

## 8. Database constraint - `20260928000004`

`CHECK (office_id IS NULL OR office_id ~ '^EMP[0-9]{3,}$')`, added **VALID** (not
NOT VALID) after the renumber, so Postgres scanned the table and validation
passing IS the proof that no live row became unwritable.

```
EMP500 EMP999 EMP1000 EMP100        -> accepted   (4 PASS)
EMP-001 EMP-0013 EMP01 EMP1
'EMP 001' EMPABC ABC001 emp001      -> rejected   (8 PASS)
```

The trap, restated because it is why the ORDER matters: **a CHECK fires on every
UPDATE too, `NOT VALID` included** - `NOT VALID` only skips the initial scan. A
CHECK that any live row fails turns every later edit of that row into a 400: a
phone-number change rejected over an Employee ID nobody touched. So the renumber
came first and the constraint second.

Section 5's edit matrix, run on `EMP001` (oldest), `EMP013` (renumbered) and
`EMP037` (reassigned) - **24 of 24 passed**: name, phone, department, designation,
manager, status, email, and a full profile update touching every column at once.

## 9. All Employees UI

```
EMP001 EMP002 EMP003 EMP005 EMP006 EMP010 EMP011 EMP012 EMP013 EMP014 ... EMP038
off-format: 0     hyphenated: 0
search "EMP013" -> 1 row (EMP013 Pilot HR)
```

Export writes the same `office_id` the table shows, so the CSV carries `EMP013`.
`next-code` returns **`EMP039`** (highest is EMP038). A create with no code
supplied returned `EMP039`; a supplied `EMP-0040` was refused with *"not a valid
Employee ID. Expected the form EMP001 (EMP followed by at least three digits, no
hyphen)."*

## 10. Remaining `EMP-` references

**No live code produces one.** What remains is deliberate:

| Where | Why it stays |
|---|---|
| Historical comments in `employeeCode.js`, `recruitment.repository.js`, migrations, tests | They explain this mistake so it is not repeated. The guard test strips comments before searching. |
| `codeSeq('EMP-0001') === 1` in tests | The suffix reader stays tolerant on purpose - that is what let the renumber script and the generator agree during the migration instead of producing `-2`. |
| `'EMP-001'`, `'EMP-0013'` as test inputs | Asserting they are **rejected**. |
| Migrations `20260928000001` / `000003` | Applied; their text is history, and `000004` supersedes their constraint. Editing an applied migration breaks its checksum. |
| `backend/scripts/seed/_api-sweep.json` | A captured API-response fixture from before the change. Data, not code. |

Also corrected: `EmployeeAutoCreation.jsx` promised users a "Unique EMP-XXXX code"
(now `EMP001`-style), and `EmployeeAssets.jsx` rendered a missing name as
`EMP-{id}` - which was never an Employee ID at all, so it now reads
`Employee #{id}`.

Three new guards in `employeeCodeSingleGenerator.contract.test.js`: only one module
may define `nextEmployeeCode`; no source file may build an EMP code from a hyphen;
and nothing may truncate to a fixed 3-digit width.

## 11. Test results

| Gate | Result |
|---|---|
| Backend | **101 files, 2253 passed, 9 skipped, 0 failed** (was 99/2229 before the format work) |
| Frontend | **24 files, 537 passed, 0 failed** |
| eslint backend (`src` + `scripts`) | **0 errors**, 245 warnings (all pre-existing, none in files touched) |
| `vite build` | clean |
| `tsc --noEmit` | clean |
| `check-sql-references.mjs` | PASS |
| Browser (`all-employees`, `employees-dashboard`, `crud-employees`, `db-consistency`) | **87 passed, 1 skipped, 1 failed** — the failure is the pre-existing `POST /leaves` 500 below |

New suites this pass: `employeeCodeSingleGenerator.contract.test.js` (5 tests).
`employeeCode.contract.test.js` grew from 30 to 35 — the format matrix, the
highest-suffix rule, the fixture-floor exclusion and the EMP012 -> EMP013..EMP017
concurrency scenario.

### Two stale fixtures found by the browser run, both pre-existing

`06-db-consistency.spec.ts` had not run in this session before now, so these
surfaced late:

1. **`[EMP-CONSISTENCY-2] Create employee via API`** failed twice, for two
   different reasons. First it was missing `status`, which became mandatory in the
   previous pass. Then, with status supplied, it still 400'd on
   `designation: 'QA Automation'` — a value in neither `master_designations` (24
   active values) nor on any employee, so `validateMasterValue` has always rejected
   it. That fixture could only ever pass when an **earlier run of itself** had
   leaked a row carrying that designation, which its own teardown then deleted.
   Self-dependent, and stale independently of this work. Changed to `Engineer`,
   which is in the master.

2. **`[LEAVE-CONSISTENCY-2] Create leave via API` returns 500** — and this one is
   NOT fixed, because it is not this page's:

   ```
   POST /leaves as admin@manifest.in
   -> 500  null value in column "employee_id" of relation "leave_applications"
           violates not-null constraint
   ```

   The admin logins are deliberately not linked to an employee row
   (`users.employee_id IS NULL` — that is the documented login policy), and
   `leave_applications.employee_id` is NOT NULL, so the route inserts NULL and
   Postgres rejects it. The test itself already says the right answer is a 400/422
   ("Superadmin has no employee record"), so the defect is the route returning a
   500 instead of a validation error.

   **Not mine:** I modified zero files under `modules/leaves` or `features/leaves`,
   and nothing I changed touches `leave_applications`. **Not fixed here:** turning
   that 500 into a 400 is a Leaves-module validation rule, and changing it without
   running the Leaves suites would be a blind edit. Listed in §14 instead.

---

# FINAL — the last failure fixed, and a cold-session acceptance walkthrough

**Date:** 2026-09-29

## The `POST /leaves` 500 — fixed

Two NOT NULL columns could be reached with NULL, and each produced a bare 500 where
the caller should have been told what was wrong:

| Column | Reached when | Now |
|---|---|---|
| `leave_applications.employee_id` | the caller's login has no linked employee row — the three admin accounts are deliberately unlinked | **400** `EMPLOYEE_LINK_REQUIRED`, with different wording for HR (*"specify which employee"*) and for an employee (*"your login is not linked to an employee record"*) |
| `leave_applications.number_of_days` | dates sent without a day count — `normalizeApplicationPayload` only passes the field through | **400** `NUMBER_OF_DAYS_REQUIRED` |

The second one I found while verifying the first, by sending the same request with
an `employee_id` supplied.

**`number_of_days` is validated, not derived.** `end - start` looks obvious, but how
many *leave* days that is depends on weekends, the holiday calendar and half-days —
policy the Apply Leave form already owns and sends (`number_of_days: days`). A second
computation here would be a second opinion on leave policy, and the two would drift.
So the UI is unaffected and an integration that omits it is told what is missing.

### What that exposed in the test helpers

Fixing it failed two `smoke.leaves.test.js` tests, and the cause was the fixture, not
the guard: `employeeToken()` signed **no `employee_id` claim**. `verifyToken` does
`req.user = decoded` and the real login signs `employee_id: user.employee_id ?? null`,
so a genuine employee's token always carries one. With the repository mocked, the
missing claim never reached Postgres — so the fixture had been **hiding** this exact
500 rather than catching it.

`employeeToken` / `hrToken` / `managerToken` now carry an `employee_id`.
`adminToken` deliberately does not, because that is accurate: the admin logins are
unlinked, which is the case that produced the 500. **Full backend suite after the
change: 101 files, 2253 passed, 0 failed** — nothing else depended on the unrealistic
token.

`06-db-consistency` now passes **14/14**.

## Cold-session acceptance walkthrough — `23-all-employees-acceptance.spec.ts`

Suite 22 tests behaviour. This one tests what someone who has **never opened the page**
sees, which suite 22 structurally cannot: Playwright's `storageState` carries
`localStorage` between runs, and suite 22 deliberately switches every column on and
changes the page size. So it clears `pulse_emp_cols` and `pulse_emp_page_size` before
navigating, and each test gets its own cold context.

**17 tests, all passing.** Coverage: no error boundary and no console errors; every
Employee ID matching `^EMP\d{3,}$` with none blank; no raw null/undefined/NaN/Invalid
Date with every column switched on; the **defaults** (20 rows per page, the documented
column set, and the off-by-default columns genuinely off); Total Staff against the API
and the KPI tiles summing to it; page 2 holding different people with continuing row
numbers and the last page closing the range; search by all six advertised fields;
Department + Status + Role combining with Clear restoring the controls; the Incomplete
count equalling its own result set and the badges naming real fields; bulk status
unable to apply in one click and naming who it affects; Export stating its row count
and tracking the filter; row actions present with Terminate cancellable and a
last-working-day field; and no horizontal page scroll at 1280/1440/1920 with every
column on.

### One defect found, and it was mine

The `DEFAULTS: the default column set` test failed claiming the **Employee column was
missing**. The page snapshot showed it present and correct. `.ed-th` carries
`text-transform: uppercase`, and `innerText` reports the **rendered** text — so the
headers come back as `"EMPLOYEE"`, `"EMP ID"`, and my case-sensitive
`includes('Employee')` missed them. The assertion is now case-insensitive with a note
saying why.

Worth recording as a method point: the neighbouring test passed because it happened to
use `/Emp ID/i`. **When a UI assertion fails, read the snapshot before believing the
assertion** — the page was right and the test was wrong, which is the same direction of
error as the `EMP-0001` format mistake.

---

# UX — the Total Staff KPI is now clickable

**Date:** 2026-09-29

## What was wrong

Three of the four KPI cards filtered the list; **Total Staff did nothing**. Worse, all
four were `<div onClick>`, so the whole band was:

- unreachable by keyboard (no `tabindex`, no Enter/Space),
- invisible to a screen reader (no role, no accessible name — the visible text is a
  bare number plus a two-word label, which reads as "32 Total Staff" out of context),
- and Total Staff looked *identical* to the three that worked.

## What Total Staff now does, and why it is not a fake filter

The register's base population **already excludes exited employees** (`allStaff`), so
"current staff" cannot narrow the list further. A chip that filtered nothing would be
a fabricated affordance.

So the card does two things that are real:

1. **Clears** every other narrowing — status, department, role, search, Incomplete.
   From a drilled-down Active view, it is the way back to the whole register.
2. **States what is on screen**, in the existing dismissible drill chip:

   > Showing **32** of 32 employees · Current Staff · 2 exited records are not shown
   > here — see Ex-Employees ✕

That second line is the one fact the plain register hides: the count says "32 of 32"
and never mentions the 34 rows behind it. The card makes the 34→32 gap explicit and
says where the other two are — which is also exactly what §2 asked for (Total Staff
must *not* be read as all database rows).

Implemented through the page's **existing** drill-chip mechanism (`drillFilter` +
`.ed-drill-chip`), not a second chip system: an empty-criteria filter carrying only a
label, so `matchesEmployeeFilter` narrows nothing and the count stays 32.

## Accessibility

Every KPI card is now a real `<button type="button">`:

| | |
|---|---|
| Whole tile is the target | asserted: card width > 1.5x the number's width; the test clicks the **label**, not the number |
| cursor / hover | unchanged (`.ed-kpi-card-clickable`) |
| keyboard | native — focusable, **Space and Enter** both activate |
| accessible name | `aria-label`, e.g. *"Total Staff: 32 employees. Show all current staff."* |
| state | `aria-pressed`, because the cards are toggles |
| no nested button | asserted — zero interactive descendants |
| valid HTML | nothing interactive inside a button |

⚠ The CSS resets went **into the original `.ed-kpi-card` rule**, not into a second
block at the end of the file. My first attempt appended a duplicate selector 700 lines
below the first, which silently overrode the card's `border: 1.5px solid #ede9fe` with
a 1px grey one — a visual regression from a rule that looked additive. One selector,
one source of truth.

## The numbers did not change (§6)

```
Active 29 · Probation 1 · Notice 2 · Other 0 · Total Staff 32   (sum = 32)
exited, not shown on this page: 2
```

## Tests

`23-all-employees-acceptance.spec.ts` gained a `KPI drill-down` block — **6 tests**:

- all cards are whole-card buttons with an accessible name, `aria-pressed`, pointer
  cursor and no nested interactive element;
- each status KPI's number equals the cohort it opens, sets the Status control, and
  **toggles off** on a second click;
- **the review's nine steps in order** — read the KPI, narrow to Active first so
  "clears the other filters" is genuinely exercised, click the card *body*, assert the
  count equals the KPI, the chip is visible and names "Current Staff", no exited
  employee code appears in the list, the chip names the 2 exited records, then Clear
  and the full register returns;
- Total Staff operable by keyboard: focus, **Space** to apply, **Enter** to release.

All counts come from the live API, never a hardcoded 32.

| Gate | Result |
|---|---|
| Browser — `all-employees-acceptance` + `all-employees` + `employees-dashboard` | **86 passed, 1 skipped, 0 failed** |
| Frontend unit | 24 files, **537 passed** |
| eslint (changed file) · `vite build` · `tsc` | clean · clean (3.48s) · clean |

### One defect found, and it was mine again

The "all KPI cards" test first failed on `ACTIVE's name should mention it`.
`.ed-kpi-label` carries `text-transform: uppercase` and `innerText` reports the
**rendered** text, so the label came back `"ACTIVE"` while the `aria-label` says
`"Active: …"`. Same trap as the column-header assertion earlier in this work — third
time that CSS property has misled a test of mine, so both assertions now compare
case-insensitively with a note saying why.
