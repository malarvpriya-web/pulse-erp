# LEAVE TYPES AUDIT
## All Leave Types — DB Schema, Configuration, Policy Attributes
**Audit Date:** 2026-06-12  
**Source:** Migrations 20260424000001, 20260605000001, 20260609000001

---

## Seeded Leave Types (24 total)

### Group A — Core Leave Types (Initial Seed)

| Code | Name | Annual Quota | Paid | LOP | CF | Half-Day | Encashable | Gender | Probation |
|------|------|-------------|------|-----|----|----------|-----------|--------|-----------|
| AL | Annual Leave | 18d | Yes | No | No | No | No | All | No |
| SL | Sick Leave | 6d | Yes | No | No | No | No | All | No |
| CL | Casual Leave | 4d | Yes | No | No | No | No | All | No |
| COMP | Compensatory Leave | 3d | Yes | No | No | No | No | All | No |
| MAT | Maternity Leave | 180d | Yes | No | No | No | No | Female | Yes |
| PAT | Paternity Leave | 5d | Yes | No | No | No | No | Male | Yes |

### Group B — Extended Types (Phase 20260605 Seed)

| Code | Name | Annual Quota | Accrual | CF | Half-Day | Encashable | Sandwich | Restriction |
|------|------|-------------|---------|-----|----------|-----------|----------|-------------|
| EL | Earned Leave | 12d | monthly | Yes | Yes | Yes | Yes | None |
| PL | Privilege Leave | 15d | monthly | Yes | Yes | Yes | Yes | None |
| BVL | Bereavement Leave | 3d | — | No | No | No | No | None |
| MRG | Marriage Leave | 3d | — | No | No | No | No | None |
| LOP | Loss of Pay | 0d | — | No | No | No | No | None |
| OD | On Duty | 0d | — | No | No | No | No | None |
| TRN | Training Leave | 5d | — | No | No | No | No | None |
| SHUTDOWN | Plant Shutdown | — | — | No | No | No | No | None |
| WFH | Work From Home | — | — | No | Yes | No | No | None |
| OH | Optional Holiday | 2d | — | No | No | No | No | None |
| SAB | Sabbatical | — | — | No | No | No | No | None |
| SAFETY | Safety Training | 2d | — | No | No | No | No | None |
| STUDY | Study Leave | 5d | — | No | No | No | No | None |

### Group C — Industrial Leave Types (Phase 20260609 Seed)

| Code | Name | Annual Quota | CF | Half-Day | Encashable | Notice | Probation | Description |
|------|------|-------------|-----|----------|-----------|--------|-----------|-------------|
| TL | Travel Leave | 6d | No | Yes | No | 1d | Yes | Field engineers travelling to sites |
| EML | Emergency Leave | 3d | No | No | No | 0d | Yes | Critical emergencies, negative balance allowed |
| SL2 | Site Leave | 12d | Yes (max 6) | Yes | Yes (max 3) | 3d | No | Engineers at customer sites |
| SDL | Shutdown Leave | 5d | No | No | No | 0d | Yes | Mandatory plant shutdown |
| FDL | Field Duty Leave | 10d | Yes (max 5) | Yes | Yes (max 5) | 2d | No | HVDC/STATCOM/SST extended deployment |

---

## Policy Attributes Reference

All 20+ policy columns on leave_types table:

| Column | Data Type | Default | Purpose |
|--------|-----------|---------|---------|
| carry_forward_allowed | boolean | false | Enable carry forward |
| max_carry_forward_days | integer | 0 | Cap on carry forward |
| carry_forward_expiry_months | integer | null | Months before CF expires |
| accrual_type | varchar | null | 'monthly', 'quarterly', 'yearly', 'joining_date', 'manual' |
| accrual_days_per_month | numeric | 0 | Days accrued monthly |
| allow_negative_balance | boolean | false | Allow overdraft |
| requires_attachment | boolean | false | Force document upload |
| requires_medical_cert_days | integer | null | Cert required if >N days (sick leave) |
| min_notice_days | integer | 0 | Advance notice enforcement |
| max_consecutive_days | integer | null | Maximum continuous days |
| allow_half_day | boolean | false | Allow AM/PM split |
| is_encashable | boolean | false | Can be converted to cash |
| max_encash_days_per_year | integer | 0 | Annual encashment cap |
| gender_restriction | varchar | null | 'male', 'female', null |
| allowed_in_probation | boolean | false | Eligible during probation |
| is_paid | boolean | true | Paid leave or LOP |
| is_lop_type | boolean | false | Triggers LOP payroll deduction |
| is_comp_off_type | boolean | false | Compensatory off target type |
| sandwich_rule | boolean | false | Count weekends/holidays if sandwiched |
| include_holidays | boolean | false | Count holidays in duration |
| include_weekends | boolean | false | Count weekends in duration |

