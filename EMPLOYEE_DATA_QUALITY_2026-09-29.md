# Employee data quality — company 1, 2026-09-29

Written for HR and the engineer maintaining the Employee module.

Measured against the live database after the 2026-09-29 normalisation migration.
Company 1 holds **35 active employee records**, `EMP001`–`EMP039`.

The two lists below are deliberately separate. Everything in §1 has already been
done because it could not lose information. Everything in §2 needs a human who
knows the business, and has been left exactly as it was.

---

## 1. Safe automated fixes — DONE

Applied by `20260929000003_employee_data_normalisation.js`, with row counts
logged by the migration itself.

| # | Change | Rows | Why it was safe |
|---|---|---|---|
| 1 | `employment_type = ''` → `NULL` | **4** | Both mean "not recorded". Only `NULL` survives a truthiness check, so the empty string made 4 people read as *having* a type in any `IS NOT NULL` query while displaying blank. The empty string carried no information to lose. |
| 2 | `employment_type = 'full_time'` → `'Full Time'` | **1** | The column was written by two vocabularies (the HR list and recruitment's snake_case one). Same employment type, two spellings; only `Full Time` is in the master, so the other was a value no picker could offer back. Mapped *against the master*, not hard-coded. |
| 3 | Deactivated 5 `SEED Master Zones N-SEED…` rows | **5** | Seeding artefacts — all five created in the same 3 ms on 2026-08-20. Referenced by no employee and no holiday. Deactivated, not deleted, so they are recoverable in one click. |
| 4 | Promoted `'North'` and `'HO'` into `master_zones` | **2 new** | The only zones employees actually carry, and they were not in the master at all — so the Holiday Calendar (which assigns holidays by `zone_id`) could offer only the five SEED names. |
| 5 | Backfilled `employees.zone_id` | **4** | The FK was NULL on all 46 rows while the text column held the value. A backfill cannot overwrite anything when there is nothing there. |

**Verified after**: every stored `employment_type` is now in the master; no
snake_case values remain; no active SEED zone remains; every employee zone text
is linked to a master row and the two never disagree.

---

## 2. HR decisions required — NOT CHANGED

None of these can be resolved without someone who knows the business. Guessing
would be inventing HR data.

### 2.1 Missing mandatory-ish fields

| Field | Employees affected | Note |
|---|---|---|
| Designation | **27** | Created before `REQUIRED_ON_CREATE` enforced it. New records cannot be saved without one. |
| Employment Type | **29** | Same. Not required by the API, so this is a completeness question, not a blocker. |
| Joining Date | **2** | Required for new records. These two predate the rule and have no probation clock, no tenure and no hiring-window membership. |
| Department | **1** | Required for new records. |
| Manager | **31** | Not required and legitimately absent for a founder/CEO — but 31 of 35 is worth a look at the org chart. |

These surface on All Employees as the **Incomplete** badge, which is the right
place for them.

### 2.2 Four malformed bank names

`employees.bank_name` was free text until 2026-09-28. Three of the four are
keyboard mash; the fourth is a real bank in a non-canonical spelling.

| Employee ID | Name | Stored value | Suggested |
|---|---|---|---|
| EMP001 | Malar Natesh | `vdsf` | — needs the real bank |
| EMP002 | Natesh Mayavel | `ICICI` | `ICICI Bank` (in the master) |
| EMP003 | Anu Natesh | `czxc` | — needs the real bank |
| EMP039 | Testf f | `kljfsdkjf` | — looks like a test record |

⚠ **Not auto-corrected, including `ICICI`.** This column is half of the payment
instruction payroll writes into a NEFT/RTGS advice file. `ICICI` → `ICICI Bank`
looks obvious, but a bank name on a salary account is not something a migration
should guess at — and the other three prove the field was not being filled
carefully, so the account details beside them deserve checking at the same time.

Fix by opening each employee and picking from the Bank dropdown. The old value
is still offered back as its own option, so nothing is lost by opening the
record.

### 2.3 Three free-text locations

`employees.location` was free text until 2026-09-28. Company 1 has one real
branch (`Head Office`, Srivilliputtur).

| Employee ID | Stored `location` | `branch_id` |
|---|---|---|
| EMP001 | `Srivil` | NULL |
| EMP002 | `Srivi` | NULL |
| EMP003 | `czxzx` | NULL |

Two look like truncated attempts at "Srivilliputtur" — i.e. Head Office. Not
auto-mapped: "looks like" is not evidence, and assigning someone to the wrong
branch changes which holiday calendar and which approval chain they fall under.

Fix by opening each employee and picking Head Office from the Location dropdown,
which stores `branch_id` properly.

### 2.4 One unused master value

`EMPLOYMENT_TYPE` → **`Test`** (company 1, id 1853). Referenced by **zero**
employees.

Obvious debris, and safe to remove — but it is your master data, not a
migration's. Administration → Master Data → Employment Type shows it as
`unused`, so the button there reads **Delete** and removes it permanently.

---

## 3. Integrity — all clean

Re-checked after every change. All zero:

| Check | Count |
|---|---|
| Duplicate Employee IDs (per company) | 0 |
| Duplicate company emails (per company) | 0 |
| Malformed Employee IDs (not `^EMP[0-9]{3,}$`) | 0 |
| Self-managers | 0 |
| Manager cycles | 0 |
| Managers pointing at a deleted row | 0 |
| **Cross-tenant manager references** | 0 |
| **Cross-tenant asset allocations** | 0 |
| **Cross-tenant branch references** | 0 |
| Employees filed under an inactive department | 0 |
| Future-dated joining dates | 0 |
| Manager column holding the literal string `'null'` | 0 |

---

## 4. Future schema work (not done, deliberately)

**`employees.zone` and `employees.location` are denormalised text beside their
FKs.** Both now stay in sync automatically — the API derives the text from the
master row it resolved, so the two cannot drift — but the text columns are still
what most readers use.

Dropping them is a separate change that needs every reader migrated first
(`EmployeeProfile`, the All Employees column set, the export, several reports).
It is not urgent: the columns are consistent, and the FKs are populated for new
records. Doing it in the same pass that populated the FKs would have meant
changing readers and writers at once with no working state in between.
