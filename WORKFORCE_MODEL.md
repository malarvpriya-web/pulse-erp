# Workforce model — who goes in `employees`, and who does not

Written for engineers and HR administrators deciding where a person's record belongs.

Established 2026-09-29 during the Add Employee / Master Data pass. This documents
the model that **already existed**; no new workforce model was invented.

---

## The rule

> **On the company's payroll → `employees`.**
> **On an agency's payroll → `contract_labour`.**

The kind of work someone does never decides which table they go in.

---

## 1. Company workers — one Employee master, no exceptions

Housekeeping staff, security guards, drivers, office assistants, canteen staff,
gardeners and maintenance technicians are employees when the company pays them.
They go in `employees` like everyone else, and they are **differentiated by
their master-data fields**, not by a separate screen:

| Person | Department | Designation | Employment Type |
|---|---|---|---|
| Housekeeper | Facilities | Housekeeping Staff | Contract |
| Housekeeping lead | Facilities | Housekeeping Supervisor | Permanent |
| Guard | Security | Security Guard | Contract |
| Guard supervisor | Security | Security Supervisor | Permanent |
| Driver | Administration | Driver | Permanent |
| Office assistant | Administration | Office Assistant | Permanent |
| Facilities engineer | Facilities | Maintenance Technician | Permanent |

Plus, as for any employee: **Manager**, **Location / Branch**, **Status**.

### Do not build separate screens for these categories

There is one Employee master, one Add/Edit Employee form and one register. A
"Housekeeping" screen would fork the vocabulary, the validation, the PII masking
and the tenant scoping — every defect fixed in `employees` would have to be
fixed again. Filter the register by department instead.

### What was missing, and is now seeded

The masters could not express any of the rows above: there was no Facilities,
Security or Administration department and no Housekeeping / Guard / Driver /
Office Assistant designation, so the only way to file such a person was to type
a value the master did not hold — which the server now rejects. Migration
`20260929000002_master_data_governance.js` seeds:

- **Departments** — Facilities, Security, Administration
- **Designations** — Housekeeping Staff, Housekeeping Supervisor, Security
  Guard, Security Supervisor, Driver, Office Assistant, Facilities Executive,
  Maintenance Technician

`Contract` was already in the EMPLOYMENT_TYPE vocabulary, alongside Permanent,
Probation, Part Time, Full Time, Intern, Consultant and Apprentice.

> ⚠ "Employment Type: Contract" means **a fixed-term company employee**. It does
> *not* mean agency-supplied. That distinction is section 2.

---

## 2. Agency-supplied manpower — `contract_labour`

A person supplied by a manpower contractor is **not** a company employee. They
have no company salary, no company PF/ESI account of the company's own making,
and no employee number. Forcing them into `employees` would corrupt headcount,
attrition, payroll, the org chart and every statutory register that counts
employees.

Pulse already models them. **`contract_labour`** (company-scoped) carries:

| Column | Why it exists |
|---|---|
| `contractor_company` | Which agency supplies them — the field `employees` has no place for |
| `employee_name`, `employee_code` | The agency's own identification |
| `designation` | Validated against the same designation master |
| `contract_start`, `contract_expiry` | The engagement window |
| `safety_certified`, `safety_cert_expiry` | Site-access compliance |
| `compliance_ok`, `pf_member`, `esi_covered` | Contract Labour Act / statutory coverage |
| `shift_id`, `branch` | Where and when they work |
| `aadhar_number`, `contact_phone` | Identity and contact |

`contract_labour_attendance` records their attendance separately from employee
attendance, which is what keeps them out of the employee headcount.

This is the correct Indian model: the Contract Labour (Regulation and Abolition)
Act treats contract workers as a distinct, separately-registered class, and the
principal employer's obligations (PF/ESI coverage verification, safety
certification) are exactly the columns above.

---

## 3. Deciding

```
Does the company pay this person directly?
├── YES → employees
│         Department + Designation + Employment Type + Manager + Branch + Status
│         (Employment Type = Contract for a fixed-term company hire)
│
└── NO, an agency does → contract_labour
          contractor_company + contract window + compliance flags
```

Borderline cases worth naming:

- **Consultant invoicing the company directly** → `employees`, Employment Type
  `Consultant`. They are engaged by the company, not supplied by an agency.
- **Apprentice / trainee under a company scheme** → `employees`, Employment Type
  `Apprentice`.
- **Agency guard who is later hired directly** → a NEW `employees` record on the
  date of direct hire. Do not backdate: their service with the company starts
  when the company starts paying them.
- **Vendor's engineer visiting for a service call** → neither. They are a
  `vendor_contacts` row; they are not workforce.

---

## 4. What this means for the masters

Department and Designation are shared across both tables — `contract_labour`
validates `designation` against the same `master_designations`. That is
deliberate: "Security Guard" should mean the same job whether the person is on
the company's payroll or an agency's, so the two populations can be compared.

Manage both vocabularies in **Administration → Master Data**.

---

## 5. Status quo not changed by this pass

- `contract_labour` has **4 live rows** and its own module; this pass did not
  alter its schema, its routes or its screens.
- No employee record was re-classified.
- The only change was seeding the department and designation values the employee
  model needed in order to express section 1 at all.