---

## Leave Types — Configuration Completeness

| Code | Accrual Config | Policy Config | Payroll Config | Status |
|------|---------------|--------------|----------------|--------|
| EL | ✅ monthly, 1d/month | ✅ CF=15d, sandwich | ✅ is_paid, is_encashable | Complete |
| PL | ✅ monthly, 1.25d/month | ✅ CF=15d, sandwich | ✅ is_paid, is_encashable | Complete |
| AL | ❌ no accrual config | ❌ no CF | ✅ is_paid | Partial |
| SL | ❌ no accrual config | ❌ no CF | ✅ is_paid | Partial |
| CL | ❌ no accrual config | ❌ no CF | ✅ is_paid | Partial |
| LOP | N/A (0 quota) | N/A | ✅ is_lop_type=true | Complete |
| WFH | N/A | N/A | ✅ is_paid | Complete |
| MAT | N/A | N/A | ✅ is_paid, gender=female | Complete |
| PAT | N/A | N/A | ✅ is_paid, gender=male | Complete |
| TL | ✅ manual | ✅ no CF, notice=1d | ✅ is_paid | Complete |
| EML | ✅ manual | ✅ negative_balance=true | ✅ is_paid | Complete |
| SL2 | ✅ manual | ✅ CF=6d, encash=3d | ✅ is_paid | Complete |
| SDL | ✅ manual | ✅ no CF | ✅ is_paid | Complete |
| FDL | ✅ manual | ✅ CF=5d, encash=5d | ✅ is_paid | Complete |

---

## Missing Leave Types (by comparison with Indian statutory requirements)

| Type | Present? | Gap |
|------|----------|-----|
| Earned Leave (EL) | ✅ | — |
| Privilege Leave (PL) | ✅ | — |
| Casual Leave (CL) | ✅ | — |
| Sick Leave (SL) | ✅ | — |
| Maternity Leave | ✅ | — |
| Paternity Leave | ✅ | — |
| Bereavement Leave | ✅ | — |
| Compensatory Off | ✅ | — |
| Loss of Pay | ✅ | — |
| Optional Holiday | ✅ | — |
| WFH | ✅ | — |
| On Duty | ✅ | — |
| Sabbatical | ✅ | — |
| Study Leave | ✅ | — |
| Marriage Leave | ✅ | — |
| Safety Training Leave | ✅ | — |
| Adoption Leave | ❌ | Missing — not seeded |
| Flood/Calamity Leave | ❌ | Missing |
| Quarantine Leave | ❌ | Missing |
| Voting Leave | ❌ | Missing (Factories Act) |
| Examination Leave | ❌ | Missing |

---

## Company-Scoping Status

| Scope | Status | Migration |
|-------|--------|-----------|
| Seeded types (company_id = NULL) | Shared across all tenants | 20260603000001 |
| Per-company types (company_id = X) | Can be created via API/UI | 20260603000001 |
| leave_policies per-company overrides | Table exists, NO API CRUD, NO UI | UNUSED |

---

## Critical Findings

| ID | Finding | Severity |
|----|---------|----------|
| LT-1 | Annual Leave (AL) has no accrual config — manual allocation only | HIGH |
| LT-2 | Sick Leave (SL) has no accrual config — manual allocation only | HIGH |
| LT-3 | Casual Leave (CL) has no accrual config — manual allocation only | HIGH |
| LT-4 | leave_policies table completely unused — company policy overrides impossible | HIGH |
| LT-5 | Adoption Leave not seeded | MEDIUM |
| LT-6 | COMP leave type exists but comp-off flow credits "Compensatory Leave" by is_comp_off_type flag — potential mismatch if code is 'COMP' vs 'CL2' | MEDIUM |
| LT-7 | WFH is classified as a leave type but does not reduce balance (annual_quota unset) — attendance sync sets 'wfh' status | LOW |
| LT-8 | Plant Shutdown and Sabbatical have no annual_quota — unlimited by design but no validation | LOW |
